export type TtsProvider = "default" | "google" | "azure"

export interface TtsVoice {
	id: string
	name: string
	languageCode: string
	gender?: string
	premium?: boolean
}

export interface TtsProviderInterface {
	/**
	 * Get available voices for this provider
	 */
	getVoices(): Promise<TtsVoice[]>

	/**
	 * Synthesize speech from text
	 * @param text The text to synthesize
	 * @param voiceId The voice ID to use
	 * @param speed The speech speed (0.5 to 2.0)
	 * @returns The synthesized audio as a buffer
	 */
	synthesizeSpeech(text: string, voiceId: string, speed: number): Promise<Buffer>

	/**
	 * Calculate the cost for synthesizing the given text
	 * @param text The text to synthesize
	 * @returns The cost in USD
	 */
	calculateCost(text: string): number

	/**
	 * Check if the provider is properly configured
	 */
	isConfigured(): boolean

	/**
	 * Check if the user has exceeded their free tier for the current month
	 * @param charactersUsed The number of characters used this month
	 * @returns True if within free tier, false otherwise
	 */
	isWithinFreeTier(charactersUsed: number): Promise<boolean>
}

export interface TtsUsageMetrics {
	charactersUsed: number
	cost: number
	timestamp: Date
	provider: TtsProvider
}

// Pricing constants (per million characters)
export const TTS_PRICING = {
	google: {
		standard: 4.0, // $4.00 per 1M characters for standard voices
		wavenet: 16.0, // $16.00 per 1M characters for WaveNet voices
		neural2: 16.0, // $16.00 per 1M characters for Neural2 voices
		studio: 160.0, // $160.00 per 1M characters for Studio voices
		freeMonthlyCharacters: 4_000_000, // 4M free characters per month (standard voices)
	},
	azure: {
		standard: 4.0, // $4.00 per 1M characters for standard voices
		neural: 15.0, // $15.00 per 1M characters for neural voices
		freeMonthlyCharacters: 500_000, // 0.5M free characters per month
	},
}
