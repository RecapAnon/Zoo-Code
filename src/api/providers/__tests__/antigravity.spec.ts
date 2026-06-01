import type { Anthropic } from "@anthropic-ai/sdk"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: vi.fn(),
		},
	},
}))

// i18n stub: echo key plus a stringified payload so we can assert on key names without
// needing the real translation pipeline.
vi.mock("i18next", () => ({
	t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
}))

// Mock the OAuth manager at the same module path the handler imports it from.
// We do NOT use the safeWriteJson mock here because the handler never writes files;
// it only consumes ensureAuthenticated / forceRefresh.
vi.mock("../../../integrations/antigravity/oauth", () => ({
	antigravityOAuthManager: {
		ensureAuthenticated: vi.fn(),
		forceRefresh: vi.fn(),
		getAccessToken: vi.fn(),
	},
}))

import { AntigravityHandler } from "../antigravity"
import { antigravityOAuthManager } from "../../../integrations/antigravity/oauth"
import { antigravityModels, antigravityDefaultModelId, type AntigravityModelId } from "@roo-code/types"

const mockedManager = antigravityOAuthManager as unknown as {
	ensureAuthenticated: ReturnType<typeof vi.fn>
	forceRefresh: ReturnType<typeof vi.fn>
	getAccessToken: ReturnType<typeof vi.fn>
}

const originalFetch = globalThis.fetch
const fetchMock = vi.fn()

function buildSseStream(lines: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const line of lines) {
				controller.enqueue(new TextEncoder().encode(`${line}\n`))
			}
			controller.close()
		},
	})
}

function makeSseResponse(lines: string[], init: { status?: number; ok?: boolean } = {}): Response {
	const status = init.status ?? 200
	const ok = init.ok ?? (status >= 200 && status < 300)
	return {
		ok,
		status,
		body: buildSseStream(lines),
		text: async () => "",
		json: async () => ({}),
	} as unknown as Response
}

function makeJsonResponse(payload: unknown, init: { status?: number; ok?: boolean } = {}): Response {
	const status = init.status ?? 200
	const ok = init.ok ?? (status >= 200 && status < 300)
	return {
		ok,
		status,
		body: null,
		text: async () => JSON.stringify(payload),
		json: async () => payload,
	} as unknown as Response
}

function makeErrorResponse(status: number, bodyText = ""): Response {
	return {
		ok: false,
		status,
		body: null,
		text: async () => bodyText,
		json: async () => ({}),
	} as unknown as Response
}

beforeEach(() => {
	vi.clearAllMocks()
	fetchMock.mockReset()
	globalThis.fetch = fetchMock as unknown as typeof fetch

	mockedManager.ensureAuthenticated.mockResolvedValue({
		access_token: "live-token",
		refresh_token: "refresh-token",
		expires_in: 3600,
		timestamp: Date.now(),
		type: "antigravity",
	})
	mockedManager.forceRefresh.mockResolvedValue({
		access_token: "refreshed-token",
		refresh_token: "refresh-token",
		expires_in: 3600,
		timestamp: Date.now(),
		type: "antigravity",
	})
})

afterAll(() => {
	globalThis.fetch = originalFetch
})

// Use a real, registry-resident Antigravity model ID so the handler's "is this in the
// catalog?" check passes and `body.model` matches what the test asserts.
const TEST_MODEL_ID: AntigravityModelId = "gemini-3-pro-high"

function buildHandler(overrides: Record<string, unknown> = {}) {
	return new AntigravityHandler({
		apiModelId: TEST_MODEL_ID,
		antigravityProjectId: "test-project-123",
		...overrides,
	} as ConstructorParameters<typeof AntigravityHandler>[0])
}

const systemPrompt = "You are helpful."
const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello, world" }]

async function consume<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = []
	for await (const chunk of iter) {
		out.push(chunk)
	}
	return out
}

