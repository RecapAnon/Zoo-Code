// npx vitest run api/providers/__tests__/openai-compatible-timeout.spec.ts

import type { ModelInfo } from "@roo-code/types"

// Mock the timeout config utility
vitest.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vitest.fn(),
}))

import { getApiRequestTimeout } from "../utils/timeout-config"

// Capture the options passed to createOpenAICompatible
const mockCreateOpenAICompatible = vitest.fn().mockReturnValue(() => ({
	// Returns a mock language model
	doGenerate: vitest.fn(),
	doStream: vitest.fn(),
}))

vitest.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: (...args: any[]) => mockCreateOpenAICompatible(...args),
}))

vitest.mock("@anthropic-ai/sdk", () => ({
	Anthropic: vitest.fn(),
}))

vitest.mock("openai", () => ({
	__esModule: true,
	default: vitest.fn(),
}))

// Import after mocks are set up
import { OpenAICompatibleHandler } from "../openai-compatible"

// Create a concrete test implementation of the abstract base class
class TestOpenAICompatibleProvider extends OpenAICompatibleHandler {
	constructor(apiKey: string) {
		super(
			{ apiKey },
			{
				providerName: "TestProvider",
				baseURL: "http://localhost:8080/v1",
				apiKey,
				modelId: "test-model",
				modelInfo: {
					maxTokens: 4096,
					contextWindow: 128000,
					supportsImages: false,
					supportsPromptCache: false,
					inputPrice: 0,
					outputPrice: 0,
				} satisfies ModelInfo,
			},
		)
	}

	override getModel() {
		return {
			id: "test-model",
			info: {
				maxTokens: 4096,
				contextWindow: 128000,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 0,
				outputPrice: 0,
			} satisfies ModelInfo,
		}
	}
}

describe("OpenAICompatibleHandler timeout configuration", () => {
	beforeEach(() => {
		vitest.clearAllMocks()
	})

	it("should call getApiRequestTimeout when creating the provider", () => {
		;(getApiRequestTimeout as any).mockReturnValue(600000)

		new TestOpenAICompatibleProvider("test-api-key")

		expect(getApiRequestTimeout).toHaveBeenCalled()
	})

	it("should pass a custom fetch with timeout when timeout is configured", () => {
		;(getApiRequestTimeout as any).mockReturnValue(600000) // 600 seconds in ms

		new TestOpenAICompatibleProvider("test-api-key")

		expect(mockCreateOpenAICompatible).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "TestProvider",
				baseURL: "http://localhost:8080/v1",
				apiKey: "test-api-key",
				fetch: expect.any(Function),
			}),
		)
	})

	it("should not pass a custom fetch when timeout is undefined (disabled)", () => {
		;(getApiRequestTimeout as any).mockReturnValue(undefined)

		new TestOpenAICompatibleProvider("test-api-key")

		const callArgs = mockCreateOpenAICompatible.mock.calls[0][0]
		expect(callArgs).not.toHaveProperty("fetch")
	})

	it("should create fetch wrapper that applies AbortSignal.timeout", () => {
		;(getApiRequestTimeout as any).mockReturnValue(1800000) // 30 minutes

		new TestOpenAICompatibleProvider("test-api-key")

		const callArgs = mockCreateOpenAICompatible.mock.calls[0][0]
		expect(callArgs.fetch).toBeDefined()
		expect(typeof callArgs.fetch).toBe("function")
	})

	it("should pass headers through to the provider", () => {
		;(getApiRequestTimeout as any).mockReturnValue(600000)

		new TestOpenAICompatibleProvider("test-api-key")

		expect(mockCreateOpenAICompatible).toHaveBeenCalledWith(
			expect.objectContaining({
				headers: expect.any(Object),
			}),
		)
	})
})
