import axios from "axios"
import { TtsProviderInterface, TtsVoice, TTS_PRICING } from "../types"
import { ContextProxy } from "../../../core/config/ContextProxy"

export class AzureTtsProvider implements TtsProviderInterface {
	private apiKey: string | undefined
	private region: string | undefined
	private baseUrl: string

	constructor(private contextProxy: ContextProxy) {
		this.apiKey = this.contextProxy.getValue("azureTtsApiKey" as any)
		this.region = this.contextProxy.getValue("azureTtsRegion" as any) || "eastus"
		this.baseUrl = `https://${this.region}.tts.speech.microsoft.com/cognitiveservices`
	}

	async getVoices(): Promise<TtsVoice[]> {
		if (!this.isConfigured()) {
			return []
		}

		try {
			const response = await axios.get(`${this.baseUrl}/voices/list`, {
				headers: {
					"Ocp-Apim-Subscription-Key": this.apiKey!,
				},
			})

			return response.data.map((voice: any) => ({
				id: voice.ShortName,
				name: `${voice.DisplayName} (${voice.LocalName})`,
				languageCode: voice.Locale,
				gender: voice.Gender,
				premium: voice.VoiceType === "Neural",
			}))
		} catch (error) {
			console.error("Failed to fetch Azure TTS voices:", error)
			return []
		}
	}

	async synthesizeSpeech(text: string, voiceId: string, speed: number): Promise<Buffer> {
		if (!this.isConfigured()) {
			throw new Error("Azure TTS is not configured")
		}

		try {
			// Convert speed to Azure's rate format (e.g., "+20%" or "-10%")
			const rate = speed === 1 ? "default" : `${Math.round((speed - 1) * 100)}%`

			const ssml = `
				<speak version='1.0' xml:lang='en-US'>
					<voice xml:lang='en-US' name='${voiceId}'>
						<prosody rate='${rate}'>
							${this.escapeXml(text)}
						</prosody>
					</voice>
				</speak>`

			const response = await axios.post(`${this.baseUrl}/v1`, ssml, {
				headers: {
					"Ocp-Apim-Subscription-Key": this.apiKey!,
					"Content-Type": "application/ssml+xml",
					"X-Microsoft-OutputFormat": "audio-16khz-128kbitrate-mono-mp3",
				},
				responseType: "arraybuffer",
			})

			return Buffer.from(response.data)
		} catch (error) {
			console.error("Failed to synthesize speech with Azure TTS:", error)
			throw error
		}
	}

	calculateCost(text: string): number {
		const characterCount = text.length
		// Assume neural voices by default (can be improved by checking voice type)
		const pricePerMillion = TTS_PRICING.azure.neural
		return (characterCount / 1_000_000) * pricePerMillion
	}

	isConfigured(): boolean {
		return !!this.apiKey
	}

	/**
	 * Check if the user has exceeded their free tier for the current month
	 */
	async isWithinFreeTier(charactersUsed: number): Promise<boolean> {
		return charactersUsed < TTS_PRICING.azure.freeMonthlyCharacters
	}

	/**
	 * Escape XML special characters for SSML
	 */
	private escapeXml(text: string): string {
		return text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&apos;")
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
