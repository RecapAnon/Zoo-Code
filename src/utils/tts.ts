import { TtsProviderFactory } from "./tts/provider-factory"
import { TtsProviderInterface, TtsVoice } from "./tts/types"
import { ContextProxy } from "../core/config/ContextProxy"

interface Say {
	speak: (text: string, voice?: string, speed?: number, callback?: (err?: string) => void) => void
	stop: () => void
}

type PlayTtsOptions = {
	onStart?: () => void
	onStop?: () => void
}

type QueueItem = {
	message: string
	options: PlayTtsOptions
}

let isTtsEnabled = false
let speed = 1.0
let sayInstance: Say | undefined = undefined
let queue: QueueItem[] = []
let currentProvider: TtsProviderInterface | null = null
let providerFactory: TtsProviderFactory | null = null
let contextProxy: ContextProxy | null = null

/**
 * Initialize the TTS system with a context proxy
 */
export const initializeTts = (proxy: ContextProxy) => {
	contextProxy = proxy
	providerFactory = TtsProviderFactory.getInstance(proxy)
}

/**
 * Set whether TTS is enabled
 */
export const setTtsEnabled = (enabled: boolean) => {
	isTtsEnabled = enabled
}

/**
 * Set the TTS speed
 */
export const setTtsSpeed = (newSpeed: number) => {
	speed = newSpeed
}

/**
 * Get available voices for the current provider
 */
export const getAvailableVoices = async (): Promise<TtsVoice[]> => {
	if (!providerFactory) {
		console.error("TTS not initialized. Call initializeTts() first.")
		return []
	}

	try {
		const provider = providerFactory.getCurrentProvider()
		return await provider.getVoices()
	} catch (error) {
		console.error("Failed to get available voices:", error)
		return []
	}
}

/**
 * Get the current TTS provider name
 */
export const getCurrentProviderName = (): string => {
	if (!contextProxy) {
		return "default"
	}
	return contextProxy.getValue("ttsProvider" as any) || "default"
}

/**
 * Play TTS for a message
 */
export const playTts = async (message: string, options: PlayTtsOptions = {}) => {
	if (!isTtsEnabled) {
		return
	}

	try {
		queue.push({ message, options })
		await processQueue()
	} catch (error) {
		console.error("TTS playback error:", error)
	}
}

/**
 * Stop TTS playback
 */
export const stopTts = () => {
	// Stop the current provider's playback if it's the default provider
	const providerName = getCurrentProviderName()
	if (providerName === "default" && sayInstance) {
		sayInstance.stop()
		sayInstance = undefined
	}
	// For cloud providers, we may need to add audio player cancellation
	// This would require tracking the audio playback process
	queue = []
}

/**
 * Process the TTS queue
 */
const processQueue = async (): Promise<void> => {
	if (!isTtsEnabled || sayInstance) {
		return
	}

	const item = queue.shift()
	if (!item) {
		return
	}

	if (!providerFactory) {
		console.error("TTS not initialized. Call initializeTts() first.")
		await processQueue()
		return
	}

	try {
		const { message: nextUtterance, options } = item
		const provider = providerFactory.getCurrentProvider()
		const providerName = getCurrentProviderName()

		// Handle different providers
		if (providerName === "default") {
			// Use the existing Say-based implementation for default provider
			await playWithDefaultProvider(nextUtterance, options)
		} else {
			// Use cloud providers (Google Cloud or Azure)
			await playWithCloudProvider(provider, providerName, nextUtterance, options)
		}

		await processQueue()
	} catch (error: any) {
		console.error("TTS processing error:", error)
		sayInstance = undefined
		await processQueue()
	}
}

/**
 * Play TTS using the default OS provider
 */
const playWithDefaultProvider = async (text: string, options: PlayTtsOptions): Promise<void> => {
	return new Promise<void>((resolve, reject) => {
		const say: Say = require("say")
		sayInstance = say
		options.onStart?.()

		say.speak(text, undefined, speed, (err) => {
			options.onStop?.()

			if (err) {
				reject(new Error(err))
			} else {
				resolve()
			}

			sayInstance = undefined
		})
	})
}

/**
 * Play TTS using a cloud provider
 */
const playWithCloudProvider = async (
	provider: TtsProviderInterface,
	providerName: string,
	text: string,
	options: PlayTtsOptions,
): Promise<void> => {
	if (!contextProxy || !providerFactory) {
		throw new Error("TTS not initialized")
	}

	// Get the selected voice for this provider
	let voiceId = "default"
	if (providerName === "google-cloud") {
		voiceId = contextProxy.getValue("ttsGoogleVoice" as any) || "en-US-Wavenet-D"
	} else if (providerName === "azure") {
		voiceId = contextProxy.getValue("ttsAzureVoice" as any) || "en-US-JennyNeural"
	}

	options.onStart?.()

	try {
		// Check if within free tier
		const usage = providerFactory.getMonthlyUsage(providerName)
		const isWithinFreeTier = await provider.isWithinFreeTier(usage.characters)

		if (!isWithinFreeTier) {
			console.warn(
				`TTS: Monthly free tier exceeded for ${providerName}. Current usage: ${usage.characters} characters`,
			)
			// Optionally fall back to default provider or show a warning to the user
		}

		// Calculate cost
		const cost = provider.calculateCost(text)
		if (cost > 0) {
			console.debug(`TTS cost for ${text.length} characters: $${cost.toFixed(6)}`)
		}

		// Synthesize speech
		const audioBuffer = await provider.synthesizeSpeech(text, voiceId, speed)

		// Play the audio
		await playAudioBuffer(audioBuffer)

		// Update usage tracking
		await providerFactory.updateUsageTracking(text.length)
	} finally {
		options.onStop?.()
	}
}

/**
 * Play an audio buffer using system commands
 */
const playAudioBuffer = async (audioBuffer: Buffer): Promise<void> => {
	const fs = require("fs").promises
	const path = require("path")
	const { exec } = require("child_process")
	const { promisify } = require("util")
	const execAsync = promisify(exec)
	const os = require("os")

	const tempFile = path.join(os.tmpdir(), `tts-${Date.now()}.mp3`)
	await fs.writeFile(tempFile, audioBuffer)

	try {
		const platform = process.platform
		let command: string

		if (platform === "darwin") {
			// macOS
			command = `afplay "${tempFile}"`
		} else if (platform === "win32") {
			// Windows
			command = `powershell -c "(New-Object Media.SoundPlayer '${tempFile}').PlaySync()"`
		} else {
			// Linux - try multiple players
			command = `aplay "${tempFile}" || mpg123 "${tempFile}" || ffplay -nodisp -autoexit "${tempFile}"`
		}

		await execAsync(command)
	} finally {
		// Clean up temp file
		await fs.unlink(tempFile).catch(() => {})
	}
}

/**
 * Get TTS usage statistics for the current month
 */
export const getTtsUsageStats = () => {
	if (!providerFactory || !contextProxy) {
		return null
	}

	const providerName = getCurrentProviderName()
	const usage = providerFactory.getMonthlyUsage(providerName)
	const provider = providerFactory.getCurrentProvider()

	return {
		provider: providerName,
		monthlyUsage: usage,
		isWithinFreeTier: provider.isWithinFreeTier(usage.characters),
	}
}

/**
 * Check if a specific provider is configured
 */
export const isProviderConfigured = (providerName: string): boolean => {
	if (!providerFactory) {
		return false
	}
	return providerFactory.isProviderAvailable(providerName)
}