describe("AntigravityHandler.createMessage envelope + headers", () => {
	it("wraps the request in the Antigravity envelope with model, userAgent, requestType, project, requestId, and request.sessionId", async () => {
		fetchMock.mockResolvedValueOnce(
			makeSseResponse([
				'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}',
				"data: [DONE]",
			]),
		)

		const handler = buildHandler()
		await consume(handler.createMessage(systemPrompt, messages))

		expect(fetchMock).toHaveBeenCalledTimes(1)
		const [url, init] = fetchMock.mock.calls[0]
		expect(url).toBe("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse")
		expect((init as RequestInit).method).toBe("POST")

		const body = JSON.parse(String((init as RequestInit).body))
		expect(body.model).toBe(TEST_MODEL_ID)
		expect(body.userAgent).toBe("antigravity")
		expect(body.requestType).toBe("agent")
		expect(body.project).toBe("test-project-123")
		expect(typeof body.requestId).toBe("string")
		expect(body.requestId.startsWith("agent-")).toBe(true)
		expect(typeof body.request.sessionId).toBe("string")
		expect(body.request.sessionId.length).toBeGreaterThan(0)
	})

	it("omits safetySettings from the inner request (Antigravity rejects it)", async () => {
		fetchMock.mockResolvedValueOnce(makeSseResponse(["data: [DONE]"]))

		const handler = buildHandler()
		await consume(handler.createMessage(systemPrompt, messages))

		const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
		expect(body.request.safetySettings).toBeUndefined()
		// And it is not buried on the outer envelope either.
		expect((body as Record<string, unknown>).safetySettings).toBeUndefined()
	})

	it("includes the system instruction inside request.systemInstruction", async () => {
		fetchMock.mockResolvedValueOnce(makeSseResponse(["data: [DONE]"]))

		const handler = buildHandler()
		await consume(handler.createMessage(systemPrompt, messages))

		const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
		expect(body.request.systemInstruction.parts[0].text).toBe(systemPrompt)
	})

	it("sets Authorization: Bearer <token>, Content-Type: application/json, User-Agent, and Accept: text/event-stream for streaming", async () => {
		fetchMock.mockResolvedValueOnce(makeSseResponse(["data: [DONE]"]))

		const handler = buildHandler()
		await consume(handler.createMessage(systemPrompt, messages))

		const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
		expect(headers.Authorization).toBe("Bearer live-token")
		expect(headers["Content-Type"]).toBe("application/json")
		expect(headers["User-Agent"]).toBe("antigravity/1.21.9 darwin/arm64")
		expect(headers.Accept).toBe("text/event-stream")

		// Gemini CLI-only headers must not be set on Antigravity requests (design §7.3).
		expect(headers["X-Goog-Api-Client"]).toBeUndefined()
		expect(headers["Client-Metadata"]).toBeUndefined()
	})
})

describe("AntigravityHandler.createMessage streaming", () => {
	it("yields text chunks + usage metadata from a candidates-style SSE stream", async () => {
		fetchMock.mockResolvedValueOnce(
			makeSseResponse([
				'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}',
				'data: {"candidates":[{"content":{"parts":[{"text":" world"}]}}]}',
				"data: [DONE]",
			]),
		)

		const handler = buildHandler()
		const chunks = await consume(handler.createMessage(systemPrompt, messages))

		expect(chunks).toEqual(
			expect.arrayContaining([
				{ type: "text", text: "Hello" },
				{ type: "text", text: " world" },
				expect.objectContaining({ type: "usage", inputTokens: 5, outputTokens: 2 }),
			]),
		)
	})

	it("also accepts envelopes wrapped under `response` (Antigravity wraps Gemini responses)", async () => {
		fetchMock.mockResolvedValueOnce(
			makeSseResponse([
				'data: {"response":{"candidates":[{"content":{"parts":[{"text":"wrapped"}]}}]}}',
				"data: [DONE]",
			]),
		)

		const handler = buildHandler()
		const chunks = await consume(handler.createMessage(systemPrompt, messages))

		expect(chunks).toEqual(expect.arrayContaining([{ type: "text", text: "wrapped" }]))
	})

	it("emits tool_call_partial chunks for functionCall parts (tool-use round trip)", async () => {
		fetchMock.mockResolvedValueOnce(
			makeSseResponse([
				'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"a.txt"}}}]}}]}',
				"data: [DONE]",
			]),
		)

		const handler = buildHandler()
		const chunks = await consume(handler.createMessage(systemPrompt, messages))

		const toolChunks = chunks.filter((c) => c.type === "tool_call_partial")
		// Implementation yields a name-only then arguments-only partial per tool call.
		expect(toolChunks.length).toBeGreaterThanOrEqual(2)
		const named = toolChunks.find((c) => (c as { name?: string }).name === "read_file") as {
			id: string
		}
		expect(named).toBeDefined()
		expect(named.id).toBe("read_file-0")
		const argsChunk = toolChunks.find((c) => (c as { arguments?: string }).arguments !== undefined) as {
			arguments: string
		}
		expect(JSON.parse(argsChunk.arguments)).toEqual({ path: "a.txt" })
	})

	it("skips malformed SSE data lines and still surfaces valid chunks", async () => {
		// Suppress the implementation's console.error call for the malformed payload —
		// the deliberately bad line is part of the test.
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		fetchMock.mockResolvedValueOnce(
			makeSseResponse([
				"data: {not-valid-json",
				'data: {"candidates":[{"content":{"parts":[{"text":"after-bad"}]}}]}',
				"data: [DONE]",
			]),
		)

		const handler = buildHandler()
		const chunks = await consume(handler.createMessage(systemPrompt, messages))

		expect(chunks).toEqual(expect.arrayContaining([{ type: "text", text: "after-bad" }]))
		errSpy.mockRestore()
	})
})

