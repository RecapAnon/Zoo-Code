import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { Anthropic } from "@anthropic-ai/sdk"
import { type GenerateContentResponseUsageMetadata, type GroundingMetadata } from "@google/genai"
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

const ROO_DIR = ".roo"
const GEMINI_OAUTH_CREDENTIAL_FILENAME = "gemini-oauth.json"
const OAUTH_TOKEN_BUFFER_MS = 30_000

const CODE_ASSIST_BASE_URL = "https://cloudcode-pa.googleapis.com"
const CODE_ASSIST_VERSION = "v1internal"

const GEMINI_OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
const GEMINI_OAUTH_SCOPES = "https://www.googleapis.com/auth/cloud-platform"

const GEMINI_CLI_USER_AGENT = "google-api-nodejs-client/9.15.1"
const GEMINI_CLI_API_CLIENT = "gl-node/22.17.0"
const GEMINI_CLI_CLIENT_METADATA = "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI"

interface GeminiOAuthTokenPayload {
	access_token: string
	client_id?: string
	client_secret?: string
	refresh_token?: string
	expiry_date?: number
	last_refresh?: string
}

interface GeminiOAuthCredentials {
	token: GeminiOAuthTokenPayload
	client_id?: string
	client_secret?: string
	project_id?: string
	email?: string
	auto?: boolean
	checked?: boolean
	type?: string
}

interface GeminiOAuthHandlerOptions extends ApiHandlerOptions {
	geminiOauthPath?: string
	geminiOauthProjectId?: string
}

type FunctionCallingConfigMode = "AUTO" | "NONE" | "ANY"

function getGeminiCachedCredentialPath(customPath?: string): string {
	if (customPath) {
		if (customPath.startsWith("~/")) {
			return path.join(os.homedir(), customPath.slice(2))
		}
		return path.resolve(customPath)
	}
	return path.join(os.homedir(), ROO_DIR, GEMINI_OAUTH_CREDENTIAL_FILENAME)
}

function parseExpiry(expiryDate?: number): number | null {
	if (typeof expiryDate === "number") {
		return expiryDate
	}
	return null
}

function isTokenValid(token?: GeminiOAuthTokenPayload): boolean {
	if (!token) return false
	const expiry = parseExpiry(token.expiry_date)
	if (!expiry) return false
	return Date.now() < expiry - OAUTH_TOKEN_BUFFER_MS
}

