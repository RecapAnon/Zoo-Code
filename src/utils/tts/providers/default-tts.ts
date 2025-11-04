import { TtsProviderInterface, TtsVoice } from "../types"
import { ContextProxy } from "../../../core/config/ContextProxy"

export class DefaultTtsProvider implements TtsProviderInterface {
	private say: any

	constructor(private contextProxy: ContextProxy) {
		// Lazy load the 'say' module
		try {
			this.say = require("say")
		} catch (error) {
			console.warn("Failed to load say module for default TTS:", error)
			this.say = null
		}
	}

	async getVoices(): Promise<TtsVoice[]> {
		// Default OS TTS doesn't provide a reliable way to list voices
		// Return a generic voice option
		return [
			{
				id: "default",
				name: "System Default Voice",
				languageCode: "en-US",
				gender: "neutral",
				premium: false,
			},
		]
	}

	async synthesizeSpeech(text: string, voiceId: string, speed: number): Promise<Buffer> {
		if (!this.say) {
			throw new Error("Default TTS is not available - say module not found")
		}

		// The default TTS doesn't return audio data, it plays directly
		// Return an empty buffer and handle playback in playAudio method
		return Buffer.from("")
	}

	calculateCost(text: string): number {
		// Default OS TTS is free
		return 0
	}

	isConfigured(): boolean {
		// Default TTS is always configured if the say module is available
		return !!this.say
	}

	/**
	 * Check if the user has exceeded their free tier for the current month
	 * Default TTS is always free, so this always returns true
	 */
	async isWithinFreeTier(charactersUsed: number): Promise<boolean> {
		return true
	}

	/**
	 * Play text directly using the system's TTS engine
	 * Note: For default TTS, we play the text directly rather than audio buffer
	 */
	async playAudio(audioBuffer: Buffer, text?: string, speed: number = 1.0): Promise<void> {
		if (!this.say) {
			throw new Error("Default TTS is not available - say module not found")
		}

		if (!text) {
			throw new Error("Text is required for default TTS playback")
		}

		return new Promise((resolve, reject) => {
			// Use platform-specific voice if configured
			const platform = process.platform
			let voice: string | undefined

			// Get user's preferred voice for the platform if available
			try {
				if (platform === "darwin") {
					// macOS voices
					const macVoice = this.contextProxy.getValue("ttsMacVoice" as any)
					if (macVoice && macVoice !== "default") {
						voice = macVoice
					}
				} else if (platform === "win32") {
					// Windows voices
					const winVoice = this.contextProxy.getValue("ttsWindowsVoice" as any)
					if (winVoice && winVoice !== "default") {
						voice = winVoice
					}
				} else {
					// Linux - usually uses espeak or festival
					const linuxVoice = this.contextProxy.getValue("ttsLinuxVoice" as any)
					if (linuxVoice && linuxVoice !== "default") {
						voice = linuxVoice
					}
				}
			} catch (error) {
				// Ignore voice preference errors and use system default
				console.debug("Could not get voice preference:", error)
			}

			// Convert speed to say module's format (words per minute)
			// Default is around 175 WPM, so adjust based on the speed multiplier
			const wpm = Math.round(175 * speed)

			this.say.speak(text, voice, wpm, (err: any) => {
				if (err) {
					reject(err)
				} else {
					resolve()
				}
			})
		})
	}

	/**
	 * Stop any ongoing TTS playback
	 */
	stopPlayback(): void {
		if (this.say && this.say.stop) {
			this.say.stop()
		}
	}

	/**
	 * Export text to an audio file (not supported by default TTS)
	 */
	async exportToFile(text: string, outputPath: string, voiceId: string, speed: number): Promise<void> {
		if (!this.say) {
			throw new Error("Default TTS is not available - say module not found")
		}

		return new Promise((resolve, reject) => {
			// Use platform-specific export if available
			const platform = process.platform

			if (platform === "darwin") {
				// macOS can export using the say command
				const { exec } = require("child_process")
				const voice = voiceId !== "default" ? voiceId : undefined
				const voiceArg = voice ? ` -v "${voice}"` : ""
				const rateArg = ` -r ${Math.round(175 * speed)}`

				exec(`say "${text}"${voiceArg}${rateArg} -o "${outputPath}"`, (err: any) => {
					if (err) {
						reject(new Error(`Failed to export TTS: ${err.message}`))
					} else {
						resolve()
					}
				})
			} else {
				// Other platforms don't support direct export with say module
				reject(new Error("Audio export is not supported on this platform with default TTS"))
			}
		})
	}
}
