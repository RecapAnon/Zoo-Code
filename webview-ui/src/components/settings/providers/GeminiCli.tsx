import React from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { type ProviderSettings } from "@roo-code/types"

interface GeminiCliProps {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	simplifySettings?: boolean
}

export const GeminiCli: React.FC<GeminiCliProps> = ({ apiConfiguration, setApiConfigurationField }) => {
	const defaultPath = "~/.gemini/Cli_creds.json"

	const handlePathChange = (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLInputElement
		setApiConfigurationField("geminiCliOAuthPath", element.value)
	}

	const handlePathBlur = (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLInputElement
		if (!element.value || element.value.trim() === "") {
			setApiConfigurationField("geminiCliOAuthPath", defaultPath)
		}
	}

	const handleProjectChange = (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLInputElement
		setApiConfigurationField("geminiCliProjectId", element.value)
	}

	return (
		<div className="flex flex-col gap-4">
			<div>
				<VSCodeTextField
					value={apiConfiguration?.geminiCliOAuthPath || ""}
					className="w-full mt-1"
					type="text"
					onInput={handlePathChange}
					onBlur={handlePathBlur}
					placeholder={defaultPath}>
					Cli Credentials Path
				</VSCodeTextField>

				<p className="text-xs mt-1 text-vscode-descriptionForeground">
					Path to your Gemini Cli credentials file. Defaults to ~/.gemini/Cli_creds.json if left empty.
				</p>
			</div>

			<div>
				<VSCodeTextField
					value={apiConfiguration?.geminiCliProjectId || ""}
					className="w-full mt-1"
					type="text"
					onInput={handleProjectChange}
					placeholder="your-gcp-project-id">
					Project ID
				</VSCodeTextField>

				<p className="text-xs mt-1 text-vscode-descriptionForeground">
					Optional override for the Google Cloud project used by Gemini Cli credentials.
				</p>
			</div>
		</div>
	)
}