function getClientCredentials(credentials: GeminiOAuthCredentials): { clientId: string; clientSecret: string } | null {
	const clientId = credentials.token.client_id ?? credentials.client_id
	const clientSecret = credentials.token.client_secret ?? credentials.client_secret
	if (!clientId || !clientSecret) {
		return null
	}
	return { clientId, clientSecret }
}
function objectToUrlEncoded(data: Record<string, string>): string {
	return Object.keys(data)
		.map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`)
		.join("&")
}

export class GeminiOAuthHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: GeminiOAuthHandlerOptions
	private credentials: GeminiOAuthCredentials | null = null
	private refreshPromise: Promise<GeminiOAuthCredentials> | null = null
	private lastThoughtSignature?: string
	private lastResponseId?: string
	private readonly providerName = "Gemini"

	constructor(options: GeminiOAuthHandlerOptions) {
		super()
		this.options = options
	}

	private async doRefreshAccessToken(credentials: GeminiOAuthCredentials): Promise<GeminiOAuthCredentials> {
		if (!credentials.token.refresh_token) {
			throw new Error("No refresh token available in credentials.")
		}
		const clientCreds = getClientCredentials(credentials)
		if (!clientCreds) {
			throw new Error("No client credentials available.")
		}

		const bodyData = {
			grant_type: "refresh_token",
			refresh_token: credentials.token.refresh_token,
			client_id: clientCreds.clientId,
			client_secret: clientCreds.clientSecret,
			scope: GEMINI_OAUTH_SCOPES,
		}

		const response = await fetch(GEMINI_OAUTH_TOKEN_ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: objectToUrlEncoded(bodyData),
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`Token refresh failed: ${response.status} ${response.statusText}. Response: ${errorText}`)
		}

		const tokenData = await response.json()

		if (tokenData.error) {
			throw new Error(`Token refresh failed: ${tokenData.error} - ${tokenData.error_description}`)
		}

		// Update the in-memory credentials directly
		this.credentials = {
			...credentials,
			token: {
				...credentials.token,
				access_token: tokenData.access_token,
				refresh_token: tokenData.refresh_token || credentials.token.refresh_token,
				expiry_date: Date.now() + tokenData.expires_in * 1000,
				last_refresh: new Date().toISOString(),
			},
		}

		const filePath = getGeminiCachedCredentialPath(this.options.geminiOauthPath)
		try {
			await fs.writeFile(filePath, JSON.stringify(this.credentials, null, 2))
		} catch (error) {
			console.error("Failed to save refreshed credentials:", error)
		}

		return this.credentials
	}
	private async callApiWithRetry<T>(apiCall: () => Promise<T>): Promise<T> {
		try {
			return await apiCall()
		} catch (error: any) {
			if (error.status === 401) {
				if (this.credentials) {
					this.credentials = await this.refreshAccessToken(this.credentials)
				}
				return await apiCall()
			}
			throw error
		}
	}
	private async refreshAccessToken(credentials: GeminiOAuthCredentials): Promise<GeminiOAuthCredentials> {
		if (this.refreshPromise) {
			return this.refreshPromise
		}

		this.refreshPromise = this.doRefreshAccessToken(credentials)

		try {
			return await this.refreshPromise
		} finally {
			this.refreshPromise = null
		}
	}

	private async loadCachedGeminiCredentials(): Promise<GeminiOAuthCredentials> {
		try {
			const keyFile = getGeminiCachedCredentialPath(this.options.geminiOauthPath)
			const credsStr = await fs.readFile(keyFile, "utf-8")
			return JSON.parse(credsStr)
		} catch (error) {
			console.error(
				`Error reading or parsing credentials file at ${getGeminiCachedCredentialPath(this.options.geminiOauthPath)}`,
			)
			throw new Error(`Failed to load Gemini OAuth credentials: ${error}`)
		}
	}

	private async ensureAuthenticated(): Promise<GeminiOAuthCredentials> {
		if (!this.credentials) {
			this.credentials = await this.loadCachedGeminiCredentials()
		}

		const projectId = this.getProjectId(this.credentials)
		if (!projectId) {
			throw new Error("Gemini OAuth credentials missing project_id; set geminiOauthProjectId.")
		}

		const token = this.credentials.token
		if (!token?.access_token) {
			throw new Error("Gemini OAuth credentials missing access_token.")
		}
		if (!getClientCredentials(this.credentials)) {
			throw new Error("Gemini OAuth credentials missing client_id or client_secret.")
		}

		if (!isTokenValid(token)) {
			if (this.refreshPromise) {
				this.credentials = await this.refreshPromise
			} else {
				this.credentials = await this.refreshAccessToken(this.credentials)
			}
		}

		return this.credentials
	}

	private getProjectId(credentials: GeminiOAuthCredentials): string | null {
		return this.options.geminiOauthProjectId ?? credentials.project_id ?? null
	}

	private getAuthHeaders(streaming: boolean): Record<string, string> {
		return {
			Authorization: `Bearer ${this.credentials?.token.access_token ?? ""}`,
			"Content-Type": "application/json",
			Accept: streaming ? "text/event-stream" : "application/json",
			"User-Agent": GEMINI_CLI_USER_AGENT,
			"X-Goog-Api-Client": GEMINI_CLI_API_CLIENT,
			"Client-Metadata": GEMINI_CLI_CLIENT_METADATA,
		}
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

		const includeThoughtSignatures = Boolean(thinkingConfig)

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

		const tools: Array<{ functionDeclarations?: any[]; googleSearch?: Record<string, unknown>; urlContext?: any }> =
			[]
		const allowTools = metadata?.toolProtocol !== "xml"
		if (allowTools && metadata?.tools && metadata.tools.length > 0) {
			tools.push({
				functionDeclarations: metadata.tools.map((tool) => ({
					name: (tool as any).function.name,
					description: (tool as any).function.description,
					parametersJsonSchema: (tool as any).function.parameters,
				})),
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
		if (metadata?.tool_choice) {
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
			request.systemInstruction = { role: "user", parts: [{ text: systemInstruction }] }
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
		info: ModelInfo,
		includeThoughtSignatures: boolean,
	): ApiStream {
		const reader = body.getReader()
		const decoder = new TextDecoder()
		let buffer = ""
		let lastUsageMetadata: GenerateContentResponseUsageMetadata | undefined
		let pendingGroundingMetadata: GroundingMetadata | undefined
		let toolCallCounter = 0

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
										yield { type: "reasoning", text: part.text }
									}
								} else if (part.functionCall) {
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
				totalCost: this.calculateCost({
					info,
					inputTokens,
					outputTokens,
					cacheReadTokens,
					reasoningTokens,
				}),
			}
		}
	}

	async *createMessage(
		systemInstruction: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const credentials = await this.ensureAuthenticated()
		const projectId = this.getProjectId(credentials)
		if (!projectId) {
			throw new Error("Gemini OAuth credentials missing project_id; set geminiOauthProjectId.")
		}

		const { modelId, info, request } = this.buildRequestPayload(systemInstruction, messages, metadata)
		const includeThoughtSignatures = Boolean((request as any)?.generationConfig?.thinkingConfig)
		const envelope = {
			project: projectId,
			model: modelId,
			request,
		}

		const url = `${CODE_ASSIST_BASE_URL}/${CODE_ASSIST_VERSION}:streamGenerateContent?alt=sse`
		try {
			const response = await this.callApiWithRetry(() =>
				fetch(url, {
					method: "POST",
					headers: this.getAuthHeaders(true),
					body: JSON.stringify(envelope),
				}),
			)

			if (!response.ok || !response.body) {
				const errorText = await response.text()
				throw new Error(
					`Gemini OAuth streaming request failed: ${response.status} ${response.statusText}. ${errorText}`,
				)
			}

			yield* this.handleStreamResponse(response.body, info, includeThoughtSignatures)
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(errorMessage, this.providerName, modelId, "createMessage")
			TelemetryService.instance.captureException(apiError)

			if (error instanceof Error) {
				throw new Error(t("common:errors.gemini.generate_stream", { error: error.message }))
			}
			throw error
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		const credentials = await this.ensureAuthenticated()
		const projectId = this.getProjectId(credentials)
		if (!projectId) {
			throw new Error("Gemini OAuth credentials missing project_id; set geminiOauthProjectId.")
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
			const response = await this.callApiWithRetry(() =>
				fetch(url, {
					method: "POST",
					headers: this.getAuthHeaders(false),
					body: JSON.stringify(envelope),
				}),
			)

			if (!response.ok) {
				const errorText = await response.text()
				throw new Error(
					`Gemini OAuth completion failed: ${response.status} ${response.statusText}. ${errorText}`,
				)
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
					text += `\n\n${t("common:errors.gemini.sources")} ${citations}`
				}
			}

			return text
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(errorMessage, this.providerName, model.id, "completePrompt")
			TelemetryService.instance.captureException(apiError)

			if (error instanceof Error) {
				throw new Error(t("common:errors.gemini.generate_complete_prompt", { error: error.message }))
			}
			throw error
		}
	}
	override async countTokens(content: Anthropic.Messages.ContentBlockParam[]): Promise<number> {
		const credentials = await this.ensureAuthenticated()
		const projectId = this.getProjectId(credentials)
		if (!projectId) {
			throw new Error("Gemini OAuth credentials missing project_id; set geminiOauthProjectId.")
		}

		const model = this.getModel()
		const contents = convertAnthropicMessageToGemini({ role: "user", content })
		const request: Record<string, unknown> = { contents }
		const envelope = { request }
		const url = `${CODE_ASSIST_BASE_URL}/${CODE_ASSIST_VERSION}:countTokens`

		const response = await this.callApiWithRetry(() =>
			fetch(url, {
				method: "POST",
				headers: this.getAuthHeaders(false),
				body: JSON.stringify(envelope),
			}),
		)

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`Gemini OAuth countTokens failed: ${response.status} ${response.statusText}. ${errorText}`)
		}

		const data = await response.json()
		const responseBody = data?.response ?? data
		const totalTokens = responseBody?.totalTokens ?? responseBody?.total_tokens
		return typeof totalTokens === "number" ? totalTokens : 0
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

	private calculateCost({
		info,
		inputTokens,
		outputTokens,
		cacheReadTokens = 0,
		reasoningTokens = 0,
	}: {
		info: ModelInfo
		inputTokens: number
		outputTokens: number
		cacheReadTokens?: number
		reasoningTokens?: number
	}) {
		/* let inputPrice = info.inputPrice
		let outputPrice = info.outputPrice
		let cacheReadsPrice = info.cacheReadsPrice

		if (info.tiers) {
			const tier = info.tiers.find((tier) => inputTokens <= tier.contextWindow)
			if (tier) {
				inputPrice = tier.inputPrice ?? inputPrice
				outputPrice = tier.outputPrice ?? outputPrice
				cacheReadsPrice = tier.cacheReadsPrice ?? cacheReadsPrice
			}
		}

		if (!inputPrice || !outputPrice) {
			return undefined
		}

		if (!cacheReadsPrice) {
			cacheReadsPrice = 0
		}

		const uncachedInputTokens = inputTokens - cacheReadTokens
		const billedOutputTokens = outputTokens + reasoningTokens

		const inputCost = (uncachedInputTokens / 1_000_000) * inputPrice
		const outputCost = (billedOutputTokens / 1_000_000) * outputPrice
		const cacheReadsCost = (cacheReadTokens / 1_000_000) * cacheReadsPrice
		return inputCost + outputCost + cacheReadsCost */
		// NOTE: OAuth is billed monthly.
		return 0
	}
}
