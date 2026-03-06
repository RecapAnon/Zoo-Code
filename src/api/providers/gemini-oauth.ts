import { Anthropic } from "@anthropic-ai/sdk"
import {
	FunctionCallingConfigMode,
	type GenerateContentConfig,
	type GenerateContentParameters,
	type GenerateContentResponseUsageMetadata,
	type GroundingMetadata,
} from "@google/genai"
import { v7 as uuidv7 } from "uuid"
import {
	type ModelInfo,
	type GeminiOAuthModelId,
	geminiOauthDefaultModelId,
	geminiOauthModels,
	ApiProviderError,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import { t } from "i18next"
import type { ApiHandlerOptions } from "../../shared/api"
import { getModelParams } from "../transform/model-params"
import { convertAnthropicMessageToGemini } from "../transform/gemini-format"
import type { ApiStream, GroundingSource } from "../transform/stream"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { BaseProvider } from "./base-provider"
import { geminiOAuthManager } from "../../integrations/gemini-oauth/oauth"

const CODE_ASSIST_BASE_URL = "https://cloudcode-pa.googleapis.com"
const CODE_ASSIST_VERSION = "v1internal"

interface GeminiOAuthHandlerOptions extends ApiHandlerOptions {
	geminiOauthPath?: string
	geminiOauthProjectId?: string
}

type GeminiOAuthModel = ReturnType<GeminiOAuthHandler["getModel"]>

export class GeminiOAuthHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: GeminiOAuthHandlerOptions
	private lastThoughtSignature?: string
	private lastResponseId?: string
	private readonly sessionId: string
	private readonly providerName = "Gemini"

	constructor(options: GeminiOAuthHandlerOptions) {
		super()
		this.options = options
		this.sessionId = uuidv7() // Initialize OAuth2 client
	}

	private getAuthHeaders(streaming: boolean, taskId?: string): Record<string, string> {
		return {
			"Content-Type": "application/json",
			Accept: streaming ? "text/event-stream" : "application/json",
			session_id: taskId || this.sessionId,
		}
	}

	private getProjectId(): string {
		const projectId = this.options.geminiOauthProjectId
		if (!projectId) {
			throw new Error(
				t("common:errors.geminiOauth.missingProjectId"),
			)
		}
		return projectId
	}

	private buildRequestPayload(
		systemInstruction: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata: ApiHandlerCreateMessageMetadata | undefined,
	) {
		const { id: model, info, reasoning: thinkingConfig, maxTokens } = this.getModel()
		// Reset per-request metadata that we persist into apiConversationHistory.
		this.lastThoughtSignature = undefined
		this.lastResponseId = undefined

		// For hybrid/budget reasoning models (e.g. Gemini 2.5 Pro), respect user-configured
		// modelMaxTokens so the ThinkingBudget slider can control the cap. For effort-only or
		// standard models (like gemini-3-pro-preview), ignore any stale modelMaxTokens and
		// default to the model's computed maxTokens from getModelMaxOutputTokens.
		const isHybridReasoningModel = info.supportsReasoningBudget || info.requiredReasoningBudget
		const maxOutputTokens = isHybridReasoningModel
			? (this.options.modelMaxTokens ?? maxTokens ?? undefined)
			: (maxTokens ?? undefined)

		// Gemini 3 validates thought signatures for tool/function calling steps.
		// We must round-trip the signature when tools are in use, even if the user chose
		// a minimal thinking level (or thinkingConfig is otherwise absent).
		const includeThoughtSignatures = Boolean(thinkingConfig) || Boolean(metadata?.tools?.length)

		// The message list can include provider-specific meta entries such as
		// `{ type: "reasoning", ... }` that are intended only for providers like
		// openai-native. Gemini should never see those; they are not valid
		// Anthropic.MessageParam values and will cause failures (e.g. missing
		// `content` for the converter). Filter them out here.
		type ReasoningMetaLike = { type?: string }

		const geminiMessages = messages.filter((message): message is Anthropic.Messages.MessageParam => {
			const meta = message as ReasoningMetaLike
			if (meta.type === "reasoning") {
				return false
			}
			return true
		})

		// Build a map of tool IDs to names from previous messages
		// This is needed because Anthropic's tool_result blocks only contain the ID,
		// but Gemini requires the name in functionResponse
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

		const contents = geminiMessages
			.map((message) => convertAnthropicMessageToGemini(message, { includeThoughtSignatures, toolIdToName }))
			.flat()

		// Tools are always present (minimum ALWAYS_AVAILABLE_TOOLS).
		// Google built-in tools (Grounding, URL Context) are mutually exclusive
		// with function declarations in the Gemini API, so we always use
		// function declarations when tools are provided.
		const tools: GenerateContentConfig["tools"] = [
			{
				functionDeclarations: (metadata?.tools ?? []).map((tool) => ({
					name: (tool as any).function.name,
					description: (tool as any).function.description,
					parametersJsonSchema: (tool as any).function.parameters,
				})),
			},
		]

		// Determine temperature respecting model capabilities and defaults:
		// - If supportsTemperature is explicitly false, ignore user overrides
		//   and pin to the model's defaultTemperature (or omit if undefined).
		// - Otherwise, allow the user setting to override, falling back to model default,
		//   then to 1 for Gemini provider default.
		const supportsTemperature = info.supportsTemperature !== false
		const temperatureConfig: number | undefined = supportsTemperature
			? (this.options.modelTemperature ?? info.defaultTemperature ?? 1)
			: info.defaultTemperature

		const config: GenerateContentConfig = {
			systemInstruction,
			httpOptions: this.options.googleGeminiBaseUrl ? { baseUrl: this.options.googleGeminiBaseUrl } : undefined,
			thinkingConfig,
			maxOutputTokens,
			temperature: temperatureConfig,
			...(tools.length > 0 ? { tools } : {}),
		}

		// Handle allowedFunctionNames for mode-restricted tool access.
		// When provided, all tool definitions are passed to the model (so it can reference
		// historical tool calls in conversation), but only the specified tools can be invoked.
		// This takes precedence over tool_choice to ensure mode restrictions are honored.
		if (metadata?.allowedFunctionNames && metadata.allowedFunctionNames.length > 0) {
			config.toolConfig = {
				functionCallingConfig: {
					// Use ANY mode to allow calling any of the allowed functions
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
				// "required" means the model must call at least one tool; Gemini uses ANY for this.
				mode = FunctionCallingConfigMode.ANY
			} else if (typeof choice === "object" && "function" in choice && choice.type === "function") {
				mode = FunctionCallingConfigMode.ANY
				allowedFunctionNames = [choice.function.name]
			} else {
				// Fall back to AUTO for unknown values to avoid unintentionally broadening tool access.
				mode = FunctionCallingConfigMode.AUTO
			}

			config.toolConfig = {
				functionCallingConfig: {
					mode,
					...(allowedFunctionNames ? { allowedFunctionNames } : {}),
				},
			}
		}

		const params: GenerateContentParameters = { model, contents, config }

		const generationConfig: Record<string, unknown> = {}
		if (thinkingConfig) {
			const normalizedThinkingConfig: Record<string, unknown> = { ...thinkingConfig }
			if ("thinkingBudget" in normalizedThinkingConfig) {
				if ("includeThoughts" in normalizedThinkingConfig) {
					normalizedThinkingConfig.include_thoughts = normalizedThinkingConfig.includeThoughts
					delete normalizedThinkingConfig.includeThoughts
				}
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
		if (tools.length > 0) {
			request.tools = tools
		}
		if (config.toolConfig) {
			request.toolConfig = config.toolConfig
		}
		if (Object.keys(generationConfig).length > 0) {
			request.generationConfig = generationConfig
		}

		return { request, ...params }
	}

	/**
	 * Parse Server-Sent Events from a stream
	 */
	private async *parseSSEStream(stream: NodeJS.ReadableStream): AsyncGenerator<any> {
		let buffer = ""

		for await (const chunk of stream) {
			const chunkText =
				typeof chunk === "string"
					? chunk
					: Buffer.isBuffer(chunk)
						? chunk.toString("utf-8")
						: Buffer.from(chunk as Uint8Array).toString("utf-8")
			buffer += chunkText
			const lines = buffer.split("\n")
			buffer = lines.pop() || ""
			for (const line of lines) {
				const trimmed = line.trim()
				if (!trimmed || trimmed.startsWith(":")) {
					continue
				}
				if (!trimmed.startsWith("data:")) {
					continue
				}
				const payload = trimmed.slice(5).trim()
				if (!payload || payload === "[DONE]") {
					continue
				}

				try {
					const parsed = JSON.parse(payload)
					yield parsed
				} catch (e) {
					console.error("Error parsing SSE data:", e)
				}
			}
		}
	}

	private async *handleStreamResponse(
		body: NodeJS.ReadableStream,
		model: GeminiOAuthModel,
		includeThoughtSignatures: boolean,
	): ApiStream {
		let lastUsageMetadata: GenerateContentResponseUsageMetadata | undefined
		let pendingGroundingMetadata: GroundingMetadata | undefined
		let finalResponse: { responseId?: string } | undefined
		let finishReason: string | undefined

		let toolCallCounter = 0
		let hasContent = false
		let hasReasoning = false

		try {
			for await (const jsonData of this.parseSSEStream(body)) {
				// Extract content from the response
				const response = jsonData.response || jsonData
				if (response?.responseId) {
					this.lastResponseId = response.responseId
				}

				if (response?.error || response?.message) {
					throw new Error(
						t("common:errors.geminiOauth.apiError", {
							message: response.error?.message || response.message || "Unknown error",
						}),
					)
				}

				const chunk = response

				// Track the final structured response (per SDK pattern: candidate.finishReason)
				if (chunk.candidates && chunk.candidates[0]?.finishReason) {
					finalResponse = chunk as { responseId?: string }
					finishReason = chunk.candidates[0].finishReason
				}
				// Process candidates and their parts to separate thoughts from content
				if (chunk.candidates && chunk.candidates.length > 0) {
					const candidate = chunk.candidates[0]

					if (candidate.groundingMetadata) {
						pendingGroundingMetadata = candidate.groundingMetadata
					}

					if (candidate.content && candidate.content.parts) {
						for (const part of candidate.content.parts as Array<{
							thought?: boolean
							text?: string
							thoughtSignature?: string
							functionCall?: { name: string; args: Record<string, unknown> }
						}>) {
							// Capture thought signatures so they can be persisted into API history.
							const thoughtSignature = part.thoughtSignature
							// Persist thought signatures so they can be round-tripped in the next step.
							// Gemini 3 requires this during tool calling; other Gemini thinking models
							// benefit from it for continuity.
							if (includeThoughtSignatures && thoughtSignature) {
								this.lastThoughtSignature = thoughtSignature
							}

							if (part.thought) {
								// This is a thinking/reasoning part
								if (part.text) {
									hasReasoning = true
									yield { type: "reasoning", text: part.text }
								}
							} else if (part.functionCall) {
								hasContent = true
								// Gemini sends complete function calls in a single chunk
								// Emit as partial chunks for consistent handling with NativeToolCallParser
								const callId = `${part.functionCall.name}-${toolCallCounter}`
								const args = JSON.stringify(part.functionCall.args)

								// Emit name first
								yield {
									type: "tool_call_partial",
									index: toolCallCounter,
									id: callId,
									name: part.functionCall.name,
									arguments: undefined,
								}

								// Then emit arguments
								yield {
									type: "tool_call_partial",
									index: toolCallCounter,
									id: callId,
									name: undefined,
									arguments: args,
								}

								toolCallCounter++
							} else {
								// This is regular content
								if (part.text) {
									hasContent = true
									yield { type: "text", text: part.text }
								}
							}
						}
					}
				}

				// Fallback to the original text property if no candidates structure
				else if (chunk.text) {
					hasContent = true
					yield { type: "text", text: chunk.text }
				}

				if (chunk.usageMetadata) {
					lastUsageMetadata = chunk.usageMetadata
				}
			}

			if (finalResponse?.responseId) {
				// Capture responseId so Task.addToApiConversationHistory can store it
				// alongside the assistant message in api_history.json.
				this.lastResponseId = finalResponse.responseId
			}

			// Surface non-STOP finish reasons when the model produced no actionable content.
			// This covers cases like SAFETY, RECITATION, MAX_TOKENS where the API
			// silently returns nothing. Throwing here gives Task.ts retry logic a
			// meaningful error message instead of the generic "no assistant messages".
			if (!hasContent && finishReason && finishReason !== "STOP") {
				throw new Error(
					`Gemini response blocked or incomplete (finishReason: ${finishReason}). No content was returned.`,
				)
			}

			if (pendingGroundingMetadata) {
				const sources = this.extractGroundingSources(pendingGroundingMetadata)
				if (sources.length > 0) {
					yield { type: "grounding", sources }
				}
			}

			if (lastUsageMetadata) {
				const inputTokens = lastUsageMetadata.promptTokenCount ?? 0
				const outputTokens = lastUsageMetadata.candidatesTokenCount ?? 0
				const cacheReadTokens = lastUsageMetadata.cachedContentTokenCount
				const reasoningTokens = lastUsageMetadata.thoughtsTokenCount

				yield {
					type: "usage",
					inputTokens,
					outputTokens,
					cacheReadTokens,
					reasoningTokens,
					totalCost: 0,
				}
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(errorMessage, this.providerName, model.id, "createMessage")
			TelemetryService.instance.captureException(apiError)

			if (error instanceof Error) {
				throw new Error(t("common:errors.gemini.generate_stream", { error: error.message }))
			}

			throw error
		}
	}

	async *createMessage(
		systemInstruction: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		await geminiOAuthManager.ensureAuthenticated({ path: this.options.geminiOauthPath })
		const projectId = this.getProjectId()
		const authClient = geminiOAuthManager.getAuthClient()

		const { model, config, request } = this.buildRequestPayload(systemInstruction, messages, metadata)
		const includeThoughtSignatures = Boolean(config?.thinkingConfig)
		const requestBody = {
			project: projectId,
			model: model,
			request,
		}

		try {
			const response = await authClient.request({
				url: `${CODE_ASSIST_BASE_URL}/${CODE_ASSIST_VERSION}:streamGenerateContent`,
				method: "POST",
				params: { alt: "sse" },
				headers: this.getAuthHeaders(true, metadata?.taskId),
				responseType: "stream",
				data: JSON.stringify(requestBody),
			})

			yield* this.handleStreamResponse(
				response.data as NodeJS.ReadableStream,
				this.getModel(),
				includeThoughtSignatures,
			)
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(errorMessage, this.providerName, model, "createMessage")
			TelemetryService.instance.captureException(apiError)

			if (error instanceof Error) {
				throw new Error(t("common:errors.gemini.generate_stream", { error: error.message }))
			}

			throw error
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		await geminiOAuthManager.ensureAuthenticated({ path: this.options.geminiOauthPath })
		const projectId = this.getProjectId()
		const authClient = geminiOAuthManager.getAuthClient()

		const { id: model, info } = this.getModel()
		const supportsTemperature = info.supportsTemperature !== false
		const temperatureConfig: number | undefined = supportsTemperature
			? (this.options.modelTemperature ?? info.defaultTemperature ?? 1)
			: info.defaultTemperature

		const promptConfig: GenerateContentConfig = {
			httpOptions: this.options.googleGeminiBaseUrl ? { baseUrl: this.options.googleGeminiBaseUrl } : undefined,
			temperature: temperatureConfig,
		}

		const request = {
			model,
			contents: [{ role: "user", parts: [{ text: prompt }] }],
			config: promptConfig,
		}

		const requestBody = {
			project: projectId,
			model: model,
			request,
		}

		try {
			const response = await authClient.request({
				url: `${CODE_ASSIST_BASE_URL}/${CODE_ASSIST_VERSION}:generateContent`,
				method: "POST",
				headers: this.getAuthHeaders(false),
				data: JSON.stringify(requestBody),
			})

			// Extract text from response
			const responseBody = response.data as any
			let text = responseBody?.text ?? ""

			// Extract text from response
			if (responseBody.candidates && responseBody.candidates.length > 0) {
				const candidate = responseBody.candidates[0]
				if (candidate.content && candidate.content.parts) {
					const textParts = candidate.content.parts
						.filter((part: any) => part.text && !part.thought)
						.map((part: any) => part.text)
						.join("")
					return textParts
				}
			}

			return text
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(errorMessage, this.providerName, model, "completePrompt")
			TelemetryService.instance.captureException(apiError)

			if (error instanceof Error) {
				throw new Error(t("common:errors.gemini.generate_complete_prompt", { error: error.message }))
			}

			throw error
		}
	}

	override async countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number> {
		// For OAuth/free tier, we can't use the token counting API
		// Fall back to the base provider's tiktoken implementation
		return super.countTokens(content)
	}

	override getModel() {
		const modelId = this.options.apiModelId
		let id = modelId && modelId in geminiOauthModels ? (modelId as GeminiOAuthModelId) : geminiOauthDefaultModelId
		const info: ModelInfo = geminiOauthModels[id]
		const params = getModelParams({
			format: "gemini",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: info.defaultTemperature ?? 1,
		})

		if (id.endsWith(":thinking")) {
			id = id.replace(":thinking", "") as GeminiOAuthModelId
		}

		return { id, info, ...params }
	}

	private extractGroundingSources(groundingMetadata?: GroundingMetadata): GroundingSource[] {
		const chunks = groundingMetadata?.groundingChunks

		if (!chunks) {
			return []
		}

		return chunks
			.map((chunk): GroundingSource | null => {
				const uri = chunk.web?.uri
				const title = chunk.web?.title || uri || "Unknown Source"

				if (uri) {
					return {
						title,
						url: uri,
					}
				}
				return null
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
