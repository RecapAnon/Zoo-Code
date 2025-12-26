// npx vitest run api/providers/__tests__/gemini-oauth.spec.ts

vi.mock("node:fs", () => ({
	promises: {
		readFile: vi.fn(),
	},
}))

import { Anthropic } from "@anthropic-ai/sdk"

import { promises as fs } from "node:fs"

import { GeminiOAuthHandler } from "../gemini-oauth"
import type { ApiHandlerOptions } from "../../../shared/api"

const mockFetch = vi.fn()

function buildSseStream(lines: string[]) {
	return new ReadableStream({
		start(controller) {
			for (const line of lines) {
				controller.enqueue(new TextEncoder().encode(`${line}\n`))
			}
			controller.close()
		},
	})
}

describe("GeminiOAuthHandler", () => {
	const systemPrompt = "You are helpful."
	const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]
	let handler: GeminiOAuthHandler
	let options: ApiHandlerOptions & { geminiOauthPath?: string; geminiOauthProjectId?: string }

	beforeEach(() => {
		vi.clearAllMocks()
		global.fetch = mockFetch as any
		const mockCredentials = {
			token: {
				access_token: "test-access-token",
				client_id: "client-id",
				client_secret: "client-secret",
				expiry_date: Date.now() + 3600_000,
			},
			project_id: "test-project",
		}
		;(fs.readFile as any).mockResolvedValue(JSON.stringify(mockCredentials))
		options = {
			apiModelId: "gemini-2.5-pro",
			geminiOauthPath: "~/.roo/gemini-oauth.json",
			geminiOauthProjectId: "test-project",
		}
		handler = new GeminiOAuthHandler(options)
	})

	afterEach(() => {
		delete (global as any).fetch
	})

	it("streams via Cloud Code Assist with CLI headers and envelope", async () => {
		const stream = buildSseStream([
			'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}}',
			"data: [DONE]",
		])

		mockFetch.mockResolvedValue({
			ok: true,
			body: stream,
		})

		const iterator = handler.createMessage(systemPrompt, messages)
		const chunks: any[] = []
		for await (const chunk of iterator) {
			chunks.push(chunk)
		}

		expect(chunks).toEqual(
			expect.arrayContaining([
				{ type: "text", text: "Hello" },
				expect.objectContaining({ type: "usage", inputTokens: 5, outputTokens: 2 }),
			]),
		)

		expect(mockFetch).toHaveBeenCalledWith(
			"https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Accept: "text/event-stream",
					Authorization: "Bearer test-access-token",
					"User-Agent": "google-api-nodejs-client/9.15.1",
					"X-Goog-Api-Client": "gl-node/22.17.0",
					"Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
				}),
				body: expect.any(String),
			}),
		)

		const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body as string)
		expect(body.project).toBe("test-project")
		expect(body.model).toBe("gemini-2.5-pro")
		expect(body.request.systemInstruction.parts[0].text).toBe(systemPrompt)
		expect(body.request.contents[0].role).toBe("user")
		expect(body.request.generationConfig.thinkingConfig.include_thoughts).toBe(true)
	})

	it("uses generateContent for completePrompt", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				response: {
					candidates: [{ content: { parts: [{ text: "Prompt response" }] } }],
				},
			}),
		})

		const result = await handler.completePrompt("Hello prompt")
		expect(result).toBe("Prompt response")
		expect(mockFetch).toHaveBeenCalledWith(
			"https://cloudcode-pa.googleapis.com/v1internal:generateContent",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Accept: "application/json",
				}),
				body: expect.any(String),
			}),
		)
	})

	it("uses countTokens without project/model envelope fields", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ response: { totalTokens: 123 } }),
		})

		const total = await handler.countTokens([{ type: "text", text: "Hello" }])
		expect(total).toBe(123)
		expect(mockFetch).toHaveBeenCalledWith(
			"https://cloudcode-pa.googleapis.com/v1internal:countTokens",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Accept: "application/json",
				}),
				body: expect.any(String),
			}),
		)
		const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body as string)
		expect(body.project).toBeUndefined()
		expect(body.model).toBeUndefined()
		expect(body.request).toBeDefined()
	})

	it("maps tool_result ids to tool names when history lacks tool_use", async () => {
		const toolMessages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "list_files-0", content: "ok" }],
			},
		]
		const stream = buildSseStream(["data: [DONE]"])
		mockFetch.mockResolvedValue({ ok: true, body: stream })

		const iterator = handler.createMessage(systemPrompt, toolMessages, {
			taskId: "test-task",
			tools: [
				{
					type: "function",
					function: {
						name: "list_files",
						description: "List files",
						parameters: { type: "object", properties: {} },
					},
				},
			],
		})
		for await (const _chunk of iterator) {
			// consume
		}

		const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body as string)
		const toolParts = body.request.contents
			.flatMap((content: any) => content.parts || [])
			.filter((part: any) => part.functionResponse)
		const toolNames = toolParts.map((part: any) => part.functionResponse.name)
		expect(toolNames).toContain("list_files")
	})

	it("derives tool names from tool_result ids when metadata is missing", async () => {
		const toolMessages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "read_file-0", content: "ok" }],
			},
		]
		const stream = buildSseStream(["data: [DONE]"])
		mockFetch.mockResolvedValue({ ok: true, body: stream })

		const iterator = handler.createMessage(systemPrompt, toolMessages)
		for await (const _chunk of iterator) {
			// consume
		}

		const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body as string)
		const toolParts = body.request.contents
			.flatMap((content: any) => content.parts || [])
			.filter((part: any) => part.functionResponse)
		const toolNames = toolParts.map((part: any) => part.functionResponse.name)
		expect(toolNames).toContain("read_file")
	})
})
