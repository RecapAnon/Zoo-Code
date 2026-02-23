import React from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { type ProviderSettings } from "@roo-code/types"

interface GeminiOAuthProps {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	simplifySettings?: boolean
}

export const GeminiOAuth: React.FC<GeminiOAuthProps> = ({ apiConfiguration, setApiConfigurationField }) => {
	const defaultPath = "~/.gemini/oauth_creds.json"

	const handlePathChange = (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLInputElement
		setApiConfigurationField("geminiOauthPath", element.value)
	}

	const handlePathBlur = (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLInputElement
		if (!element.value || element.value.trim() === "") {
			setApiConfigurationField("geminiOauthPath", defaultPath)
		}
	}

	const handleProjectChange = (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLInputElement
		setApiConfigurationField("geminiOauthProjectId", element.value)
	}

	return (
		<div className="flex flex-col gap-4">
			<div>
				<VSCodeTextField
					value={apiConfiguration?.geminiOauthPath || ""}
					className="w-full mt-1"
					type="text"
					onInput={handlePathChange}
					onBlur={handlePathBlur}
					placeholder={defaultPath}>
					OAuth Credentials Path
				</VSCodeTextField>

				<p className="text-xs mt-1 text-vscode-descriptionForeground">
					Path to your Gemini OAuth credentials file. Defaults to ~/.gemini/oauth_creds.json if left empty.
				</p>
			</div>

			<div>
				<VSCodeTextField
					value={apiConfiguration?.geminiOauthProjectId || ""}
					className="w-full mt-1"
					type="text"
					onInput={handleProjectChange}
					placeholder="your-gcp-project-id">
					Project ID
				</VSCodeTextField>

				<p className="text-xs mt-1 text-vscode-descriptionForeground">
					Optional override for the Google Cloud project used by Gemini OAuth credentials.
				</p>
			</div>
		</div>
	)
}