describe("AntigravityHandler.createMessage 401 retry", () => {
	it("retries exactly once on 401 using forceRefresh and then succeeds", async () => {
		fetchMock
			.mockResolvedValueOnce(makeErrorResponse(401, "expired"))
			.mockResolvedValueOnce(makeSseResponse(["data: [DONE]"]))

		const handler = buildHandler()
		await consume(handler.createMessage(systemPrompt, messages))

		expect(mockedManager.ensureAuthenticated).toHaveBeenCalledTimes(1)
		expect(mockedManager.forceRefresh).toHaveBeenCalledTimes(1)
		expect(fetchMock).toHaveBeenCalledTimes(2)

		// Regression guard: the OAuth manager methods are no-arg singletons. Runtime must
		// never pass any path or option object through to the manager.
		expect(mockedManager.ensureAuthenticated).toHaveBeenCalledWith()
		expect(mockedManager.forceRefresh).toHaveBeenCalledWith()

		// Second request uses the refreshed access token.
		const secondHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>
		expect(secondHeaders.Authorization).toBe("Bearer refreshed-token")
	})

	it("does not infinite-loop on repeated 401s (one retry only, then propagates a classified error)", async () => {
		fetchMock
			.mockResolvedValueOnce(makeErrorResponse(401, "expired"))
			.mockResolvedValueOnce(makeErrorResponse(401, "still expired"))

		const handler = buildHandler()
		await expect(consume(handler.createMessage(systemPrompt, messages))).rejects.toThrow(/oauthLoadFailed/)

		expect(mockedManager.forceRefresh).toHaveBeenCalledTimes(1)
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it("surfaces tokenRefreshFailed when forceRefresh itself throws after a 401", async () => {
		fetchMock.mockResolvedValueOnce(makeErrorResponse(401, "expired"))
		mockedManager.forceRefresh.mockRejectedValueOnce(new Error("invalid_grant"))

		const handler = buildHandler()
		await expect(consume(handler.createMessage(systemPrompt, messages))).rejects.toThrow(/tokenRefreshFailed/)

		// We never reach a second fetch — the failed refresh aborts the flow.
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})
})

describe("AntigravityHandler.createMessage HTTP error classification", () => {
	it("maps HTTP 429 to common:errors.antigravity.rateLimitExceeded", async () => {
		fetchMock.mockResolvedValueOnce(makeErrorResponse(429, "Too Many Requests"))

		const handler = buildHandler()
		await expect(consume(handler.createMessage(systemPrompt, messages))).rejects.toThrow(/rateLimitExceeded/)
	})

	it("maps HTTP 400 to common:errors.antigravity.badRequest and includes body details", async () => {
		fetchMock.mockResolvedValueOnce(makeErrorResponse(400, "missing field foo"))

		const handler = buildHandler()
		// Single iteration only — the implementation embeds the body text in the i18n payload params,
		// so one regex pair covers both the key and the detail substring.
		await expect(consume(handler.createMessage(systemPrompt, messages))).rejects.toThrow(
			/badRequest.*missing field foo/,
		)
	})

	it("maps an unclassified 5xx to common:errors.antigravity.apiError", async () => {
		fetchMock.mockResolvedValueOnce(makeErrorResponse(503, "service unavailable"))

		const handler = buildHandler()
		await expect(consume(handler.createMessage(systemPrompt, messages))).rejects.toThrow(/apiError/)
	})
})

describe("AntigravityHandler.createMessage configuration errors", () => {
	it("throws projectIdMissing when antigravityProjectId is absent", async () => {
		const handler = buildHandler({ antigravityProjectId: undefined })
		await expect(consume(handler.createMessage(systemPrompt, messages))).rejects.toThrow(/projectIdMissing/)
		// And we never hit the API or the OAuth manager.
		expect(mockedManager.ensureAuthenticated).not.toHaveBeenCalled()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("throws projectIdMissing when antigravityProjectId is only whitespace", async () => {
		const handler = buildHandler({ antigravityProjectId: "   " })
		await expect(consume(handler.createMessage(systemPrompt, messages))).rejects.toThrow(/projectIdMissing/)
	})
})

describe("AntigravityHandler session ID (DD-2)", () => {
	it("produces a deterministic session ID for the same first-user-turn text", async () => {
		// Two identical createMessage calls with the same first-user text must produce the same
		// sessionId. We capture the request body each time and compare.
		fetchMock.mockResolvedValue(makeSseResponse(["data: [DONE]"]))

		const handler1 = buildHandler()
		await consume(handler1.createMessage(systemPrompt, messages))

		const handler2 = buildHandler()
		await consume(handler2.createMessage(systemPrompt, messages))

		const sessionA = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).request.sessionId
		const sessionB = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body)).request.sessionId

		expect(sessionA).toBe(sessionB)
		// And the deterministic form is "-<decimal digits>" per the Go algorithm.
		expect(sessionA).toMatch(/^-\d+$/)
	})

	it("produces different session IDs for different first-user-turn text", async () => {
		fetchMock.mockResolvedValue(makeSseResponse(["data: [DONE]"]))

		const handler = buildHandler()
		await consume(handler.createMessage(systemPrompt, [{ role: "user", content: "Hello, world" }]))
		await consume(handler.createMessage(systemPrompt, [{ role: "user", content: "A different message" }]))

		const sessionA = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).request.sessionId
		const sessionB = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body)).request.sessionId
		expect(sessionA).not.toBe(sessionB)
	})
})

