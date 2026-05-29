import { render, screen, fireEvent } from "@testing-library/react"
import type { ProviderSettings } from "@roo-code/types"

import { Antigravity } from "../Antigravity"

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

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const DEFAULT_OAUTH_PATH = "~/.antigravity/antigravity.json"

function setup(overrides: Partial<ProviderSettings> = {}) {
	const setApiConfigurationField = vi.fn()
	const apiConfiguration: ProviderSettings = {
		apiProvider: "antigravity",
		...overrides,
	}
	render(<Antigravity apiConfiguration={apiConfiguration} setApiConfigurationField={setApiConfigurationField} />)
	return { setApiConfigurationField }
}

describe("Antigravity settings panel", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("rendering", () => {
		it("renders the i18n-keyed description, oauth path label, project ID label, and setup instructions", () => {
			setup()
			expect(screen.getByText("settings:providers.antigravity.description")).toBeInTheDocument()
			expect(screen.getByText("settings:providers.antigravity.oauthPath")).toBeInTheDocument()
			expect(screen.getByText("settings:providers.antigravity.oauthPathDescription")).toBeInTheDocument()
			expect(screen.getByText("settings:providers.antigravity.projectId")).toBeInTheDocument()
			expect(screen.getByText("settings:providers.antigravity.projectIdDescription")).toBeInTheDocument()
			expect(screen.getByText("settings:providers.antigravity.setupInstructions")).toBeInTheDocument()
		})

		it("renders the default OAuth credentials path as the input placeholder (DD-1)", () => {
			setup()
			expect(screen.getByPlaceholderText(DEFAULT_OAUTH_PATH)).toBeInTheDocument()
		})

		it("renders the project ID input with the documented placeholder", () => {
			setup()
			expect(screen.getByPlaceholderText("your-gcp-project-id")).toBeInTheDocument()
		})

		it("displays the existing antigravityOAuthPath value when configured", () => {
			setup({ antigravityOAuthPath: "/abs/custom/creds.json" })
			expect(screen.getByDisplayValue("/abs/custom/creds.json")).toBeInTheDocument()
		})

		it("displays the existing antigravityProjectId value when configured", () => {
			setup({ antigravityProjectId: "my-gcp-project" })
			expect(screen.getByDisplayValue("my-gcp-project")).toBeInTheDocument()
		})

		it("surfaces the literal CLI command users must run to authenticate", () => {
			setup()
			// The setup instructions block embeds a <code> with the CLI command. We assert on the
			// element's tag and text so a future restructure of the surrounding copy still passes.
			const codeEl = screen.getByText("cli-proxy-api login antigravity")
			expect(codeEl).toBeInTheDocument()
			expect(codeEl.tagName).toBe("CODE")
		})
	})

	describe("user interaction", () => {
		it("calls setApiConfigurationField with `antigravityOAuthPath` on OAuth path input", () => {
			const { setApiConfigurationField } = setup()

			const oauthInput = screen.getByPlaceholderText(DEFAULT_OAUTH_PATH)
			fireEvent.input(oauthInput, { target: { value: "/new/path.json" } })

			expect(setApiConfigurationField).toHaveBeenCalledWith("antigravityOAuthPath", "/new/path.json")
		})

		it("calls setApiConfigurationField with `antigravityProjectId` on project ID input", () => {
			const { setApiConfigurationField } = setup()

			const projectInput = screen.getByPlaceholderText("your-gcp-project-id")
			fireEvent.input(projectInput, { target: { value: "new-project-id" } })

			expect(setApiConfigurationField).toHaveBeenCalledWith("antigravityProjectId", "new-project-id")
		})

		it("resets antigravityOAuthPath to the default path on blur when empty (DD-1)", () => {
			const { setApiConfigurationField } = setup()

			const oauthInput = screen.getByPlaceholderText(DEFAULT_OAUTH_PATH)
			fireEvent.blur(oauthInput, { target: { value: "" } })

			expect(setApiConfigurationField).toHaveBeenCalledWith("antigravityOAuthPath", DEFAULT_OAUTH_PATH)
		})

		it("resets antigravityOAuthPath to the default path on blur when only whitespace", () => {
			const { setApiConfigurationField } = setup()

			const oauthInput = screen.getByPlaceholderText(DEFAULT_OAUTH_PATH)
			fireEvent.blur(oauthInput, { target: { value: "   " } })

			expect(setApiConfigurationField).toHaveBeenCalledWith("antigravityOAuthPath", DEFAULT_OAUTH_PATH)
		})

		it("does NOT overwrite antigravityOAuthPath on blur when the user provided a non-empty value", () => {
			const { setApiConfigurationField } = setup({
				antigravityOAuthPath: "/abs/custom/creds.json",
			})

			const oauthInput = screen.getByDisplayValue("/abs/custom/creds.json")
			fireEvent.blur(oauthInput, { target: { value: "/abs/custom/creds.json" } })

			// onBlur should not call the setter with the default when the field already has content.
			expect(setApiConfigurationField).not.toHaveBeenCalledWith("antigravityOAuthPath", DEFAULT_OAUTH_PATH)
		})
	})
})
