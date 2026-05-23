import axios from "axios"
import { TtsProviderInterface, TtsVoice, TTS_PRICING } from "../types"
import { ContextProxy } from "../../../core/config/ContextProxy"

const DEFAULT_OPENAI_TTS_BASE_URL = "https://api.openai.com/v1"
const DEFAULT_OPENAI_VOICE = "alloy"

const OPENAI_VOICES: TtsVoice[] = [
	{ id: "alloy", name: "Alloy", languageCode: "en-US" },
	{ id: "echo", name: "Echo", languageCode: "en-US" },
	{ id: "fable", name: "Fable", languageCode: "en-US" },
	{ id: "onyx", name: "Onyx", languageCode: "en-US" },
	{ id: "nova", name: "Nova", languageCode: "en-US" },
	{ id: "shimmer", name: "Shimmer", languageCode: "en-US" },
]

export class OpenAiTtsProvider implements TtsProviderInterface {
	constructor(private contextProxy: ContextProxy) {}

	private getApiKey(): string | undefined {
		return this.contextProxy.getValue("openAiTtsApiKey" as any) as string | undefined
	}

	private getBaseUrl(): string {
		const configured = this.contextProxy.getValue("openAiTtsBaseUrl" as any) as string | undefined
		const candidate = configured && configured.trim().length > 0 ? configured : DEFAULT_OPENAI_TTS_BASE_URL
		// Normalize: strip trailing slash so callers can safely append a path.
		return candidate.replace(/\/$/, "")
	}

	async getVoices(): Promise<TtsVoice[]> {
		if (!this.isConfigured()) {
			return []
		}
		return OPENAI_VOICES
	}

	async synthesizeSpeech(text: string, voiceId: string, speed: number): Promise<Buffer> {
		const apiKey = this.getApiKey()
		if (!apiKey) {
			throw new Error("OpenAI TTS is not configured")
		}

		const baseUrl = this.getBaseUrl()
		const voice = voiceId || DEFAULT_OPENAI_VOICE
		const model = "gpt-4o-mini-tts"

		try {
			const response = await axios.post(
				`${baseUrl}/audio/speech`,
				{
					model,
					input: text,
					voice,
					speed,
					format: "mp3",
				},
				{
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					responseType: "arraybuffer",
				},
			)

			return Buffer.from(response.data)
		} catch (error) {
			console.error("Failed to synthesize speech with OpenAI TTS:", error)
			throw error
		}
	}

	calculateCost(text: string): number {
		const characterCount = text.length
		const pricePerMillion = TTS_PRICING.openai.standard
		return (characterCount / 1_000_000) * pricePerMillion
	}

	isConfigured(): boolean {
		return !!this.getApiKey()
	}

	async isWithinFreeTier(_charactersUsed: number): Promise<boolean> {
		return false
	}
}
