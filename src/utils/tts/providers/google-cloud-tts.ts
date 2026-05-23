import axios from "axios"
import { TtsProviderInterface, TtsVoice, TTS_PRICING } from "../types"
import { ContextProxy } from "../../../core/config/ContextProxy"

export class GoogleCloudTtsProvider implements TtsProviderInterface {
	private baseUrl = "https://texttospeech.googleapis.com/v1"

	constructor(private contextProxy: ContextProxy) {}

	private getApiKey(): string | undefined {
		return this.contextProxy.getValue("googleCloudTtsApiKey" as any) as string | undefined
	}

	async getVoices(): Promise<TtsVoice[]> {
		const apiKey = this.getApiKey()
		if (!apiKey) {
			return []
		}

		try {
			const response = await axios.get(`${this.baseUrl}/voices`, {
				params: { key: apiKey },
			})

			return response.data.voices.map((voice: any) => ({
				id: voice.name,
				name: `${voice.name} (${voice.ssmlGender})`,
				languageCode: voice.languageCodes[0],
				gender: voice.ssmlGender,
				premium:
					voice.name.includes("Wavenet") || voice.name.includes("Neural2") || voice.name.includes("Studio"),
			}))
		} catch (error) {
			console.error("Failed to fetch Google Cloud TTS voices:", error)
			return []
		}
	}

	async synthesizeSpeech(text: string, voiceId: string, speed: number): Promise<Buffer> {
		const apiKey = this.getApiKey()
		if (!apiKey) {
			throw new Error("Google Cloud TTS is not configured")
		}

		try {
			const response = await axios.post(
				`${this.baseUrl}/text:synthesize`,
				{
					input: { text },
					voice: {
						name: voiceId,
						languageCode: voiceId.split("-").slice(0, 2).join("-"),
					},
					audioConfig: {
						audioEncoding: "MP3",
						speakingRate: speed,
					},
				},
				{
					params: { key: apiKey },
					headers: { "Content-Type": "application/json" },
				},
			)

			// The response contains base64-encoded audio
			const audioBuffer = Buffer.from(response.data.audioContent, "base64")
			return audioBuffer
		} catch (error) {
			console.error("Failed to synthesize speech with Google Cloud TTS:", error)
			throw error
		}
	}

	calculateCost(text: string): number {
		const characterCount = text.length
		// Assume standard voices by default (can be improved by checking voice type)
		const pricePerMillion = TTS_PRICING.google.standard
		return (characterCount / 1_000_000) * pricePerMillion
	}

	isConfigured(): boolean {
		return !!this.getApiKey()
	}

	/**
	 * Check if the user has exceeded their free tier for the current month
	 */
	async isWithinFreeTier(charactersUsed: number): Promise<boolean> {
		return charactersUsed < TTS_PRICING.google.freeMonthlyCharacters
	}

	/**
	 * Play audio buffer using the system's audio player
	 */
	async playAudio(audioBuffer: Buffer): Promise<void> {
		// Save to temporary file and play using system command
		const fs = require("fs").promises
		const path = require("path")
		const { exec } = require("child_process")
		const { promisify } = require("util")
		const execAsync = promisify(exec)
		const os = require("os")

		const tempFile = path.join(os.tmpdir(), `tts-${Date.now()}.mp3`)
		await fs.writeFile(tempFile, audioBuffer)

		try {
			// Use different commands based on platform
			const platform = process.platform
			let command: string

			if (platform === "darwin") {
				// macOS
				command = `afplay "${tempFile}"`
			} else if (platform === "win32") {
				// Windows
				command = `powershell -c "(New-Object Media.SoundPlayer '${tempFile}').PlaySync()"`
			} else {
				// Linux
				command = `aplay "${tempFile}" || mpg123 "${tempFile}" || ffplay -nodisp -autoexit "${tempFile}"`
			}

			await execAsync(command)
		} finally {
			// Clean up temp file
			await fs.unlink(tempFile).catch(() => {})
		}
	}
}
