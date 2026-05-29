import type { Anthropic } from "@anthropic-ai/sdk"
import {
	type ModelInfo,
	type AntigravityModelId,
	antigravityDefaultModelId,
	antigravityModels,
	ApiProviderError,
} from "@roo-code/types"
import {
	FunctionCallingConfigMode,
	type GenerateContentConfig,
	type GenerateContentResponseUsageMetadata,
	type GroundingMetadata,
} from "@google/genai"
import { TelemetryService } from "@roo-code/telemetry"
import { t } from "i18next"

import type { ApiHandlerOptions } from "../../shared/api"
import { convertAnthropicMessageToGemini } from "../transform/gemini-format"
import type { ApiStream, GroundingSource } from "../transform/stream"
import { getModelParams } from "../transform/model-params"

import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { BaseProvider } from "./base-provider"
import { antigravityOAuthManager } from "../../integrations/antigravity/oauth"

// Antigravity uses the same Code Assist backend host as Gemini CLI but a different request envelope.
const ANTIGRAVITY_BASE_URL = "https://cloudcode-pa.googleapis.com"
const ANTIGRAVITY_API_VERSION = "v1internal"
const ANTIGRAVITY_USER_AGENT = "antigravity/1.21.9 darwin/arm64"

interface AntigravityHandlerOptions extends ApiHandlerOptions {
	antigravityOAuthPath?: string
	antigravityProjectId?: string
}

type AntigravityModel = ReturnType<AntigravityHandler["getModel"]>

interface GeminiContentPart {
	thought?: boolean
	text?: string
	thoughtSignature?: string
	functionCall?: { name: string; args: Record<string, unknown> }
}

interface GeminiCandidate {
	finishReason?: string
	groundingMetadata?: GroundingMetadata
	content?: { parts?: GeminiContentPart[] }
}

interface GeminiStreamChunk {
	responseId?: string
	candidates?: GeminiCandidate[]
	usageMetadata?: GenerateContentResponseUsageMetadata
	text?: string
	error?: { message?: string }
	message?: string
}

/**
 * Compute a deterministic session ID derived from the first user-turn text.
 * Produces "-" + decimal(first 8 bytes of SHA-256, big-endian, sign bit cleared).
 * Falls back to a random UUID if no user text is available.
 */
async function generateStableSessionId(
	contents: Array<{ role?: string; parts?: Array<{ text?: string }> }>,
): Promise<string> {
	for (const content of contents) {
		if (content?.role !== "user") continue
		const text = content.parts?.[0]?.text
		if (!text) continue

		const encoded = new TextEncoder().encode(text)
		const hashBuf = await crypto.subtle.digest("SHA-256", encoded)
		const view = new DataView(hashBuf)
		// Big-endian unsigned 64-bit, then strip the sign bit to match Go's int64 mask.
		const bigUint = view.getBigUint64(0, false)
		const masked = bigUint & 0x7fffffffffffffffn
		return "-" + masked.toString(10)
	}

	return crypto.randomUUID()
}

