import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { Anthropic } from "@anthropic-ai/sdk"

import { type ModelInfo, type CodexOAuthModelId, codexOauthDefaultModelId, codexOauthModels } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { ApiStream } from "../transform/stream"

import { BaseProvider } from "./base-provider"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { getCodexOfficialInstructions } from "./codex-instructions"

const CODEX_OAUTH_BASE_URL = "https://auth.openai.com"
const CODEX_OAUTH_TOKEN_ENDPOINT = `${CODEX_OAUTH_BASE_URL}/oauth/token`
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const CODEX_RESPONSES_BASE_URL = "https://chatgpt.com/backend-api/codex"

const CODEX_USER_AGENT = "codex_cli_rs/0.50.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464"
const CODEX_ORIGINATOR = "codex_cli_rs"

const ROO_DIR = ".roo"
const CODEX_CREDENTIAL_FILENAME = "codex-oauth.json"

const RESPONSE_TEXT_DELTA_TYPES = new Set(["response.text.delta", "response.output_text.delta"])

const RESPONSE_REASONING_DELTA_TYPES = new Set([
	"response.reasoning.delta",
	"response.reasoning_text.delta",
	"response.reasoning_summary.delta",
	"response.reasoning_summary_text.delta",
])

const RESPONSE_TOOL_ARGS_DELTA_TYPES = new Set([
	"response.tool_call_arguments.delta",
	"response.function_call_arguments.delta",
])

interface CodexOAuthCredentials {
	access_token: string
	refresh_token: string
	id_token?: string
	account_id?: string
	email?: string
	last_refresh?: string
	expired?: string
	type?: string
}

interface CodexOAuthHandlerOptions extends ApiHandlerOptions {
	codexOauthPath?: string
}

function getCodexCachedCredentialPath(customPath?: string): string {
	if (customPath) {
		if (customPath.startsWith("~/")) {
			return path.join(os.homedir(), customPath.slice(2))
		}
		return path.resolve(customPath)
	}
	return path.join(os.homedir(), ROO_DIR, CODEX_CREDENTIAL_FILENAME)
}

