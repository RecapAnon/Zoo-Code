import React from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { type ProviderSettings } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"

interface AntigravityProps {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}

// Default credentials path per design DD-1 (revised in Gate 2): Zoo Code uses its own
// `~/.antigravity/` namespace rather than CLIProxyAPI's `DefaultAuthDir`. Filename matches
// `CLIProxyAPI/internal/auth/antigravity/filename.go` (`antigravity.json`).
const DEFAULT_OAUTH_PATH = "~/.antigravity/antigravity.json"

export const Antigravity: React.FC<AntigravityProps> = ({ apiConfiguration, setApiConfigurationField }) => {
	const { t } = useAppTranslation()

	const handlePathChange = (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLInputElement
		setApiConfigurationField("antigravityOAuthPath", element.value)
	}

	const handlePathBlur = (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLInputElement
		if (!element.value || element.value.trim() === "") {
			setApiConfigurationField("antigravityOAuthPath", DEFAULT_OAUTH_PATH)
		}
	}

	const handleProjectChange = (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLInputElement
		setApiConfigurationField("antigravityProjectId", element.value)
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="text-sm text-vscode-descriptionForeground">
				{t("settings:providers.antigravity.description")}
			</div>

			<div>
				<VSCodeTextField
					value={apiConfiguration?.antigravityOAuthPath || ""}
					className="w-full mt-1"
					type="text"
					onInput={handlePathChange}
					onBlur={handlePathBlur}
					placeholder={DEFAULT_OAUTH_PATH}>
					<label className="block font-medium mb-1">{t("settings:providers.antigravity.oauthPath")}</label>
				</VSCodeTextField>
				<p className="text-xs mt-1 text-vscode-descriptionForeground">
					{t("settings:providers.antigravity.oauthPathDescription")}
				</p>
			</div>

			<div>
				<VSCodeTextField
					value={apiConfiguration?.antigravityProjectId || ""}
					className="w-full mt-1"
					type="text"
					onInput={handleProjectChange}
					placeholder="your-gcp-project-id">
					<label className="block font-medium mb-1">{t("settings:providers.antigravity.projectId")}</label>
				</VSCodeTextField>
				<p className="text-xs mt-1 text-vscode-descriptionForeground">
					{t("settings:providers.antigravity.projectIdDescription")}
				</p>
			</div>

			<div className="text-xs text-vscode-descriptionForeground">
				{t("settings:providers.antigravity.setupInstructions")}{" "}
				<code className="text-vscode-textPreformat-foreground">cli-proxy-api login antigravity</code>
			</div>
		</div>
	)
}
