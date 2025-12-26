import { HTMLAttributes } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import {
	VSCodeCheckbox,
	VSCodeDropdown,
	VSCodeOption,
	VSCodeTextField,
	VSCodeButton,
} from "@vscode/webview-ui-toolkit/react"
import { Bell } from "lucide-react"
import { vscode } from "@src/utils/vscode"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { Slider } from "../ui"

type NotificationSettingsProps = HTMLAttributes<HTMLDivElement> & {
	ttsEnabled?: boolean
	ttsSpeed?: number
	ttsProvider?: "default" | "google-cloud" | "azure" | "openai"
	ttsAzureVoice?: string
	ttsGoogleVoice?: string
	ttsOpenAiVoice?: string
	openAiTtsBaseUrl?: string
	openAiTtsApiKey?: string
	azureTtsApiKey?: string
	googleCloudTtsApiKey?: string
	azureTtsRegion?: string
	soundEnabled?: boolean
	soundVolume?: number
	setCachedStateField: SetCachedStateField<
		| "ttsEnabled"
		| "ttsSpeed"
		| "ttsProvider"
		| "ttsAzureVoice"
		| "ttsGoogleVoice"
		| "ttsOpenAiVoice"
		| "openAiTtsBaseUrl"
		| "openAiTtsApiKey"
		| "azureTtsApiKey"
		| "googleCloudTtsApiKey"
		| "azureTtsRegion"
		| "soundEnabled"
		| "soundVolume"
	>
}