function objectToUrlEncoded(data: Record<string, string>): string {
	return Object.keys(data)
		.map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`)
		.join("&")
}

function parseExpiry(expired?: string): number | null {
	if (!expired) return null
	const value = Date.parse(expired)
	return Number.isNaN(value) ? null : value
}

export class CodexOAuthHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: CodexOAuthHandlerOptions
	private credentials: CodexOAuthCredentials | null = null
	private refreshPromise: Promise<CodexOAuthCredentials> | null = null
	private lastSystemPrompt: string | null = null

	constructor(options: CodexOAuthHandlerOptions) {
		super()
		this.options = options
	}

	private async loadCachedCodexCredentials(): Promise<CodexOAuthCredentials> {
		try {
			const keyFile = getCodexCachedCredentialPath(this.options.codexOauthPath)
			const credsStr = await fs.readFile(keyFile, "utf-8")
			return JSON.parse(credsStr)
		} catch (error) {
			console.error(
				`Error reading or parsing credentials file at ${getCodexCachedCredentialPath(this.options.codexOauthPath)}`,
			)
			throw new Error(`Failed to load Codex OAuth credentials: ${error}`)
		}
	}

	private async refreshAccessToken(credentials: CodexOAuthCredentials): Promise<CodexOAuthCredentials> {
		if (this.refreshPromise) {
			return this.refreshPromise
		}

		this.refreshPromise = this.doRefreshAccessToken(credentials)

		try {
			const result = await this.refreshPromise
			return result
		} finally {
			this.refreshPromise = null
		}
	}

	private async doRefreshAccessToken(credentials: CodexOAuthCredentials): Promise<CodexOAuthCredentials> {
		if (!credentials.refresh_token) {
			throw new Error("No refresh token available in credentials.")
		}

		const bodyData = {
			grant_type: "refresh_token",
			refresh_token: credentials.refresh_token,
			client_id: CODEX_OAUTH_CLIENT_ID,
			scope: "openid profile email",
		}

		const response = await fetch(CODEX_OAUTH_TOKEN_ENDPOINT, {
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

		const newCredentials: CodexOAuthCredentials = {
			...credentials,
			access_token: tokenData.access_token,
			refresh_token: tokenData.refresh_token || credentials.refresh_token,
			id_token: tokenData.id_token || credentials.id_token,
			expired: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
			last_refresh: new Date().toISOString(),
		}

		const filePath = getCodexCachedCredentialPath(this.options.codexOauthPath)
		try {
			await fs.writeFile(filePath, JSON.stringify(newCredentials, null, 2))
		} catch (error) {
			console.error("Failed to save refreshed credentials:", error)
		}

		return newCredentials
	}

	private isTokenValid(credentials: CodexOAuthCredentials): boolean {
		const TOKEN_REFRESH_BUFFER_MS = 30 * 1000
		const expiresAt = parseExpiry(credentials.expired)
		if (!expiresAt) {
			return false
		}
		return Date.now() < expiresAt - TOKEN_REFRESH_BUFFER_MS
	}

	private async ensureAuthenticated(): Promise<void> {
		if (!this.credentials) {
			this.credentials = await this.loadCachedCodexCredentials()
		}

		if (!this.isTokenValid(this.credentials)) {
			this.credentials = await this.refreshAccessToken(this.credentials)
		}

		// Tokens are attached to requests via headers.
	}

	private async callApiWithRetry<T>(apiCall: () => Promise<T>): Promise<T> {
		try {
			return await apiCall()
		} catch (error: any) {
			if (error.status === 401) {
				this.credentials = await this.refreshAccessToken(this.credentials!)
				return await apiCall()
			}
			throw error
		}
	}

	private getAuthHeaders(streaming = true): Record<string, string> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.credentials?.access_token ?? ""}`,
			"Openai-Beta": "responses=experimental",
			Accept: streaming ? "text/event-stream" : "application/json",
			Connection: "keep-alive",
			"Content-Type": "application/json",
			"User-Agent": CODEX_USER_AGENT,
		}

		// OAuth tokens require Codex-specific headers.
		headers.Originator = CODEX_ORIGINATOR
		if (this.credentials?.account_id) {
			headers["Chatgpt-Account-Id"] = this.credentials.account_id
		}

		return headers
	}

	private formatResponsesInput(
		messages: Anthropic.Messages.MessageParam[],
		systemPrompt: string,
	): { input: any[]; instructions: string } {
		const input: any[] = []
		const developerMessage = systemPrompt
			? {
					role: "developer",
					content: [{ type: "input_text", text: systemPrompt }],
				}
			: null

		for (const message of messages) {
			if ((message as any).type === "reasoning") {
				input.push(message)
				continue
			}

			if (message.role === "user") {
				const content: any[] = []
				const toolResults: any[] = []

				if (typeof message.content === "string") {
					content.push({ type: "input_text", text: message.content })
				} else if (Array.isArray(message.content)) {
					for (const block of message.content) {
						if (!block) {
							continue
						}
						if (block.type === "text") {
							content.push({ type: "input_text", text: block.text })
						} else if (block.type === "image") {
							const image = block as Anthropic.Messages.ImageBlockParam
							const imageUrl = `data:${image.source.media_type};base64,${image.source.data}`
							content.push({ type: "input_image", image_url: imageUrl })
						} else if (block.type === "tool_result") {
							const result =
								typeof block.content === "string"
									? block.content
									: block.content?.map((part) => (part.type === "text" ? part.text : "")).join("") ||
										""
							toolResults.push({
								type: "function_call_output",
								call_id: block.tool_use_id,
								output: result,
							})
						}
					}
				}

				if (content.length > 0) {
					input.push({ role: "user", content })
				}
				if (toolResults.length > 0) {
					input.push(...toolResults)
				}
				continue
			}

			if (message.role === "assistant") {
				const content: any[] = []
				const toolCalls: any[] = []

				if (typeof message.content === "string") {
					content.push({ type: "output_text", text: message.content })
				} else if (Array.isArray(message.content)) {
					for (const block of message.content) {
						if (!block) {
							continue
						}
						if (block.type === "text") {
							content.push({ type: "output_text", text: block.text })
						} else if (block.type === "tool_use") {
							toolCalls.push({
								type: "function_call",
								call_id: block.id,
								name: block.name,
								arguments: JSON.stringify(block.input),
							})
						}
					}
				}

				if (content.length > 0) {
					input.push({ role: "assistant", content })
				}
				if (toolCalls.length > 0) {
					input.push(...toolCalls)
				}
			}
		}

		return {
			input: developerMessage ? [developerMessage, ...input] : input,
			instructions: systemPrompt,
		}
	}

	private buildResponsesRequest(
		model: { id: string; info: ModelInfo },
		messages: Anthropic.Messages.MessageParam[],
		systemPrompt: string,
		metadata?: ApiHandlerCreateMessageMetadata,
	): any {
		const { input, instructions } = this.formatResponsesInput(messages, systemPrompt)
		const request: any = {
			model: model.id,
			input,
			instructions,
			stream: true,
			store: false,
		}

		const supportsNativeTools = model.info.supportsNativeTools ?? false
		const useNativeTools =
			supportsNativeTools && metadata?.tools && metadata.tools.length > 0 && metadata?.toolProtocol !== "xml"
		if (useNativeTools) {
			request.tools = metadata.tools
				.filter((tool) => tool.type === "function")
				.map((tool) => ({
					type: "function",
					name: tool.function.name,
					description: tool.function.description,
					parameters: tool.function.parameters,
				}))
			if (metadata.tool_choice) {
				request.tool_choice = metadata.tool_choice
			}
			request.parallel_tool_calls = metadata?.parallelToolCalls ?? false
		}

		return request
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		await this.ensureAuthenticated()
		const model = this.getModel()

		this.lastSystemPrompt = systemPrompt
		const requestBody = this.buildResponsesRequest(model, messages, systemPrompt, metadata)
		const { instructions } = getCodexOfficialInstructions(model.id, systemPrompt)
		requestBody.instructions = instructions
		const url = `${CODEX_RESPONSES_BASE_URL}/responses`
		const headers = this.getAuthHeaders(true)

		const response = await this.callApiWithRetry(() =>
			fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(requestBody),
			}),
		)

		if (!response.ok || !response.body) {
			const errorText = await response.text()
			throw new Error(`Codex responses request failed: ${response.status} ${response.statusText}. ${errorText}`)
		}

		const reader = response.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ""
		let toolCallIndex = 0
		const toolCallIndexById = new Map<string, number>()
		let hasTextDelta = false
		let hasReasoningDelta = false
		let hasTextOutput = false
		let hasReasoningOutput = false

		while (true) {
			const { value, done } = await reader.read()
			if (done) {
				break
			}
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

				if (RESPONSE_TEXT_DELTA_TYPES.has(parsed.type)) {
					if (parsed.delta) {
						hasTextDelta = true
						hasTextOutput = true
						yield { type: "text", text: parsed.delta }
					}
					continue
				}

				if (RESPONSE_REASONING_DELTA_TYPES.has(parsed.type)) {
					if (parsed.delta) {
						hasReasoningDelta = true
						hasReasoningOutput = true
						yield { type: "reasoning", text: parsed.delta }
					}
					continue
				}

				if (RESPONSE_TOOL_ARGS_DELTA_TYPES.has(parsed.type)) {
					const id = parsed.call_id || parsed.tool_call_id || parsed.id
					let index = parsed.index
					if (typeof index !== "number") {
						if (id) {
							const existingIndex = toolCallIndexById.get(id)
							if (existingIndex !== undefined) {
								index = existingIndex
							} else {
								index = toolCallIndex
								toolCallIndexById.set(id, toolCallIndex)
								toolCallIndex += 1
							}
						} else {
							index = toolCallIndex
							toolCallIndex += 1
						}
					} else if (id && !toolCallIndexById.has(id)) {
						toolCallIndexById.set(id, index)
					}
					yield {
						type: "tool_call_partial",
						index,
						id,
						name: parsed.name || parsed.function_name,
						arguments: parsed.delta || parsed.arguments,
					}
					continue
				}

				if (parsed.type === "response.output_item.added" || parsed.type === "response.output_item.done") {
					const item = parsed.item
					if (item) {
						if (item.type === "text" && item.text) {
							if (!hasTextDelta && parsed.type === "response.output_item.added") {
								hasTextOutput = true
								yield { type: "text", text: item.text }
							}
						} else if (item.type === "reasoning" && item.text) {
							if (!hasReasoningDelta && parsed.type === "response.output_item.added") {
								hasReasoningOutput = true
								yield { type: "reasoning", text: item.text }
							}
						} else if (item.type === "message" && Array.isArray(item.content)) {
							for (const content of item.content) {
								if ((content.type === "output_text" || content.type === "text") && content.text) {
									if (!hasTextDelta && parsed.type === "response.output_item.added") {
										hasTextOutput = true
										yield { type: "text", text: content.text }
									}
								} else if (content.type === "summary_text" && content.text) {
									if (!hasReasoningDelta && parsed.type === "response.output_item.added") {
										hasReasoningOutput = true
										yield { type: "reasoning", text: content.text }
									}
								}
							}
						} else if (
							(item.type === "function_call" || item.type === "tool_call") &&
							parsed.type === "response.output_item.done"
						) {
							const callId = item.call_id || item.tool_call_id || item.id
							const args = item.arguments || item.function?.arguments || item.function_arguments
							if (callId) {
								yield {
									type: "tool_call",
									id: callId,
									name: item.name || item.function?.name || item.function_name || "",
									arguments: typeof args === "string" ? args : "{}",
								}
							}
						}
					}
					continue
				}

				if (parsed.type === "response.completed" || parsed.type === "response.done") {
					const usage = parsed.response?.usage || parsed.usage
					if (usage) {
						yield {
							type: "usage",
							inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
							outputTokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
						}
					}
					if (parsed.response?.output && Array.isArray(parsed.response.output)) {
						const shouldEmitText = !hasTextOutput
						const shouldEmitReasoning = !hasReasoningOutput
						if (shouldEmitText || shouldEmitReasoning) {
							for (const outputItem of parsed.response.output) {
								if (
									shouldEmitText &&
									outputItem.type === "message" &&
									Array.isArray(outputItem.content)
								) {
									for (const content of outputItem.content) {
										if (content.type === "output_text" && content.text) {
											yield { type: "text", text: content.text }
										}
									}
								}
								if (
									shouldEmitReasoning &&
									outputItem.type === "reasoning" &&
									Array.isArray(outputItem.summary)
								) {
									for (const summary of outputItem.summary) {
										if (summary?.type === "summary_text" && summary.text) {
											yield { type: "reasoning", text: summary.text }
										}
									}
								}
							}
						}
					}
					continue
				}
			}
		}
	}

	override getModel(): { id: string; info: ModelInfo } {
		const id = this.options.apiModelId ?? codexOauthDefaultModelId
		const info = codexOauthModels[id as keyof typeof codexOauthModels] || codexOauthModels[codexOauthDefaultModelId]
		return { id, info }
	}

	async completePrompt(prompt: string): Promise<string> {
		await this.ensureAuthenticated()
		const model = this.getModel()

		const developerPrompt = this.lastSystemPrompt ?? ""
		const { instructions } = getCodexOfficialInstructions(model.id, developerPrompt)
		const requestBody = {
			model: model.id,
			input: developerPrompt
				? [
						{
							role: "developer",
							content: [{ type: "input_text", text: developerPrompt }],
						},
						{ role: "user", content: [{ type: "input_text", text: prompt }] },
					]
				: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
			instructions,
			stream: false,
			store: false,
		}

		const response = await this.callApiWithRetry(() =>
			fetch(`${CODEX_RESPONSES_BASE_URL}/responses`, {
				method: "POST",
				headers: this.getAuthHeaders(false),
				body: JSON.stringify(requestBody),
			}),
		)

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(
				`Codex responses completion failed: ${response.status} ${response.statusText}. ${errorText}`,
			)
		}

		const data = await response.json()
		if (data?.output && Array.isArray(data.output)) {
			for (const outputItem of data.output) {
				if (outputItem.type === "message" && Array.isArray(outputItem.content)) {
					for (const content of outputItem.content) {
						if (content.type === "output_text" && content.text) {
							return content.text
						}
					}
				}
			}
		}

		return data?.text || ""
	}
}
