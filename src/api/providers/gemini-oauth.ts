import { Anthropic } from "@anthropic-ai/sdk"
import { type GenerateContentResponseUsageMetadata, type GroundingMetadata } from "@google/genai"
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
import type { ApiStream, ApiStreamUsageChunk, GroundingSource } from "../transform/stream"

import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { BaseProvider } from "./base-provider"
import { geminiOAuthManager } from "../../integrations/gemini-oauth/oauth"
import { isMcpTool } from "../../utils/mcp-name"

const CODE_ASSIST_BASE_URL = "https://cloudcode-pa.googleapis.com"
const CODE_ASSIST_VERSION = "v1internal"

const GEMINI_CLI_USER_AGENT = "google-api-nodejs-client/9.15.1"
const GEMINI_CLI_API_CLIENT = "gl-node/22.17.0"
const GEMINI_CLI_CLIENT_METADATA = "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI"

interface GeminiOAuthHandlerOptions extends ApiHandlerOptions {
	geminiOauthPath?: string
	geminiOauthProjectId?: string
}

type FunctionCallingConfigMode = "AUTO" | "NONE" | "ANY"


type GeminiOAuthModel = ReturnType<GeminiOAuthHandler["getModel"]>

function ensureAllRequired(schema: any): any {
	if (!schema || typeof schema !== "object" || schema.type !== "object") {
		return schema
	}

	const result = { ...schema }
	if (result.additionalProperties !== false) {
		result.additionalProperties = false
	}

	if (result.properties) {
		const allKeys = Object.keys(result.properties)
		result.required = allKeys

		const newProps = { ...result.properties }
		for (const key of allKeys) {
			const prop = newProps[key]
			if (prop?.type === "object") {
				newProps[key] = ensureAllRequired(prop)
			} else if (prop?.type === "array" && prop.items?.type === "object") {
				newProps[key] = {
					...prop,
					items: ensureAllRequired(prop.items),
				}
			}
		}
		result.properties = newProps
	}

	return result
}

function ensureAdditionalPropertiesFalse(schema: any): any {
	if (!schema || typeof schema !== "object" || schema.type !== "object") {
		return schema
	}

	const result = { ...schema }
	if (result.additionalProperties !== false) {
		result.additionalProperties = false
	}

	if (result.properties) {
		const newProps = { ...result.properties }
		for (const key of Object.keys(result.properties)) {
			const prop = newProps[key]
			if (prop?.type === "object") {
				newProps[key] = ensureAdditionalPropertiesFalse(prop)
			} else if (prop?.type === "array" && prop.items?.type === "object") {
				newProps[key] = {
					...prop,
					items: ensureAdditionalPropertiesFalse(prop.items),
				}
			}
		}
		result.properties = newProps
	}

	return result
}