describe("AntigravityHandler.completePrompt", () => {
	it("uses the non-streaming :generateContent endpoint with Accept: application/json", async () => {
		fetchMock.mockResolvedValueOnce(
			makeJsonResponse({
				candidates: [{ content: { parts: [{ text: "Prompt response" }] } }],
			}),
		)

		const handler = buildHandler()
		const result = await handler.completePrompt("Hello prompt")
		expect(result).toBe("Prompt response")

		const [url, init] = fetchMock.mock.calls[0]
		expect(url).toBe("https://cloudcode-pa.googleapis.com/v1internal:generateContent")
		expect((init as RequestInit).method).toBe("POST")
		const headers = (init as RequestInit).headers as Record<string, string>
		expect(headers.Accept).toBe("application/json")
		expect(headers["Content-Type"]).toBe("application/json")
		expect(headers.Authorization).toBe("Bearer live-token")
	})

	it("wraps completePrompt body in the same Antigravity envelope as streaming", async () => {
		fetchMock.mockResolvedValueOnce(
			makeJsonResponse({
				candidates: [{ content: { parts: [{ text: "ok" }] } }],
			}),
		)

		const handler = buildHandler()
		await handler.completePrompt("Prompt body")

		const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
		expect(body.model).toBe(TEST_MODEL_ID)
		expect(body.userAgent).toBe("antigravity")
		expect(body.requestType).toBe("agent")
		expect(body.project).toBe("test-project-123")
		expect(typeof body.request.sessionId).toBe("string")
		expect(body.request.contents[0].parts[0].text).toBe("Prompt body")
	})

	it("concatenates parts.text from a `response`-wrapped non-streaming payload", async () => {
		fetchMock.mockResolvedValueOnce(
			makeJsonResponse({
				response: {
					candidates: [{ content: { parts: [{ text: "alpha" }, { text: "beta" }] } }],
				},
			}),
		)

		const handler = buildHandler()
		const result = await handler.completePrompt("any")
		expect(result).toBe("alphabeta")
	})

	it("wraps non-streaming HTTP errors in completionError", async () => {
		fetchMock.mockResolvedValueOnce(makeErrorResponse(500, "boom"))

		const handler = buildHandler()
		await expect(handler.completePrompt("any")).rejects.toThrow(/completionError/)
	})
})

describe("AntigravityHandler.countTokens", () => {
	it("falls back to BaseProvider's tiktoken count and returns a positive value", async () => {
		const handler = buildHandler()
		const total = await handler.countTokens([{ type: "text", text: "Hello world" }])
		expect(total).toBeGreaterThan(0)
	})
})

