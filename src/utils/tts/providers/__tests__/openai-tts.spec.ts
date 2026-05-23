// npx vitest run utils/tts/providers/__tests__/openai-tts.spec.ts

import axios from "axios"

import { OpenAiTtsProvider } from "../openai-tts"
import type { ContextProxy } from "../../../../core/config/ContextProxy"

vi.mock("axios", () => ({
	default: {
		post: vi.fn(),
		get: vi.fn(),
	},
}))

const mockedAxios = axios as unknown as { post: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> }

// Minimal fake ContextProxy that exposes a mutable key/value map so tests can
// simulate the user changing settings after the provider has been constructed.
function makeProxy(initial: Record<string, unknown> = {}): {
	proxy: ContextProxy
	store: Record<string, unknown>
} {
	const store: Record<string, unknown> = { ...initial }
	const proxy = {
		getValue: (key: string) => store[key],
	} as unknown as ContextProxy
	return { proxy, store }
}

describe("OpenAiTtsProvider", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockedAxios.post.mockResolvedValue({ data: Buffer.from("audio") })
	})

	describe("synthesizeSpeech base URL handling", () => {
		it("uses the configured custom base URL", async () => {
			const { proxy } = makeProxy({
				openAiTtsApiKey: "sk-test",
				openAiTtsBaseUrl: "http://192.168.1.204:9999/v1",
			})
			const provider = new OpenAiTtsProvider(proxy)

			await provider.synthesizeSpeech("hello", "alloy", 1)

			expect(mockedAxios.post).toHaveBeenCalledTimes(1)
			const [url, body, config] = mockedAxios.post.mock.calls[0]
			expect(url).toBe("http://192.168.1.204:9999/v1/audio/speech")
			expect(body).toMatchObject({ input: "hello", voice: "alloy", speed: 1 })
			expect(config.headers.Authorization).toBe("Bearer sk-test")
		})

		it("falls back to the default OpenAI base URL when none is configured", async () => {
			const { proxy } = makeProxy({ openAiTtsApiKey: "sk-test" })
			const provider = new OpenAiTtsProvider(proxy)

			await provider.synthesizeSpeech("hi", "nova", 1)

			const [url] = mockedAxios.post.mock.calls[0]
			expect(url).toBe("https://api.openai.com/v1/audio/speech")
		})

		it("trims a trailing slash from the custom base URL", async () => {
			const { proxy } = makeProxy({
				openAiTtsApiKey: "sk-test",
				openAiTtsBaseUrl: "http://192.168.1.204:9999/v1/",
			})
			const provider = new OpenAiTtsProvider(proxy)

			await provider.synthesizeSpeech("hi", "alloy", 1)

			const [url] = mockedAxios.post.mock.calls[0]
			expect(url).toBe("http://192.168.1.204:9999/v1/audio/speech")
		})

		it("treats an empty/whitespace base URL as unset and uses the default", async () => {
			const { proxy } = makeProxy({
				openAiTtsApiKey: "sk-test",
				openAiTtsBaseUrl: "   ",
			})
			const provider = new OpenAiTtsProvider(proxy)

			await provider.synthesizeSpeech("hi", "alloy", 1)

			const [url] = mockedAxios.post.mock.calls[0]
			expect(url).toBe("https://api.openai.com/v1/audio/speech")
		})

		it("throws a configuration error when no API key is set", async () => {
			const { proxy } = makeProxy({ openAiTtsBaseUrl: "http://192.168.1.204:9999/v1" })
			const provider = new OpenAiTtsProvider(proxy)

			await expect(provider.synthesizeSpeech("hi", "alloy", 1)).rejects.toThrow(/not configured/i)
			expect(mockedAxios.post).not.toHaveBeenCalled()
		})
	})

	describe("runtime settings reconfiguration", () => {
		it("picks up base URL updates made after construction (no extension reload)", async () => {
			// This regression test would FAIL before the fix because the
			// provider cached baseUrl/apiKey in its constructor and never
			// re-read them from the ContextProxy.
			const { proxy, store } = makeProxy({
				openAiTtsApiKey: "sk-old",
				openAiTtsBaseUrl: "https://api.openai.com/v1",
			})
			const provider = new OpenAiTtsProvider(proxy)

			// Sanity: first call uses the original base URL.
			await provider.synthesizeSpeech("first", "alloy", 1)
			expect(mockedAxios.post.mock.calls[0][0]).toBe("https://api.openai.com/v1/audio/speech")

			// Simulate the user updating settings via the webview; persistence
			// goes through ContextProxy.setValue, so getValue returns the new
			// values on subsequent reads.
			store.openAiTtsBaseUrl = "http://192.168.1.204:9999/v1"
			store.openAiTtsApiKey = "sk-new"

			await provider.synthesizeSpeech("second", "alloy", 1)
			const [secondUrl, , secondConfig] = mockedAxios.post.mock.calls[1]
			expect(secondUrl).toBe("http://192.168.1.204:9999/v1/audio/speech")
			expect(secondConfig.headers.Authorization).toBe("Bearer sk-new")
		})

		it("isConfigured reflects API key changes without reconstruction", () => {
			const { proxy, store } = makeProxy({})
			const provider = new OpenAiTtsProvider(proxy)
			expect(provider.isConfigured()).toBe(false)

			store.openAiTtsApiKey = "sk-late"
			expect(provider.isConfigured()).toBe(true)
		})
	})
})
