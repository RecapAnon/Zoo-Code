// npx vitest run api/providers/__tests__/gemini-oauth.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"

// Mock TelemetryService - must come before other imports
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: vi.fn(),
		},
	},
}))

import { GeminiOAuthHandler } from "../gemini-oauth"
import type { ApiHandlerOptions } from "../../../shared/api"
import { geminiOAuthManager } from "../../../integrations/gemini-oauth/oauth"

vi.mock("../../../integrations/gemini-oauth/oauth", () => ({
	geminiOAuthManager: {
		ensureAuthenticated: vi.fn(),
		getAuthClient: vi.fn(),
	},
}))

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
		;(geminiOAuthManager.ensureAuthenticated as any).mockResolvedValue({
			access_token: "test-access-token",
			expiry_date: Date.now() + 3600 * 1000,
		})
		;(geminiOAuthManager.getAuthClient as any).mockReturnValue({
			request: mockFetch,
		})
		options = {
			apiModelId: "gemini-2.5-pro",
			geminiOauthPath: "~/.gemini/oauth_creds.json",
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
			data: stream,
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
			expect.objectContaining({
				url: "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent",
				method: "POST",
				params: { alt: "sse" },
				headers: expect.objectContaining({
					Accept: "text/event-stream",
				}),
				data: expect.any(String),
			}),
		)

		const body = JSON.parse((mockFetch.mock.calls[0][0] as any).data as string)
		expect(body.project).toBe("test-project")
		expect(body.model).toBe("gemini-2.5-pro")
		expect(body.request.systemInstruction.parts[0].text).toBe(systemPrompt)
		expect(body.request.contents[0].role).toBe("user")
		expect(body.request.generationConfig.thinkingConfig.include_thoughts).toBe(true)
	})

	it("uses generateContent for completePrompt", async () => {
		mockFetch.mockResolvedValue({
			data: {
				candidates: [{ content: { parts: [{ text: "Prompt response" }] } }],
			},
		})

		const result = await handler.completePrompt("Hello prompt")
		expect(result).toBe("Prompt response")
		expect(mockFetch).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://cloudcode-pa.googleapis.com/v1internal:generateContent",
				method: "POST",
				headers: expect.objectContaining({
					Accept: "application/json",
				}),
				data: expect.any(String),
			}),
		)
	})

	it("uses local token counting for countTokens", async () => {
		const total = await handler.countTokens([{ type: "text", text: "Hello" }])
		expect(total).toBeGreaterThan(0)
	})

	it("maps tool_result ids to tool names when history lacks tool_use", async () => {
		const toolMessages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "list_files-0", content: "ok" }],
			},
		]
		const stream = buildSseStream(["data: [DONE]"])
		mockFetch.mockResolvedValue({ data: stream })

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

		const body = JSON.parse((mockFetch.mock.calls[0][0] as any).data as string)
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
		mockFetch.mockResolvedValue({ data: stream })

		const iterator = handler.createMessage(systemPrompt, toolMessages)
		for await (const _chunk of iterator) {
			// consume
		}

		const body = JSON.parse((mockFetch.mock.calls[0][0] as any).data as string)
		const toolParts = body.request.contents
			.flatMap((content: any) => content.parts || [])
			.filter((part: any) => part.functionResponse)
		const toolNames = toolParts.map((part: any) => part.functionResponse.name)
		expect(toolNames).toContain("read_file")
	})
})