describe("AntigravityHandler.getModel custom-model-id pass-through", () => {
	it("resolves a known apiModelId to its full ModelInfo from antigravityModels", () => {
		const handler = buildHandler({ apiModelId: "gemini-3-pro-high" })
		const model = (
			handler as unknown as {
				getModel: () => { id: string; info: (typeof antigravityModels)[AntigravityModelId] }
			}
		).getModel()
		expect(model.id).toBe("gemini-3-pro-high")
		expect(model.info).toEqual(expect.objectContaining(antigravityModels["gemini-3-pro-high"]))
	})

	it("honors a custom/unknown apiModelId verbatim instead of silently falling back to default", () => {
		const customId = "gemini-4.0-ultra-preview"
		const handler = buildHandler({ apiModelId: customId })
		const model = (
			handler as unknown as { getModel: () => { id: string; info: Record<string, unknown> } }
		).getModel()
		expect(model.id).toBe(customId)
		expect(model.id).not.toBe(antigravityDefaultModelId)
		expect(model.info).toBeDefined()
	})

	it("honors a non-Gemini custom apiModelId verbatim (claude-*, gpt-*) — Antigravity spans multiple families", () => {
		for (const customId of ["claude-future-preview", "gpt-experimental-2099"]) {
			const handler = buildHandler({ apiModelId: customId })
			const model = (handler as unknown as { getModel: () => { id: string } }).getModel()
			expect(model.id).toBe(customId)
			expect(model.id).not.toBe(antigravityDefaultModelId)
		}
	})

	it("falls back to antigravityDefaultModelId for empty / whitespace-only apiModelId", () => {
		for (const emptyId of ["", "   "]) {
			const handler = buildHandler({ apiModelId: emptyId })
			const model = (handler as unknown as { getModel: () => { id: string } }).getModel()
			expect(model.id).toBe(antigravityDefaultModelId)
		}
	})

	it("clears unverifiable cost metadata (input/output/cacheReads/cacheWrites/tiers) on a custom model's ModelInfo", () => {
		const handler = buildHandler({ apiModelId: "gemini-4.0-ultra-preview" })
		const model = (
			handler as unknown as {
				getModel: () => {
					info: {
						inputPrice?: number
						outputPrice?: number
						cacheReadsPrice?: number
						cacheWritesPrice?: number
						tiers?: unknown
					}
				}
			}
		).getModel()
		expect(model.info.inputPrice).toBeUndefined()
		expect(model.info.outputPrice).toBeUndefined()
		expect(model.info.cacheReadsPrice).toBeUndefined()
		expect(model.info.cacheWritesPrice).toBeUndefined()
		expect(model.info.tiers).toBeUndefined()
	})

	it("does not treat Object prototype keys (e.g. 'toString') as known model ids", () => {
		// `"toString" in antigravityModels` is true via the prototype chain; an own-property
		// check (Object.hasOwn) prevents resolving info to a function. The id still flows
		// through the custom-id branch and is honored verbatim — but importantly the info
		// is a real ModelInfo, not the prototype's `Function.prototype.toString`.
		const handler = buildHandler({ apiModelId: "toString" })
		const model = (
			handler as unknown as { getModel: () => { id: string; info: Record<string, unknown> } }
		).getModel()
		expect(model.id).toBe("toString")
		expect(typeof model.info).toBe("object")
		expect(typeof (model.info as unknown as () => unknown)).not.toBe("function")
	})

	it("passes a custom apiModelId through to the Antigravity request envelope unchanged", async () => {
		fetchMock.mockResolvedValueOnce(makeSseResponse(["data: [DONE]"]))

		const customId = "gemini-4.0-ultra-preview"
		const handler = buildHandler({ apiModelId: customId })
		await consume(handler.createMessage(systemPrompt, messages))

		const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
		expect(body.model).toBe(customId)
	})
})

