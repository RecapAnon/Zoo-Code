import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import type { ProviderSettings } from "@roo-code/types"

import { GeminiCli } from "../GeminiCli"

// Mock VSCodeTextField as a thin <input> wrapper — the real toolkit web component doesn't flow
// events through React's synthetic system in jsdom. Same pattern as Antigravity.spec.tsx.
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, onBlur, placeholder, type }: any) => (
		<div>
			{children}
			<input
				type={type}
				value={value}
				placeholder={placeholder}
				onChange={(e) => onInput?.(e)}
				onBlur={(e) => onBlur?.(e)}
			/>
		</div>
	),
}))

const DEFAULT_OAUTH_PATH = "~/.gemini/Cli_creds.json"

function setup(overrides: Partial<ProviderSettings> = {}) {
	const setApiConfigurationField = vi.fn()
	const apiConfiguration: ProviderSettings = {
		apiProvider: "gemini-cli",
		...overrides,
	}
	render(<GeminiCli apiConfiguration={apiConfiguration} setApiConfigurationField={setApiConfigurationField} />)
	return { setApiConfigurationField }
}

describe("GeminiCli settings panel", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("rendering", () => {
		it("renders the OAuth credentials path label and default placeholder", () => {
			setup()
			expect(screen.getByText("Cli Credentials Path")).toBeInTheDocument()
			expect(screen.getByPlaceholderText(DEFAULT_OAUTH_PATH)).toBeInTheDocument()
		})

		it("renders the Project ID label and placeholder", () => {
			setup()
			expect(screen.getByText("Project ID")).toBeInTheDocument()
			expect(screen.getByPlaceholderText("your-gcp-project-id")).toBeInTheDocument()
		})

		it("renders the OAuth path description text", () => {
			setup()
			expect(screen.getByText(/Path to your Gemini Cli credentials file/i)).toBeInTheDocument()
		})

		it("renders the project ID description text", () => {
			setup()
			expect(screen.getByText(/Optional override for the Google Cloud project/i)).toBeInTheDocument()
		})

		it("displays the configured geminiCliOAuthPath value", () => {
			setup({ geminiCliOAuthPath: "/custom/path/oauth.json" })
			expect(screen.getByDisplayValue("/custom/path/oauth.json")).toBeInTheDocument()
		})

		it("displays the configured geminiCliProjectId value", () => {
			setup({ geminiCliProjectId: "configured-project" })
			expect(screen.getByDisplayValue("configured-project")).toBeInTheDocument()
		})
	})

	describe("user interaction", () => {
		it("calls setApiConfigurationField with geminiCliOAuthPath on OAuth path input", () => {
			const { setApiConfigurationField } = setup()
			const oauthInput = screen.getByPlaceholderText(DEFAULT_OAUTH_PATH)
			fireEvent.input(oauthInput, { target: { value: "/new/path.json" } })
			expect(setApiConfigurationField).toHaveBeenCalledWith("geminiCliOAuthPath", "/new/path.json")
		})

		it("calls setApiConfigurationField with geminiCliProjectId on project ID input", () => {
			const { setApiConfigurationField } = setup()
			const projectInput = screen.getByPlaceholderText("your-gcp-project-id")
			fireEvent.input(projectInput, { target: { value: "new-project" } })
			expect(setApiConfigurationField).toHaveBeenCalledWith("geminiCliProjectId", "new-project")
		})

		it("resets the OAuth path to the default on blur when empty", () => {
			const { setApiConfigurationField } = setup()
			const oauthInput = screen.getByPlaceholderText(DEFAULT_OAUTH_PATH)
			fireEvent.blur(oauthInput, { target: { value: "" } })
			expect(setApiConfigurationField).toHaveBeenCalledWith("geminiCliOAuthPath", DEFAULT_OAUTH_PATH)
		})

		it("resets the OAuth path to the default on blur when only whitespace", () => {
			const { setApiConfigurationField } = setup()
			const oauthInput = screen.getByPlaceholderText(DEFAULT_OAUTH_PATH)
			fireEvent.blur(oauthInput, { target: { value: "   " } })
			expect(setApiConfigurationField).toHaveBeenCalledWith("geminiCliOAuthPath", DEFAULT_OAUTH_PATH)
		})

		it("does NOT overwrite the OAuth path on blur when the user provided a non-empty value", () => {
			const { setApiConfigurationField } = setup({
				geminiCliOAuthPath: "/abs/custom/creds.json",
			})
			const oauthInput = screen.getByDisplayValue("/abs/custom/creds.json")
			fireEvent.blur(oauthInput, { target: { value: "/abs/custom/creds.json" } })
			expect(setApiConfigurationField).not.toHaveBeenCalledWith("geminiCliOAuthPath", DEFAULT_OAUTH_PATH)
		})
	})
})
