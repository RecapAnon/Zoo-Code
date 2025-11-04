import { TtsProviderInterface } from "./types"
import { DefaultTtsProvider } from "./providers/default-tts"
import { GoogleCloudTtsProvider } from "./providers/google-cloud-tts"
import { AzureTtsProvider } from "./providers/azure-tts"
import { ContextProxy } from "../../core/config/ContextProxy"

export class TtsProviderFactory {
	private static instance: TtsProviderFactory
	private providers: Map<string, TtsProviderInterface> = new Map()
	private currentProvider: TtsProviderInterface | null = null

	private constructor(private contextProxy: ContextProxy) {
		this.initializeProviders()
	}

	static getInstance(contextProxy: ContextProxy): TtsProviderFactory {
		if (!TtsProviderFactory.instance) {
			TtsProviderFactory.instance = new TtsProviderFactory(contextProxy)
		}
		return TtsProviderFactory.instance
	}

	private initializeProviders() {
		// Initialize all available providers
		this.providers.set("default", new DefaultTtsProvider(this.contextProxy))
		this.providers.set("google-cloud", new GoogleCloudTtsProvider(this.contextProxy))
		this.providers.set("azure", new AzureTtsProvider(this.contextProxy))
	}

	/**
	 * Get the current TTS provider based on user settings
	 */
	getCurrentProvider(): TtsProviderInterface {
		const providerName = this.contextProxy.getValue("ttsProvider" as any) || "default"

		const provider = this.providers.get(providerName)
		if (!provider) {
			// Fall back to default if the selected provider is not available
			console.warn(`TTS provider '${providerName}' not found, falling back to default`)
			return this.providers.get("default")!
		}

		// Check if the provider is properly configured
		if (!provider.isConfigured() && providerName !== "default") {
			console.warn(`TTS provider '${providerName}' is not configured, falling back to default`)
			return this.providers.get("default")!
		}

		this.currentProvider = provider
		return provider
	}

	/**
	 * Get a specific provider by name
	 */
	getProvider(name: string): TtsProviderInterface | undefined {
		return this.providers.get(name)
	}

	/**
	 * Get all available providers
	 */
	getAllProviders(): Map<string, TtsProviderInterface> {
		return this.providers
	}

	/**
	 * Check if a provider is available and configured
	 */
	isProviderAvailable(name: string): boolean {
		const provider = this.providers.get(name)
		return provider ? provider.isConfigured() : false
	}

	/**
	 * Update the usage tracking for the current month
	 */
	async updateUsageTracking(charactersUsed: number): Promise<void> {
		const currentMonth = new Date().toISOString().slice(0, 7) // YYYY-MM format
		const providerName = this.contextProxy.getValue("ttsProvider" as any) || "default"

		// Only track usage for cloud providers
		if (providerName === "google-cloud" || providerName === "azure") {
			const usageKey =
				`tts${providerName.charAt(0).toUpperCase() + providerName.slice(1).replace("-", "")}MonthlyUsage` as any
			const currentUsage = this.contextProxy.getValue(usageKey) || { month: currentMonth, characters: 0 }

			// Reset usage if it's a new month
			if (currentUsage.month !== currentMonth) {
				currentUsage.month = currentMonth
				currentUsage.characters = 0
			}

			// Update the character count
			currentUsage.characters += charactersUsed

			// Save the updated usage
			await this.contextProxy.setValue(usageKey, currentUsage)
		}
	}

	/**
	 * Get the current month's usage for a provider
	 */
	getMonthlyUsage(providerName: string): { month: string; characters: number } {
		const currentMonth = new Date().toISOString().slice(0, 7)

		if (providerName === "google-cloud" || providerName === "azure") {
			const usageKey =
				`tts${providerName.charAt(0).toUpperCase() + providerName.slice(1).replace("-", "")}MonthlyUsage` as any
			const usage = this.contextProxy.getValue(usageKey) || { month: currentMonth, characters: 0 }

			// Reset if it's a new month
			if (usage.month !== currentMonth) {
				return { month: currentMonth, characters: 0 }
			}

			return usage
		}

		return { month: currentMonth, characters: 0 }
	}

	/**
	 * Check if the user is within the free tier for the current provider
	 */
	async isWithinFreeTier(): Promise<boolean> {
		const providerName = this.contextProxy.getValue("ttsProvider" as any) || "default"
		const provider = this.getCurrentProvider()

		if (providerName === "default") {
			return true // Default TTS is always free
		}

		const usage = this.getMonthlyUsage(providerName)
		return provider.isWithinFreeTier(usage.characters)
	}

	/**
	 * Reset the instance (useful for testing)
	 */
	static reset(): void {
		TtsProviderFactory.instance = null as any
	}
}
