import React from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { type ProviderSettings } from "@roo-code/types"

interface CodexOAuthProps {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	simplifySettings?: boolean
}

export const CodexOAuth: React.FC<CodexOAuthProps> = ({ apiConfiguration, setApiConfigurationField }) => {
	const defaultPath = "~/.roo/codex-oauth.json"

	const handleInputChange = (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLInputElement
		setApiConfigurationField("codexOauthPath", element.value)
	}

	const handleBlur = (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLInputElement
		if (!element.value || element.value.trim() === "") {
			setApiConfigurationField("codexOauthPath", defaultPath)
		}
	}

	return (
		<div className="flex flex-col gap-4">
			<div>
				<VSCodeTextField
					value={apiConfiguration?.codexOauthPath || ""}
					className="w-full mt-1"
					type="text"
					onInput={handleInputChange}
					onBlur={handleBlur}
					placeholder={defaultPath}>
					OAuth Credentials Path
				</VSCodeTextField>

				<p className="text-xs mt-1 text-vscode-descriptionForeground">
					Path to your Codex OAuth credentials file. Defaults to ~/.roo/codex-oauth.json if left empty.
				</p>
			</div>
		</div>
	)
}