export class AntigravityHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: AntigravityHandlerOptions
	private lastThoughtSignature?: string
	private lastResponseId?: string
	private readonly providerName = "Antigravity"

	constructor(options: AntigravityHandlerOptions) {
		super()
		this.options = options
	}

	private getProjectId(): string {
		const projectId = this.options.antigravityProjectId?.trim()
		if (!projectId) {
			throw new Error(t("common:errors.antigravity.projectIdMissing"))
		}
		return projectId
	}

	private getOAuthPath(): string | undefined {
		return this.options.antigravityOAuthPath
	}

	private buildHeaders(token: string): Record<string, string> {
		return {
			"Content-Type": "application/json",
			Accept: "text/event-stream",
			Authorization: `Bearer ${token}`,
			"User-Agent": ANTIGRAVITY_USER_AGENT,
		}
	}

	private buildJsonHeaders(token: string): Record<string, string> {
		return {
			"Content-Type": "application/json",
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
			"User-Agent": ANTIGRAVITY_USER_AGENT,
		}
	}

	private buildInnerRequest(
		systemInstruction: string | undefined,
		messages: Anthropic.Messages.MessageParam[],
		metadata: ApiHandlerCreateMessageMetadata | undefined,
	): {
		request: Record<string, unknown>
		contents: Array<{ role?: string; parts?: Array<{ text?: string }> }>
		includeThoughtSignatures: boolean
	} {
		const { info, reasoning: thinkingConfig, maxTokens } = this.getModel()
		this.lastThoughtSignature = undefined
		this.lastResponseId = undefined

		const isHybridReasoningModel = info.supportsReasoningBudget || info.requiredReasoningBudget
		const maxOutputTokens = isHybridReasoningModel
			? (this.options.modelMaxTokens ?? maxTokens ?? undefined)
			: (maxTokens ?? undefined)

		const includeThoughtSignatures = Boolean(thinkingConfig) || Boolean(metadata?.tools?.length)

		// Filter out provider-specific reasoning meta entries that the Gemini converter cannot handle.
		type ReasoningMetaLike = { type?: string }
		const filteredMessages = messages.filter((message): message is Anthropic.Messages.MessageParam => {
			return (message as ReasoningMetaLike).type !== "reasoning"
		})

		// Tool-id → tool-name map for converting Anthropic tool_result blocks to Gemini functionResponse.
		const toolIdToName = new Map<string, string>()
		for (const message of messages) {
			if (Array.isArray(message.content)) {
				for (const block of message.content) {
					if (block.type === "tool_use") {
						toolIdToName.set(block.id, block.name)
					}
				}
			}
		}

		const contents = filteredMessages
			.map((message) => convertAnthropicMessageToGemini(message, { includeThoughtSignatures, toolIdToName }))
			.flat()

		const tools: GenerateContentConfig["tools"] = [
			{
				functionDeclarations: (metadata?.tools ?? []).map((tool) => ({
					name: (tool as any).function.name,
					description: (tool as any).function.description,
					parametersJsonSchema: (tool as any).function.parameters,
				})),
			},
		]

		const supportsTemperature = info.supportsTemperature !== false
		const temperatureConfig: number | undefined = supportsTemperature
			? (this.options.modelTemperature ?? info.defaultTemperature ?? 1)
			: info.defaultTemperature

		let toolConfig: GenerateContentConfig["toolConfig"] | undefined
		if (metadata?.allowedFunctionNames && metadata.allowedFunctionNames.length > 0) {
			toolConfig = {
				functionCallingConfig: {
					mode: FunctionCallingConfigMode.ANY,
					allowedFunctionNames: metadata.allowedFunctionNames,
				},
			}
		} else if (metadata?.tool_choice) {
			const choice = metadata.tool_choice
			let mode: FunctionCallingConfigMode
			let allowedFunctionNames: string[] | undefined

			if (choice === "auto") {
				mode = FunctionCallingConfigMode.AUTO
			} else if (choice === "none") {
				mode = FunctionCallingConfigMode.NONE
			} else if (choice === "required") {
				mode = FunctionCallingConfigMode.ANY
			} else if (typeof choice === "object" && "function" in choice && choice.type === "function") {
				mode = FunctionCallingConfigMode.ANY
				allowedFunctionNames = [choice.function.name]
			} else {
				mode = FunctionCallingConfigMode.AUTO
			}

			toolConfig = {
				functionCallingConfig: {
					mode,
					...(allowedFunctionNames ? { allowedFunctionNames } : {}),
				},
			}
		}

		const generationConfig: Record<string, unknown> = {}
		if (thinkingConfig) {
			const normalizedThinkingConfig: Record<string, unknown> = { ...thinkingConfig }
			if ("thinkingBudget" in normalizedThinkingConfig && "includeThoughts" in normalizedThinkingConfig) {
				normalizedThinkingConfig.include_thoughts = normalizedThinkingConfig.includeThoughts
				delete normalizedThinkingConfig.includeThoughts
			}
			generationConfig.thinkingConfig = normalizedThinkingConfig
		}
		if (typeof maxOutputTokens === "number") {
			generationConfig.maxOutputTokens = maxOutputTokens
		}
		if (typeof temperatureConfig === "number") {
			generationConfig.temperature = temperatureConfig
		}

		const request: Record<string, unknown> = {
			contents,
		}
		if (systemInstruction) {
			request.systemInstruction = { role: "system", parts: [{ text: systemInstruction }] }
		}
		if (tools.length > 0 && (tools[0] as any).functionDeclarations?.length > 0) {
			request.tools = tools
		}
		if (toolConfig) {
			request.toolConfig = toolConfig
		}
		if (Object.keys(generationConfig).length > 0) {
			request.generationConfig = generationConfig
		}

		// NOTE: safetySettings is intentionally NOT included — Antigravity rejects it.

		return { request, contents, includeThoughtSignatures }
	}

	/**
	 * Wrap a Gemini-style inner request in the Antigravity envelope.
	 */
	private buildEnvelope(
		modelId: string,
		projectId: string,
		sessionId: string,
		innerRequest: Record<string, unknown>,
	): Record<string, unknown> {
		const requestWithSession: Record<string, unknown> = { sessionId, ...innerRequest }
		return {
			model: modelId,
			userAgent: "antigravity",
			requestType: "agent",
			project: projectId,
			requestId: `agent-${crypto.randomUUID()}`,
			request: requestWithSession,
		}
	}

	private async *parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<GeminiStreamChunk> {
		const reader = body.getReader()
		const decoder = new TextDecoder("utf-8")
		let buffer = ""

		try {
			while (true) {
				const { value, done } = await reader.read()
				if (done) break
				buffer += decoder.decode(value, { stream: true })
				const lines = buffer.split("\n")
				buffer = lines.pop() || ""
				for (const line of lines) {
					const trimmed = line.trim()
					if (!trimmed || trimmed.startsWith(":")) continue
					if (!trimmed.startsWith("data:")) continue
					const payload = trimmed.slice(5).trim()
					if (!payload || payload === "[DONE]") continue
					try {
						const parsed = JSON.parse(payload) as GeminiStreamChunk
						yield parsed
					} catch (e) {
						console.error("Error parsing Antigravity SSE data:", e)
					}
				}
			}
		} finally {
			reader.releaseLock()
		}
	}

	private async *handleStreamResponse(
		body: ReadableStream<Uint8Array>,
		model: AntigravityModel,
		includeThoughtSignatures: boolean,
	): ApiStream {
		let lastUsageMetadata: GenerateContentResponseUsageMetadata | undefined
		let pendingGroundingMetadata: GroundingMetadata | undefined
		let finishReason: string | undefined
		let toolCallCounter = 0
		let hasContent = false
		let hasReasoning = false

		try {
			for await (const jsonData of this.parseSSEStream(body)) {
				// Antigravity wraps Gemini responses identically: `{ response: { ... } }` or top-level.
				const response =
					(jsonData as unknown as { response?: GeminiStreamChunk }).response ??
					(jsonData as GeminiStreamChunk)

				if (response?.responseId) {
					this.lastResponseId = response.responseId
				}

				if (response?.error || response?.message) {
					throw new Error(
						t("common:errors.antigravity.apiError", {
							error: response.error?.message || response.message || "Unknown error",
						}),
					)
				}

				const chunk = response

				if (chunk.candidates && chunk.candidates[0]?.finishReason) {
					finishReason = chunk.candidates[0].finishReason
				}

				if (chunk.candidates && chunk.candidates.length > 0) {
					const candidate = chunk.candidates[0]

					if (candidate.groundingMetadata) {
						pendingGroundingMetadata = candidate.groundingMetadata
					}

					if (candidate.content && candidate.content.parts) {
						for (const part of candidate.content.parts) {
							const thoughtSignature = part.thoughtSignature
							if (includeThoughtSignatures && thoughtSignature) {
								this.lastThoughtSignature = thoughtSignature
							}

							if (part.thought) {
								if (part.text) {
									hasReasoning = true
									yield { type: "reasoning", text: part.text }
								}
							} else if (part.functionCall) {
								hasContent = true
								const callId = `${part.functionCall.name}-${toolCallCounter}`
								const args = JSON.stringify(part.functionCall.args)
								yield {
									type: "tool_call_partial",
									index: toolCallCounter,
									id: callId,
									name: part.functionCall.name,
									arguments: undefined,
								}
								yield {
									type: "tool_call_partial",
									index: toolCallCounter,
									id: callId,
									name: undefined,
									arguments: args,
								}
								toolCallCounter++
							} else if (part.text) {
								hasContent = true
								yield { type: "text", text: part.text }
							}
						}
					}
				} else if (chunk.text) {
					hasContent = true
					yield { type: "text", text: chunk.text }
				}

				if (chunk.usageMetadata) {
					lastUsageMetadata = chunk.usageMetadata
				}
			}

			// Surface non-STOP finish reasons (SAFETY/RECITATION/MAX_TOKENS) so Task retry logic
			// gets a meaningful error rather than a silent empty response.
			if (!hasContent && finishReason && finishReason !== "STOP") {
				throw new Error(
					t("common:errors.antigravity.apiError", {
						error: `response blocked or incomplete (finishReason: ${finishReason})`,
					}),
				)
			}

			if (pendingGroundingMetadata) {
				const sources = this.extractGroundingSources(pendingGroundingMetadata)
				if (sources.length > 0) {
					yield { type: "grounding", sources }
				}
			}

			if (lastUsageMetadata) {
				yield {
					type: "usage",
					inputTokens: lastUsageMetadata.promptTokenCount ?? 0,
					outputTokens: lastUsageMetadata.candidatesTokenCount ?? 0,
					cacheReadTokens: lastUsageMetadata.cachedContentTokenCount,
					reasoningTokens: lastUsageMetadata.thoughtsTokenCount,
					totalCost: 0,
				}
			}

			// STOP + no content + usage-only: synthetic reasoning chunk lets Task.ts retry instead
			// of escalating to no-assistant-message.
			if (!hasContent && !hasReasoning && finishReason === "STOP" && lastUsageMetadata) {
				yield {
					type: "reasoning",
					text: "Model returned usage metadata but no actionable output. Retrying.",
				}
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(errorMessage, this.providerName, model.id, "createMessage")
			TelemetryService.instance.captureException(apiError)
			throw error instanceof Error
				? new Error(t("common:errors.antigravity.completionError", { error: error.message }))
				: error
		}

		if (!hasContent) {
			yield { type: "text", text: "" }
		}
	}

	/**
	 * Translate an HTTP error response into a user-actionable typed error using planned i18n keys.
	 * Returns the thrown error so the caller can choose to bubble it or attempt a retry first.
	 */
	private async classifyHttpError(response: Response): Promise<Error> {
		let bodyText = ""
		try {
			bodyText = await response.text()
		} catch {
			// ignore — bodyText stays empty
		}

		const status = response.status
		const summary = bodyText ? `HTTP ${status}: ${bodyText}` : `HTTP ${status}`

		if (status === 401 || status === 403) {
			return new Error(t("common:errors.antigravity.oauthLoadFailed", { error: summary }))
		}
		if (status === 429) {
			return new Error(t("common:errors.antigravity.rateLimitExceeded"))
		}
		if (status === 400) {
			return new Error(t("common:errors.antigravity.badRequest", { details: bodyText || summary }))
		}
		return new Error(t("common:errors.antigravity.apiError", { error: summary }))
	}

	async *createMessage(
		systemInstruction: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { id: modelId } = this.getModel()
		const projectId = this.getProjectId()

		const {
			request: innerRequest,
			contents,
			includeThoughtSignatures,
		} = this.buildInnerRequest(systemInstruction, messages, metadata)
		const sessionId = await generateStableSessionId(contents)
		const envelope = this.buildEnvelope(modelId, projectId, sessionId, innerRequest)

		const url = `${ANTIGRAVITY_BASE_URL}/${ANTIGRAVITY_API_VERSION}:streamGenerateContent?alt=sse`

		const sendRequest = async (token: string): Promise<Response> => {
			return fetch(url, {
				method: "POST",
				headers: this.buildHeaders(token),
				body: JSON.stringify(envelope),
			})
		}

		try {
			let credentials = await antigravityOAuthManager.ensureAuthenticated({ path: this.getOAuthPath() })
			let response = await sendRequest(credentials.access_token)

			// Single 401 retry: the local token may have been server-revoked despite passing local
			// expiry checks. Force a refresh and reissue once. No looping, no silent fallback.
			if (response.status === 401) {
				try {
					credentials = await antigravityOAuthManager.forceRefresh({ path: this.getOAuthPath() })
				} catch (refreshError) {
					const msg = refreshError instanceof Error ? refreshError.message : String(refreshError)
					throw new Error(t("common:errors.antigravity.tokenRefreshFailed", { error: msg }))
				}
				response = await sendRequest(credentials.access_token)
			}

			if (!response.ok || !response.body) {
				throw await this.classifyHttpError(response)
			}

			yield* this.handleStreamResponse(response.body, this.getModel(), includeThoughtSignatures)
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(errorMessage, this.providerName, modelId, "createMessage")
			TelemetryService.instance.captureException(apiError)
			throw error
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		const { id: modelId, info } = this.getModel()
		const projectId = this.getProjectId()

		const supportsTemperature = info.supportsTemperature !== false
		const temperatureConfig: number | undefined = supportsTemperature
			? (this.options.modelTemperature ?? info.defaultTemperature ?? 1)
			: info.defaultTemperature

		const contents = [{ role: "user", parts: [{ text: prompt }] }]
		const innerRequest: Record<string, unknown> = { contents }
		if (typeof temperatureConfig === "number") {
			innerRequest.generationConfig = { temperature: temperatureConfig }
		}

		const sessionId = await generateStableSessionId(contents)
		const envelope = this.buildEnvelope(modelId, projectId, sessionId, innerRequest)

		const url = `${ANTIGRAVITY_BASE_URL}/${ANTIGRAVITY_API_VERSION}:generateContent`

		const sendRequest = async (token: string): Promise<Response> => {
			return fetch(url, {
				method: "POST",
				headers: this.buildJsonHeaders(token),
				body: JSON.stringify(envelope),
			})
		}

		try {
			let credentials = await antigravityOAuthManager.ensureAuthenticated({ path: this.getOAuthPath() })
			let response = await sendRequest(credentials.access_token)

			if (response.status === 401) {
				try {
					credentials = await antigravityOAuthManager.forceRefresh({ path: this.getOAuthPath() })
				} catch (refreshError) {
					const msg = refreshError instanceof Error ? refreshError.message : String(refreshError)
					throw new Error(t("common:errors.antigravity.tokenRefreshFailed", { error: msg }))
				}
				response = await sendRequest(credentials.access_token)
			}

			if (!response.ok) {
				throw await this.classifyHttpError(response)
			}

			const responseData = (await response.json()) as {
				response?: GeminiStreamChunk
				text?: string
				candidates?: GeminiCandidate[]
			}

			const payload = responseData.response ?? responseData
			if ((payload as GeminiStreamChunk).candidates && (payload as GeminiStreamChunk).candidates!.length > 0) {
				const candidate = (payload as GeminiStreamChunk).candidates![0]
				if (candidate.content?.parts) {
					return candidate.content.parts
						.filter((part) => part.text && !part.thought)
						.map((part) => part.text!)
						.join("")
				}
			}
			return (payload as { text?: string }).text ?? ""
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(errorMessage, this.providerName, modelId, "completePrompt")
			TelemetryService.instance.captureException(apiError)
			if (error instanceof Error) {
				throw new Error(t("common:errors.antigravity.completionError", { error: error.message }))
			}
			throw error
		}
	}

	override async countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number> {
		// OAuth/free tier — fall back to BaseProvider's tiktoken estimate rather than calling the
		// hosted countTokens endpoint.
		return super.countTokens(content)
	}

	override getModel() {
		const modelId = this.options.apiModelId
		let id: string
		let info: ModelInfo

		if (modelId && Object.hasOwn(antigravityModels, modelId)) {
			// Known Antigravity model id: resolve to the full ModelInfo from the dedicated
			// registry. `Object.hasOwn` (rather than `in`) prevents inherited Object.prototype
			// keys like "toString" from being treated as registry entries.
			id = modelId
			info = antigravityModels[modelId as AntigravityModelId]
		} else if (modelId && modelId.trim().length > 0) {
			// Honor a custom/unlisted model id verbatim. Unlike Gemini (which guards on a
			// `gemini-` prefix), the Antigravity catalog spans gemini-*, claude-*, and gpt-*
			// families, and the served catalog evolves faster than this registry. Any
			// non-empty user-supplied id must reach the request envelope unchanged so the
			// settings UI's "use custom model" option and the configured id agree with the
			// actual request. Only empty/undefined ids fall back to the default.
			id = modelId
			// Use the default model's structural info as a baseline, but drop the cost-bearing
			// fields we can't verify for an unknown model so cost reporting shows "unknown"
			// (calculateCost returns undefined) rather than charging the default model's rates
			// against a different model. Mirrors the Gemini fix's cost-unknown behavior.
			info = {
				...antigravityModels[antigravityDefaultModelId],
				inputPrice: undefined,
				outputPrice: undefined,
				cacheReadsPrice: undefined,
				cacheWritesPrice: undefined,
				tiers: undefined,
			}
		} else {
			// Empty/undefined model id: fall back to the registered default.
			id = antigravityDefaultModelId
			info = antigravityModels[antigravityDefaultModelId]
		}

		const params = getModelParams({
			format: "gemini",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: info.defaultTemperature ?? 1,
		})

		if (id.endsWith(":thinking")) {
			id = id.replace(":thinking", "")
		}

		return { id, info, ...params }
	}

	private extractGroundingSources(groundingMetadata?: GroundingMetadata): GroundingSource[] {
		const chunks = groundingMetadata?.groundingChunks
		if (!chunks) return []

		return chunks
			.map((chunk): GroundingSource | null => {
				const uri = chunk.web?.uri
				const title = chunk.web?.title || uri || "Unknown Source"
				return uri ? { title, url: uri } : null
			})
			.filter((source): source is GroundingSource => source !== null)
	}

	public getThoughtSignature(): string | undefined {
		return this.lastThoughtSignature
	}

	public getResponseId(): string | undefined {
		return this.lastResponseId
	}
}