export class GeminiOAuthHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: GeminiOAuthHandlerOptions
	private lastThoughtSignature?: string
	private lastResponseId?: string
	private readonly sessionId: string
	private abortController?: AbortController
	private readonly providerName = "Gemini"

	constructor(options: GeminiOAuthHandlerOptions) {
		super()
		this.options = options
		this.sessionId = uuidv7()
	}

	private async ensureAuthenticated(): Promise<void> {
		const accessToken = await geminiOAuthManager.getAccessToken({ path: this.options.geminiOauthPath })
		if (!accessToken) {
			throw new Error(
				t("common:errors.geminiOauth.notAuthenticated", {
					defaultValue:
						"Not authenticated with Gemini OAuth. Please sign in using the Gemini OAuth flow.",
				}),
			)
		}
	}

	private async getProjectId(): Promise<string> {
		const projectId = await geminiOAuthManager.getProjectId({
			path: this.options.geminiOauthPath,
			projectIdOverride: this.options.geminiOauthProjectId,
		})
		if (!projectId) {
			throw new Error(
				t("common:errors.geminiOauth.missingProjectId", {
					defaultValue: "Gemini OAuth credentials missing project_id; set geminiOauthProjectId.",
				}),
			)
		}
		return projectId
	}

	private getAuthHeaders(streaming: boolean, accessToken: string, taskId?: string): Record<string, string> {
		return {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			Accept: streaming ? "text/event-stream" : "application/json",
			"User-Agent": GEMINI_CLI_USER_AGENT,
			"X-Goog-Api-Client": GEMINI_CLI_API_CLIENT,
			"Client-Metadata": GEMINI_CLI_CLIENT_METADATA,
			originator: "roo-code",
			session_id: taskId || this.sessionId,
		}
	}

	private normalizeUsage(usage: any): ApiStreamUsageChunk | undefined {
		if (!usage) return undefined

		const inputTokens = usage.promptTokenCount ?? usage.prompt_tokens ?? 0
		const outputTokens = usage.candidatesTokenCount ?? usage.completion_tokens ?? 0
		const cacheReadTokens = usage.cachedContentTokenCount
		const reasoningTokens = usage.thoughtsTokenCount

		const out: ApiStreamUsageChunk = {
			type: "usage",
			inputTokens,
			outputTokens,
			...(typeof cacheReadTokens === "number" ? { cacheReadTokens } : {}),
			...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
			totalCost: 0,
		}
		return out
	}

	private buildRequestPayload(
		systemInstruction: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata: ApiHandlerCreateMessageMetadata | undefined,
	) {
		const { id: modelId, info, reasoning: thinkingConfig, maxTokens } = this.getModel()

		this.lastThoughtSignature = undefined
		this.lastResponseId = undefined

		const isHybridReasoningModel = info.supportsReasoningBudget || info.requiredReasoningBudget
		const maxOutputTokens = isHybridReasoningModel
			? (this.options.modelMaxTokens ?? maxTokens ?? undefined)
			: (maxTokens ?? undefined)

		const includeThoughtSignatures = Boolean(thinkingConfig) || Boolean(metadata?.tools?.length)

		type ReasoningMetaLike = { type?: string }
		const geminiMessages = messages.filter((message: ReasoningMetaLike & { role?: string }) => {
			if ((message as ReasoningMetaLike).type === "reasoning") {
				return false
			}
			return true
		})

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

		const validToolNames = new Set(
			metadata?.tools?.filter((tool) => tool.type === "function").map((tool) => tool.function.name) ?? [],
		)

		for (const message of messages) {
			if (!Array.isArray(message.content)) {
				continue
			}
			for (const block of message.content) {
				if (block.type !== "tool_result") {
					continue
				}
				if (toolIdToName.has(block.tool_use_id)) {
					continue
				}
				const match = /^(.*)-\d+$/.exec(block.tool_use_id)
				if (!match) {
					continue
				}
				const candidateName = match[1]
				if (validToolNames.size === 0 || validToolNames.has(candidateName)) {
					toolIdToName.set(block.tool_use_id, candidateName)
				}
			}
		}

		const contents = geminiMessages
			.map((message) => convertAnthropicMessageToGemini(message, { includeThoughtSignatures, toolIdToName }))
			.flat()

		const tools: Array<{ functionDeclarations?: any[]; googleSearch?: Record<string, unknown>; urlContext?: any }> = []
		const toolProtocol = (metadata as { toolProtocol?: string } | undefined)?.toolProtocol
		const allowTools = toolProtocol !== "xml"
		const hasDeclaredTools = allowTools && metadata?.tools && metadata.tools.length > 0
		if (hasDeclaredTools) {
			tools.push({
				functionDeclarations: metadata!.tools!
					.filter((tool) => tool.type === "function")
					.map((tool) => {
						const isMcp = isMcpTool(tool.function.name)
						return {
							name: tool.function.name,
							description: tool.function.description,
							parametersJsonSchema: isMcp
								? ensureAdditionalPropertiesFalse(tool.function.parameters)
								: ensureAllRequired(tool.function.parameters),
						}
					}),
			})
		} else {
			if (this.options.enableUrlContext) {
				tools.push({ urlContext: {} })
			}

			if (this.options.enableGrounding) {
				tools.push({ googleSearch: {} })
			}
		}

		const supportsTemperature = info.supportsTemperature !== false
		const temperatureConfig: number | undefined = supportsTemperature
			? (this.options.modelTemperature ?? info.defaultTemperature ?? 1)
			: info.defaultTemperature

		let toolConfig:
			| { functionCallingConfig: { mode: FunctionCallingConfigMode; allowedFunctionNames?: string[] } }
			| undefined
		if (metadata?.allowedFunctionNames && metadata.allowedFunctionNames.length > 0) {
			toolConfig = {
				functionCallingConfig: {
					mode: "ANY",
					allowedFunctionNames: metadata.allowedFunctionNames,
				},
			}
		} else if (metadata?.tool_choice) {
			const choice = metadata.tool_choice
			let mode: FunctionCallingConfigMode
			let allowedFunctionNames: string[] | undefined
			if (choice === "auto") {
				mode = "AUTO"
			} else if (choice === "none") {
				mode = "NONE"
			} else if (choice === "required") {
				mode = "ANY"
			} else if (typeof choice === "object" && "function" in choice && choice.type === "function") {
				mode = "ANY"
				allowedFunctionNames = [choice.function.name]
			} else {
				mode = "AUTO"
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
		if (toolConfig) {
			request.toolConfig = toolConfig
		}
		if (Object.keys(generationConfig).length > 0) {
			request.generationConfig = generationConfig
		}

		return { modelId, info, request }
	}

	private async *handleStreamResponse(
		body: ReadableStream<Uint8Array>,
		model: GeminiOAuthModel,
		includeThoughtSignatures: boolean,
	): ApiStream {
		const reader = body.getReader()
		const decoder = new TextDecoder()
		let buffer = ""
		let lastUsageMetadata: GenerateContentResponseUsageMetadata | undefined
		let pendingGroundingMetadata: GroundingMetadata | undefined
		let toolCallCounter = 0
		let hasContent = false

		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break

				buffer += decoder.decode(value, { stream: true })
				const lines = buffer.split("\n")
				buffer = lines.pop() ?? ""

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

					let parsed: any
					try {
						parsed = JSON.parse(payload)
					} catch {
						continue
					}

					const response = parsed?.response ?? parsed
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

					if (response?.candidates && response.candidates.length > 0) {
						const candidate = response.candidates[0]
						if (candidate.groundingMetadata) {
							pendingGroundingMetadata = candidate.groundingMetadata
						}
						if (candidate.content?.parts) {
							for (const part of candidate.content.parts as Array<{
								thought?: boolean
								text?: string
								thoughtSignature?: string
								functionCall?: { name: string; args: Record<string, unknown> }
							}>) {
								const thoughtSignature = part.thoughtSignature
								if (includeThoughtSignatures && thoughtSignature) {
									this.lastThoughtSignature = thoughtSignature
								}
								if (part.thought) {
									if (part.text) {
										hasContent = true
										yield { type: "reasoning", text: part.text }
									}
								} else if (part.functionCall) {
									const callId = `${part.functionCall.name}-${toolCallCounter}`
									const args = JSON.stringify(part.functionCall.args)
									hasContent = true
								// Tool call identity is emitted via tool_call_partial chunks.
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
					}

					if (response?.usageMetadata) {
						lastUsageMetadata = response.usageMetadata
					}
				}
			}
		} finally {
			reader.releaseLock()
		}

		if (pendingGroundingMetadata) {
			const sources = this.extractGroundingSources(pendingGroundingMetadata)
			if (sources.length > 0) {
				yield { type: "grounding", sources }
			}
		}

		if (lastUsageMetadata) {
			const usageData = this.normalizeUsage(lastUsageMetadata)
			if (usageData) {
				yield usageData
			}
		}

		if (!hasContent) {
			yield { type: "text", text: t("common:errors.gemini.thinking_complete_no_output") }
		}
	}

	async *createMessage(
		systemInstruction: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		await this.ensureAuthenticated()
		const projectId = await this.getProjectId()
		const accessToken = await geminiOAuthManager.getAccessToken({ path: this.options.geminiOauthPath })
		if (!accessToken) {
			throw new Error(
				t("common:errors.geminiOauth.notAuthenticated", {
					defaultValue:
						"Not authenticated with Gemini OAuth. Please sign in using the Gemini OAuth flow.",
				}),
			)
		}

		const { modelId, request } = this.buildRequestPayload(systemInstruction, messages, metadata)
		const includeThoughtSignatures = Boolean((request as any)?.generationConfig?.thinkingConfig)
		const envelope = {
			project: projectId,
			model: modelId,
			request,
		}

		const url = `${CODE_ASSIST_BASE_URL}/${CODE_ASSIST_VERSION}:streamGenerateContent?alt=sse`
		try {
			const response = await this.fetchWithRetry(
				url,
				{
					method: "POST",
					headers: this.getAuthHeaders(true, accessToken, metadata?.taskId),
					body: JSON.stringify(envelope),
				},
				true,
				metadata?.taskId,
			)

			if (!response.ok || !response.body) {
				const errorText = await response.text()
				throw new Error(this.formatHttpError(response.status, response.statusText, errorText))
			}

			yield* this.handleStreamResponse(response.body, this.getModel(), includeThoughtSignatures)
		} catch (error) {
			// Fallback to non-streaming request if streaming fails.
			try {
				const fallbackUrl = `${CODE_ASSIST_BASE_URL}/${CODE_ASSIST_VERSION}:generateContent`
				const fallbackResponse = await this.fetchWithRetry(
					fallbackUrl,
					{
						method: "POST",
						headers: this.getAuthHeaders(false, accessToken, metadata?.taskId),
						body: JSON.stringify(envelope),
					},
					false,
					metadata?.taskId,
				)
				if (fallbackResponse.ok) {
					const data = await fallbackResponse.json()
					const responseBody = data?.response ?? data
					let text = responseBody?.text ?? ""
					const candidate = responseBody?.candidates?.[0]
					if (!text && candidate?.content?.parts) {
						text = candidate.content.parts
							.map((part: { text?: string; thought?: boolean }) => (part.thought ? "" : (part.text ?? "")))
							.join("")
					}
					if (text) {
						yield { type: "text", text }
					}
					if (candidate?.groundingMetadata) {
						const sources = this.extractGroundingSources(candidate.groundingMetadata)
						if (sources.length > 0) {
							yield { type: "grounding", sources }
						}
					}
					if (responseBody?.usageMetadata) {
						const usageData = this.normalizeUsage(responseBody.usageMetadata)
						if (usageData) {
							yield usageData
						}
					}
					return
				}
			} catch {
				// Fall through to error handling below.
			}

			const errorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(errorMessage, this.providerName, modelId, "createMessage")
			TelemetryService.instance.captureException(apiError)

			if (error instanceof Error) {
				throw new Error(t("common:errors.geminiOauth.generate_stream", { error: error.message }))
			}
			throw error
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		await this.ensureAuthenticated()
		const projectId = await this.getProjectId()
		const accessToken = await geminiOAuthManager.getAccessToken({ path: this.options.geminiOauthPath })
		if (!accessToken) {
			throw new Error(
				t("common:errors.geminiOauth.notAuthenticated", {
					defaultValue:
						"Not authenticated with Gemini OAuth. Please sign in using the Gemini OAuth flow.",
				}),
			)
		}

		const model = this.getModel()
		const request: Record<string, unknown> = {
			contents: [{ role: "user", parts: [{ text: prompt }] }],
		}

		const supportsTemperature = model.info.supportsTemperature !== false
		const temperatureConfig: number | undefined = supportsTemperature
			? (this.options.modelTemperature ?? model.info.defaultTemperature ?? 1)
			: model.info.defaultTemperature
		if (typeof temperatureConfig === "number") {
			request.generationConfig = { temperature: temperatureConfig }
		}

		const envelope = {
			project: projectId,
			model: model.id,
			request,
		}

		const url = `${CODE_ASSIST_BASE_URL}/${CODE_ASSIST_VERSION}:generateContent`
		try {
			const response = await this.fetchWithRetry(
				url,
				{
					method: "POST",
					headers: this.getAuthHeaders(false, accessToken),
					body: JSON.stringify(envelope),
				},
				false,
			)

			if (!response.ok) {
				const errorText = await response.text()
				throw new Error(this.formatHttpError(response.status, response.statusText, errorText))
			}

			const data = await response.json()
			const responseBody = data?.response ?? data
			let text = responseBody?.text ?? ""
			const candidate = responseBody?.candidates?.[0]
			if (!text && candidate?.content?.parts) {
				text = candidate.content.parts
					.map((part: { text?: string; thought?: boolean }) => (part.thought ? "" : (part.text ?? "")))
					.join("")
			}

			if (candidate?.groundingMetadata) {
				const citations = this.extractCitationsOnly(candidate.groundingMetadata)
				if (citations) {
					text += `${t("common:errors.gemini.sources")} ${citations}`
				}
			}

			return text
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(errorMessage, this.providerName, model.id, "completePrompt")
			TelemetryService.instance.captureException(apiError)

			if (error instanceof Error) {
				throw new Error(t("common:errors.geminiOauth.generate_complete_prompt", { error: error.message }))
			}
			throw error
		}
	}
	override async countTokens(content: Anthropic.Messages.ContentBlockParam[]): Promise<number> {
		await this.ensureAuthenticated()
		const accessToken = await geminiOAuthManager.getAccessToken({ path: this.options.geminiOauthPath })
		if (!accessToken) {
			throw new Error(
				t("common:errors.geminiOauth.notAuthenticated", {
					defaultValue:
						"Not authenticated with Gemini OAuth. Please sign in using the Gemini OAuth flow.",
				}),
			)
		}

		const contents = convertAnthropicMessageToGemini({ role: "user", content })
		const request: Record<string, unknown> = { contents }
		const envelope = { request }
		const url = `${CODE_ASSIST_BASE_URL}/${CODE_ASSIST_VERSION}:countTokens`

		const response = await this.fetchWithRetry(
			url,
			{
				method: "POST",
				headers: this.getAuthHeaders(false, accessToken),
				body: JSON.stringify(envelope),
			},
			false,
		)

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(this.formatHttpError(response.status, response.statusText, errorText))
		}

		const data = await response.json()
		const responseBody = data?.response ?? data
		const totalTokens = responseBody?.totalTokens ?? responseBody?.total_tokens
		return typeof totalTokens === "number" ? totalTokens : 0
	}

	private async fetchWithRetry(
		url: string,
		init: RequestInit,
		streaming: boolean,
		taskId?: string,
	): Promise<Response> {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				this.abortController = new AbortController()
				const response = await fetch(url, { ...init, signal: this.abortController.signal })
				if (response.status !== 401 || attempt > 0) {
					return response
				}
			} catch (error) {
				if (attempt > 0) {
					throw error
				}
			}

			const refreshed = await geminiOAuthManager.forceRefreshAccessToken({ path: this.options.geminiOauthPath })
			if (!refreshed) {
				throw new Error(
					t("common:errors.geminiOauth.notAuthenticated", {
						defaultValue:
							"Not authenticated with Gemini OAuth. Please sign in using the Gemini OAuth flow.",
					}),
				)
			}

			const headers = this.getAuthHeaders(streaming, refreshed, taskId)
			return await fetch(url, { ...init, headers, signal: this.abortController?.signal })
		}

		throw new Error(
			t("common:errors.geminiOauth.notAuthenticated", {
				defaultValue: "Not authenticated with Gemini OAuth. Please sign in using the Gemini OAuth flow.",
			}),
		)
	}

	private formatHttpError(status: number, statusText: string, errorText: string): string {
		let errorMessage = t("common:errors.geminiOauth.genericError", { status })
		let errorDetails = ""

		try {
			const errorJson = JSON.parse(errorText)
			if (errorJson.error?.message) {
				errorDetails = errorJson.error.message
			} else if (errorJson.message) {
				errorDetails = errorJson.message
			} else if (errorJson.detail) {
				errorDetails = errorJson.detail
			} else {
				errorDetails = errorText
			}
		} catch {
			errorDetails = errorText
		}

		switch (status) {
			case 400:
				errorMessage = t("common:errors.geminiOauth.invalidRequest")
				break
			case 401:
				errorMessage = t("common:errors.geminiOauth.authenticationFailed")
				break
			case 403:
				errorMessage = t("common:errors.geminiOauth.accessDenied")
				break
			case 404:
				errorMessage = t("common:errors.geminiOauth.endpointNotFound")
				break
			case 429:
				errorMessage = t("common:errors.geminiOauth.rateLimitExceeded")
				break
			case 500:
			case 502:
			case 503:
				errorMessage = t("common:errors.geminiOauth.serviceError")
				break
			default:
				errorMessage = t("common:errors.geminiOauth.genericError", { status })
		}

		if (errorDetails) {
			errorMessage += ` - ${errorDetails}`
		}

		return errorMessage || `Gemini OAuth error: ${status} ${statusText}`
	}

	getModel() {
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

	public getThoughtSignature(): string | undefined {
		return this.lastThoughtSignature
	}

	public getResponseId(): string | undefined {
		return this.lastResponseId
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
					return { title, url: uri }
				}
				return null
			})
			.filter((source): source is GroundingSource => source !== null)
	}

	private extractCitationsOnly(groundingMetadata?: GroundingMetadata): string | null {
		const sources = this.extractGroundingSources(groundingMetadata)
		if (sources.length === 0) {
			return null
		}

		const citationLinks = sources.map((source, i) => `[${i + 1}](${source.url})`)
		return citationLinks.join(", ")
	}
}