describe("AntigravityHandler.createMessage tool definitions", () => {
	// Minimal OpenAI ChatCompletionTool literals — the handler reads only
	// `function.name`, `function.description`, and `function.parameters`.
	const askFollowupTool = {
		type: "function" as const,
		function: {
			name: "ask_followup_question",
			description: "Ask the user a clarifying question.",
			parameters: {
				type: "object",
				properties: {
					question: { type: "string" },
				},
				required: ["question"],
			},
		},
	}

	// Regression for: "Invalid JSON payload received. Unknown name \"custom\" at
	// 'request.tools[0]': Cannot find field" returned by cloudcode-pa.googleapis.com
	// when Claude-family Antigravity tools were wrapped in `{ custom: { ... } }`.
	// Both model families must send the unified Gemini-style envelope.

	it("emits Claude-family tools using the unified Gemini-style functionDeclarations envelope (no custom wrapper)", async () => {
		fetchMock.mockResolvedValueOnce(makeSseResponse(["data: [DONE]"]))

		const handler = buildHandler({ apiModelId: "claude-sonnet-4-6" })
		await consume(
			handler.createMessage(systemPrompt, messages, {
				taskId: "t",
				tools: [askFollowupTool],
			}),
		)

		const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
		expect(Array.isArray(body.request.tools)).toBe(true)
		expect(body.request.tools.length).toBe(1)

		const firstTool = body.request.tools[0]
		// Hard regression guard: the field name `custom` must never appear in tools[*]
		// because cloudcode-pa rejects it with HTTP 400 "Unknown name 'custom'".
		expect(firstTool.custom).toBeUndefined()
		expect(firstTool.functionDeclarations).toBeDefined()
		expect(firstTool.functionDeclarations).toHaveLength(1)
		expect(firstTool.functionDeclarations[0].name).toBe("ask_followup_question")
		expect(firstTool.functionDeclarations[0].description).toBe("Ask the user a clarifying question.")
		// Wire-format invariant: the parameter schema is emitted under `parameters`,
		// NOT `parametersJsonSchema`. The cloudcode-pa endpoint silently drops the
		// schema for the latter on non-pro Gemini and gpt-oss models, which causes
		// the model to emit `args: {}` and trips the native tool-call parser with
		// "missing nativeArgs".
		expect(firstTool.functionDeclarations[0].parameters).toEqual({
			type: "object",
			properties: { question: { type: "string" } },
			required: ["question"],
		})
		expect(firstTool.functionDeclarations[0].parametersJsonSchema).toBeUndefined()
		// And `input_schema` (the Anthropic key) must not leak into the wire format.
		expect(firstTool.functionDeclarations[0].input_schema).toBeUndefined()
	})

	it("emits the same Gemini-style functionDeclarations envelope for gpt-oss-120b-medium (no custom wrapper)", async () => {
		// Regression coverage for the user-reported failure on gpt-oss-120b-medium:
		// the non-Claude branch must continue to produce the upstream-supported shape
		// and must not leak any `custom` field into tools[*].
		fetchMock.mockResolvedValueOnce(makeSseResponse(["data: [DONE]"]))

		const handler = buildHandler({ apiModelId: "gpt-oss-120b-medium" })
		await consume(
			handler.createMessage(systemPrompt, messages, {
				taskId: "t",
				tools: [askFollowupTool],
			}),
		)

		const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
		expect(Array.isArray(body.request.tools)).toBe(true)
		const firstTool = body.request.tools[0]
		expect(firstTool.custom).toBeUndefined()
		expect(firstTool.functionDeclarations).toBeDefined()
		expect(firstTool.functionDeclarations[0].name).toBe("ask_followup_question")
		expect(firstTool.functionDeclarations[0].parameters).toEqual({
			type: "object",
			properties: { question: { type: "string" } },
			required: ["question"],
		})
		expect(firstTool.functionDeclarations[0].parametersJsonSchema).toBeUndefined()
	})

	it("keeps the Gemini-style functionDeclarations envelope for Gemini-family Antigravity models", async () => {
		fetchMock.mockResolvedValueOnce(makeSseResponse(["data: [DONE]"]))

		const handler = buildHandler({ apiModelId: "gemini-3-pro-high" })
		await consume(
			handler.createMessage(systemPrompt, messages, {
				taskId: "t",
				tools: [askFollowupTool],
			}),
		)

		const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
		expect(Array.isArray(body.request.tools)).toBe(true)
		const firstTool = body.request.tools[0]
		expect(firstTool.functionDeclarations).toBeDefined()
		expect(firstTool.custom).toBeUndefined()
		expect(firstTool.functionDeclarations[0].name).toBe("ask_followup_question")
		expect(firstTool.functionDeclarations[0].parameters).toEqual({
			type: "object",
			properties: { question: { type: "string" } },
			required: ["question"],
		})
		expect(firstTool.functionDeclarations[0].parametersJsonSchema).toBeUndefined()
	})

	it("never serializes a `custom` discriminator anywhere in the outgoing payload (hard regression)", async () => {
		// Defense-in-depth scan against the upstream rejection
		// "Unknown name 'custom' at 'request.tools[0]'". This guards against future
		// refactors that might reintroduce the bad envelope under a different code path.
		fetchMock.mockResolvedValueOnce(makeSseResponse(["data: [DONE]"]))

		const handler = buildHandler({ apiModelId: "claude-sonnet-4-6" })
		await consume(
			handler.createMessage(systemPrompt, messages, {
				taskId: "t",
				tools: [askFollowupTool],
			}),
		)

		const rawBody = String((fetchMock.mock.calls[0][1] as RequestInit).body)
		// Whole-payload textual guard: no "custom" key may appear in the serialized
		// request — the live server rejects it. Matching on the exact JSON key form
		// avoids accidental matches inside user-supplied strings.
		expect(rawBody).not.toContain('"custom":')
	})

	it("passes a Claude tool with no parameters through with parametersJsonSchema undefined (no custom wrapper)", async () => {
		fetchMock.mockResolvedValueOnce(makeSseResponse(["data: [DONE]"]))

		const handler = buildHandler({ apiModelId: "claude-sonnet-4-6" })
		const noParamsTool = {
			type: "function" as const,
			function: {
				name: "ping",
				description: "no-arg tool",
				// parameters intentionally omitted
			},
		} as unknown as typeof askFollowupTool
		await consume(
			handler.createMessage(systemPrompt, messages, {
				taskId: "t",
				tools: [noParamsTool],
			}),
		)

		const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
		const firstTool = body.request.tools[0]
		expect(firstTool.custom).toBeUndefined()
		expect(firstTool.functionDeclarations[0].name).toBe("ping")
		// When upstream tools omit `parameters`, the field is simply absent on the wire;
		// the server tolerates a missing schema (it is the unknown `custom` discriminator
		// that triggered the original 400, not the absence of a schema).
		expect(firstTool.functionDeclarations[0].parameters).toBeUndefined()
		expect(firstTool.functionDeclarations[0].parametersJsonSchema).toBeUndefined()
	})

	it("does not attach a tools array when no tools are declared", async () => {
		fetchMock.mockResolvedValueOnce(makeSseResponse(["data: [DONE]"]))

		const handler = buildHandler({ apiModelId: "claude-sonnet-4-6" })
		await consume(handler.createMessage(systemPrompt, messages))

		const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
		expect(body.request.tools).toBeUndefined()
	})

	// Regression suite for "gemini-3.5-flash-low repeatedly emits functionCall
	// with args: {}". Root cause: the upstream cloudcode-pa endpoint silently
	// dropped tool parameter schemas when keywords it does not understand were
	// present (`additionalProperties`, multi-type arrays, `minItems`, `maxItems`,
	// `pattern`, ...), AND when the field was named `parametersJsonSchema`
	// instead of `parameters`. The model then saw a contract-less tool and
	// emitted empty args, which `NativeToolCallParser.parseToolCall` rejects
	// with "Invalid tool call for '<name>': missing nativeArgs."
	describe("schema sanitization for non-pro Gemini family (gemini-3.5-flash-low regression)", () => {
		const askFollowupToolFull = {
			type: "function" as const,
			function: {
				name: "ask_followup_question",
				description: "Ask the user a clarifying question.",
				parameters: {
					$schema: "http://json-schema.org/draft-07/schema#",
					title: "AskFollowup",
					type: "object",
					additionalProperties: false,
					properties: {
						question: {
							type: "string",
							description: "The question",
							minLength: 1,
						},
						follow_up: {
							type: "array",
							minItems: 1,
							maxItems: 4,
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									text: { type: "string" },
									mode: {
										type: ["string", "null"],
										description: "Optional mode",
									},
								},
								required: ["text", "mode"],
							},
						},
					},
					required: ["question", "follow_up"],
				},
			},
		} as const

		it("renames parametersJsonSchema to parameters on the wire for gemini-3.5-flash-low", async () => {
			fetchMock.mockResolvedValueOnce(makeSseResponse(["data: [DONE]"]))

			const handler = buildHandler({ apiModelId: "gemini-3.5-flash-low" })
			await consume(
				handler.createMessage(systemPrompt, messages, {
					taskId: "t",
					tools: [askFollowupToolFull as any],
				}),
			)

			const rawBody = String((fetchMock.mock.calls[0][1] as RequestInit).body)
			// Whole-payload guard: the legacy field name must never appear on the
			// wire for any model. The Go reference's `util.RenameKey` walk would
			// have removed it, so we never emit it in the first place.
			expect(rawBody).not.toContain('"parametersJsonSchema"')

			const body = JSON.parse(rawBody)
			const decl = body.request.tools[0].functionDeclarations[0]
			expect(decl.parameters).toBeDefined()
			expect(decl.parametersJsonSchema).toBeUndefined()
		})

		it("strips keywords the Gemini schema dialect does not understand (additionalProperties, $schema, title, minItems/maxItems, minLength)", async () => {
			fetchMock.mockResolvedValueOnce(makeSseResponse(["data: [DONE]"]))

			const handler = buildHandler({ apiModelId: "gemini-3.5-flash-low" })
			await consume(
				handler.createMessage(systemPrompt, messages, {
					taskId: "t",
					tools: [askFollowupToolFull as any],
				}),
			)

			const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
			const params = body.request.tools[0].functionDeclarations[0].parameters

			// Structural keywords stripped at every level.
			expect(params.$schema).toBeUndefined()
			expect(params.title).toBeUndefined()
			expect(params.additionalProperties).toBeUndefined()
			// Constraint keywords stripped from leaf nodes.
			expect(params.properties.question.minLength).toBeUndefined()
			expect(params.properties.follow_up.minItems).toBeUndefined()
			expect(params.properties.follow_up.maxItems).toBeUndefined()
			// And from nested items objects.
			expect(params.properties.follow_up.items.additionalProperties).toBeUndefined()

			// `required` is preserved (these are the contract the model needs).
			expect(params.required).toEqual(["question", "follow_up"])
			expect(params.properties.follow_up.items.required).toEqual(["text", "mode"])

			// Constraint hints are surfaced into description so the model still
			// sees the intent.
			expect(typeof params.properties.question.description).toBe("string")
			expect(params.properties.question.description).toContain("minLength: 1")
			// follow_up had `minItems`/`maxItems` constraints; the sanitizer drops
			// the keywords and appends a description hint in their place.
			expect(typeof params.properties.follow_up.description).toBe("string")
			expect(params.properties.follow_up.description).toContain("minItems: 1")
			expect(params.properties.follow_up.description).toContain("maxItems: 4")
		})

		it('flattens type: ["string", "null"] arrays to a single type for the Gemini dialect (no nullable, no array)', async () => {
			fetchMock.mockResolvedValueOnce(makeSseResponse(["data: [DONE]"]))

			const handler = buildHandler({ apiModelId: "gemini-3.5-flash-low" })
			await consume(
				handler.createMessage(systemPrompt, messages, {
					taskId: "t",
					tools: [askFollowupToolFull as any],
				}),
			)

			const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
			const modeField =
				body.request.tools[0].functionDeclarations[0].parameters.properties.follow_up.items.properties.mode
			expect(modeField.type).toBe("string")
			// Gemini dialect drops `nullable` entirely.
			expect(modeField.nullable).toBeUndefined()
		})

		it("keeps nullable for the Antigravity dialect (gemini-3-pro-high) when flattening type arrays", async () => {
			fetchMock.mockResolvedValueOnce(makeSseResponse(["data: [DONE]"]))

			const handler = buildHandler({ apiModelId: "gemini-3-pro-high" })
			await consume(
				handler.createMessage(systemPrompt, messages, {
					taskId: "t",
					tools: [askFollowupToolFull as any],
				}),
			)

			const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
			const modeField =
				body.request.tools[0].functionDeclarations[0].parameters.properties.follow_up.items.properties.mode
			expect(modeField.type).toBe("string")
			expect(modeField.nullable).toBe(true)
		})

		it("preserves required at the root and at nested levels after sanitization", async () => {
			// Defense-in-depth: the bug surfaces when the model emits args: {},
			// which is far more likely if the schema's `required` array is lost.
			fetchMock.mockResolvedValueOnce(makeSseResponse(["data: [DONE]"]))

			const handler = buildHandler({ apiModelId: "gemini-3.5-flash-low" })
			await consume(
				handler.createMessage(systemPrompt, messages, {
					taskId: "t",
					tools: [askFollowupToolFull as any],
				}),
			)

			const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
			const params = body.request.tools[0].functionDeclarations[0].parameters
			expect(params.required).toEqual(["question", "follow_up"])
		})

		it("does not mutate the caller-supplied metadata.tools (sanitizer is pure)", async () => {
			fetchMock.mockResolvedValueOnce(makeSseResponse(["data: [DONE]"]))

			const handler = buildHandler({ apiModelId: "gemini-3.5-flash-low" })
			const original = JSON.parse(JSON.stringify(askFollowupToolFull))
			await consume(
				handler.createMessage(systemPrompt, messages, {
					taskId: "t",
					tools: [askFollowupToolFull as any],
				}),
			)
			expect(askFollowupToolFull).toEqual(original)
		})
	})
})
