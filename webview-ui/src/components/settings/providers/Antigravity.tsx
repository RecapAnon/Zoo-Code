import React from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { type ProviderSettings } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button } from "@src/components/ui"
import { vscode } from "@src/utils/vscode"

interface AntigravityProps {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	antigravityIsAuthenticated?: boolean
	antigravityUserEmail?: string
}

export const Antigravity: React.FC<AntigravityProps> = ({
	apiConfiguration,
	setApiConfigurationField,
	antigravityIsAuthenticated = false,
	antigravityUserEmail,
}) => {
	const { t } = useAppTranslation()

	const handleProjectChange = (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLInputElement
		setApiConfigurationField("antigravityProjectId", element.value)
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="text-sm text-vscode-descriptionForeground">
				{t("settings:providers.antigravity.description")}
			</div>

			{/* Authentication section: sign-in button or signed-in pill + sign-out. */}
			<div className="flex flex-col gap-2">
				{antigravityIsAuthenticated ? (
					<div className="flex items-center justify-between gap-2">
						<div className="text-sm text-vscode-descriptionForeground">
							{antigravityUserEmail
								? t("settings:providers.antigravity.signedInAs", { email: antigravityUserEmail })
								: t("settings:providers.antigravity.signedIn")}
						</div>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => vscode.postMessage({ type: "antigravitySignOut" })}>
							{t("settings:providers.antigravity.signOutButton", {
								defaultValue: "Sign Out",
							})}
						</Button>
					</div>
				) : (
					<Button
						variant="primary"
						onClick={() => vscode.postMessage({ type: "antigravitySignIn" })}
						className="w-fit">
						{t("settings:providers.antigravity.signInButton", {
							defaultValue: "Sign in to Antigravity",
						})}
					</Button>
				)}
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
		</div>
	)
}