export const NotificationSettings = ({
	ttsEnabled,
	ttsSpeed,
	ttsProvider,
	ttsAzureVoice,
	ttsGoogleVoice,
	ttsOpenAiVoice,
	openAiTtsBaseUrl,
	openAiTtsApiKey,
	azureTtsApiKey,
	googleCloudTtsApiKey,
	azureTtsRegion,
	soundEnabled,
	soundVolume,
	setCachedStateField,
	...props
}: NotificationSettingsProps) => {
	const { t } = useAppTranslation()
	return (
		<div {...props}>
			<SectionHeader>
				<div className="flex items-center gap-2">
					<Bell className="w-4" />
					<div>{t("settings:sections.notifications")}</div>
				</div>
			</SectionHeader>

			<Section>
				<div>
					<VSCodeCheckbox
						checked={ttsEnabled}
						onChange={(e: any) => setCachedStateField("ttsEnabled", e.target.checked)}
						data-testid="tts-enabled-checkbox">
						<span className="font-medium">{t("settings:notifications.tts.label")}</span>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:notifications.tts.description")}
					</div>
				</div>

				{ttsEnabled && (
					<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
						<div>
							<label className="block font-medium mb-1">
								{t("settings:notifications.tts.providerLabel")}
							</label>
							<VSCodeDropdown
								value={ttsProvider || "default"}
								onChange={(e: any) => {
									const provider = e.target.value as "default" | "google-cloud" | "azure" | "openai"
									setCachedStateField("ttsProvider", provider)
									vscode.postMessage({ type: "ttsProvider", text: provider })
								}}
								className="w-full">
								<VSCodeOption value="default" className="py-2 px-3">
									Default (OS)
								</VSCodeOption>
								<VSCodeOption value="google-cloud" className="py-2 px-3">
									Google Cloud TTS
								</VSCodeOption>
								<VSCodeOption value="azure" className="py-2 px-3">
									Azure TTS
								</VSCodeOption>
								<VSCodeOption value="openai" className="py-2 px-3">
									OpenAI TTS
								</VSCodeOption>
							</VSCodeDropdown>
						</div>
						<div>
							<label className="block font-medium mb-1">
								{t("settings:notifications.tts.speedLabel")}
							</label>
							<div className="flex items-center gap-2">
								<Slider
									min={0.1}
									max={2.0}
									step={0.01}
									value={[ttsSpeed ?? 1.0]}
									onValueChange={([value]) => setCachedStateField("ttsSpeed", value)}
									data-testid="tts-speed-slider"
								/>
								<span className="w-10">{((ttsSpeed ?? 1.0) * 100).toFixed(0)}%</span>
							</div>
						</div>

						{ttsProvider === "azure" && (
							<div className="flex flex-col gap-3">
								<VSCodeTextField
									type="password"
									value={azureTtsApiKey ?? ""}
									onInput={(e: any) => {
										const apiKey = e.target.value
										setCachedStateField("azureTtsApiKey", apiKey)
										vscode.postMessage({
											type: "updateSettings",
											updatedSettings: { azureTtsApiKey: apiKey },
										})
									}}
									placeholder={t("settings:placeholders.apiKey")}
									className="w-full">
									<label className="block font-medium mb-1">Azure API Key</label>
								</VSCodeTextField>
								<VSCodeTextField
									value={azureTtsRegion ?? ""}
									onInput={(e: any) => {
										const region = e.target.value
										setCachedStateField("azureTtsRegion", region)
										vscode.postMessage({ type: "ttsAzureRegion", text: region })
									}}
									placeholder="eastus"
									className="w-full">
									<label className="block font-medium mb-1">Azure Region</label>
								</VSCodeTextField>
								<VSCodeTextField
									value={ttsAzureVoice || ""}
									onInput={(e: any) => {
										const voice = e.target.value
										setCachedStateField("ttsAzureVoice", voice)
										vscode.postMessage({ type: "ttsAzureVoice", text: voice })
									}}
									placeholder="en-US-JennyNeural"
									className="w-full">
									<label className="block font-medium mb-1">Azure Voice</label>
								</VSCodeTextField>
								<div className="flex items-center gap-2">
									<VSCodeButton onClick={() => vscode.postMessage({ type: "getTtsVoices" })}>
										Fetch Voices
									</VSCodeButton>
									<span className="text-xs text-vscode-descriptionForeground">
										Uses current API key/region.
									</span>
								</div>
							</div>
						)}

						{ttsProvider === "google-cloud" && (
							<div className="flex flex-col gap-3">
								<VSCodeTextField
									type="password"
									value={googleCloudTtsApiKey ?? ""}
									onInput={(e: any) => {
										const apiKey = e.target.value
										setCachedStateField("googleCloudTtsApiKey", apiKey)
										vscode.postMessage({
											type: "updateSettings",
											updatedSettings: { googleCloudTtsApiKey: apiKey },
										})
									}}
									placeholder={t("settings:placeholders.apiKey")}
									className="w-full">
									<label className="block font-medium mb-1">Google Cloud API Key</label>
								</VSCodeTextField>
								<VSCodeTextField
									value={ttsGoogleVoice || ""}
									onInput={(e: any) => {
										const voice = e.target.value
										setCachedStateField("ttsGoogleVoice", voice)
										vscode.postMessage({ type: "ttsGoogleVoice", text: voice })
									}}
									placeholder="en-US-Wavenet-D"
									className="w-full">
									<label className="block font-medium mb-1">Google Voice</label>
								</VSCodeTextField>
								<div className="flex items-center gap-2">
									<VSCodeButton onClick={() => vscode.postMessage({ type: "getTtsVoices" })}>
										Fetch Voices
									</VSCodeButton>
									<span className="text-xs text-vscode-descriptionForeground">
										Uses current API key.
									</span>
								</div>
							</div>
						)}

						{ttsProvider === "openai" && (
							<div className="flex flex-col gap-3">
								<VSCodeTextField
									type="password"
									value={openAiTtsApiKey ?? ""}
									onInput={(e: any) => {
										const apiKey = e.target.value
										setCachedStateField("openAiTtsApiKey", apiKey)
										vscode.postMessage({
											type: "updateSettings",
											updatedSettings: { openAiTtsApiKey: apiKey },
										})
									}}
									placeholder={t("settings:placeholders.apiKey")}
									className="w-full">
									<label className="block font-medium mb-1">OpenAI API Key</label>
								</VSCodeTextField>
								<VSCodeTextField
									value={openAiTtsBaseUrl || "https://api.openai.com/v1"}
									onInput={(e: any) => {
										const baseUrl = e.target.value
										setCachedStateField("openAiTtsBaseUrl", baseUrl)
										vscode.postMessage({ type: "openAiTtsBaseUrl", text: baseUrl })
									}}
									placeholder="https://api.openai.com/v1"
									className="w-full">
									<label className="block font-medium mb-1">Base URL</label>
								</VSCodeTextField>
								<div>
									<label className="block font-medium mb-1">Voice</label>
									<VSCodeDropdown
										value={ttsOpenAiVoice || "alloy"}
										onChange={(e: any) => {
											const voice = e.target.value
											setCachedStateField("ttsOpenAiVoice", voice)
											vscode.postMessage({ type: "ttsOpenAiVoice", text: voice })
										}}
										className="w-full">
										<VSCodeOption value="alloy" className="py-2 px-3">
											alloy
										</VSCodeOption>
										<VSCodeOption value="echo" className="py-2 px-3">
											echo
										</VSCodeOption>
										<VSCodeOption value="fable" className="py-2 px-3">
											fable
										</VSCodeOption>
										<VSCodeOption value="onyx" className="py-2 px-3">
											onyx
										</VSCodeOption>
										<VSCodeOption value="nova" className="py-2 px-3">
											nova
										</VSCodeOption>
										<VSCodeOption value="shimmer" className="py-2 px-3">
											shimmer
										</VSCodeOption>
									</VSCodeDropdown>
								</div>
							</div>
						)}
					</div>
				)}

				<div>
					<VSCodeCheckbox
						checked={soundEnabled}
						onChange={(e: any) => setCachedStateField("soundEnabled", e.target.checked)}
						data-testid="sound-enabled-checkbox">
						<span className="font-medium">{t("settings:notifications.sound.label")}</span>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:notifications.sound.description")}
					</div>
				</div>

				{soundEnabled && (
					<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
						<div>
							<label className="block font-medium mb-1">
								{t("settings:notifications.sound.volumeLabel")}
							</label>
							<div className="flex items-center gap-2">
								<Slider
									min={0}
									max={1}
									step={0.01}
									value={[soundVolume ?? 0.5]}
									onValueChange={([value]) => setCachedStateField("soundVolume", value)}
									data-testid="sound-volume-slider"
								/>
								<span className="w-10">{((soundVolume ?? 0.5) * 100).toFixed(0)}%</span>
							</div>
						</div>
					</div>
				)}
			</Section>
		</div>
	)
}
