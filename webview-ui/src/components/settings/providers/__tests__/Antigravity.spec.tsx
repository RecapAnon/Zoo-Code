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
	useAppTranslation: () => ({
		// Render the key, plus any interpolation values, so we can assert on the resolved text.
		t: (key: string, params?: Record<string, unknown>) => {
			if (params && params.email) {
				return `${key}|${params.email}`
			}
			return key
		},
	}),
}))

const postMessageMock = vi.fn()
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (...args: unknown[]) => postMessageMock(...args),
	},
}))

function setup(
	overrides: {
		apiConfiguration?: Partial<ProviderSettings>
		antigravityIsAuthenticated?: boolean
		antigravityUserEmail?: string
	} = {},
) {
	const setApiConfigurationField = vi.fn()
	const apiConfiguration: ProviderSettings = {
		apiProvider: "antigravity",
		...(overrides.apiConfiguration ?? {}),
	}
	render(
		<Antigravity
			apiConfiguration={apiConfiguration}
			setApiConfigurationField={setApiConfigurationField}
			antigravityIsAuthenticated={overrides.antigravityIsAuthenticated}
			antigravityUserEmail={overrides.antigravityUserEmail}
		/>,
	)
	return { setApiConfigurationField }
}

describe("Antigravity settings panel", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("unauthenticated state", () => {
		it("renders a Sign-in button when not authenticated", () => {
			setup({ antigravityIsAuthenticated: false })
			expect(screen.getByText("settings:providers.antigravity.signInButton")).toBeInTheDocument()
		})

		it("posts antigravitySignIn when the Sign-in button is clicked", () => {
			setup({ antigravityIsAuthenticated: false })
			const btn = screen.getByText("settings:providers.antigravity.signInButton")
			fireEvent.click(btn)
			expect(postMessageMock).toHaveBeenCalledWith({ type: "antigravitySignIn" })
		})

		it("does not render a Sign-out button when not authenticated", () => {
			setup({ antigravityIsAuthenticated: false })
			expect(screen.queryByText("settings:providers.antigravity.signOutButton")).toBeNull()
		})
	})

	describe("authenticated state", () => {
		it("renders 'Signed in as <email>' when an email is available", () => {
			setup({ antigravityIsAuthenticated: true, antigravityUserEmail: "alice@example.com" })
			expect(screen.getByText("settings:providers.antigravity.signedInAs|alice@example.com")).toBeInTheDocument()
		})

		it("renders generic 'Signed in' when no email is available", () => {
			setup({ antigravityIsAuthenticated: true })
			expect(screen.getByText("settings:providers.antigravity.signedIn")).toBeInTheDocument()
		})

		it("renders a Sign-out button when authenticated and posts antigravitySignOut on click", () => {
			setup({ antigravityIsAuthenticated: true })
			const out = screen.getByText("settings:providers.antigravity.signOutButton")
			expect(out).toBeInTheDocument()
			fireEvent.click(out)
			expect(postMessageMock).toHaveBeenCalledWith({ type: "antigravitySignOut" })
		})

		it("does not render a Sign-in button when authenticated", () => {
			setup({ antigravityIsAuthenticated: true })
			expect(screen.queryByText("settings:providers.antigravity.signInButton")).toBeNull()
		})
	})

	describe("project ID input", () => {
		it("renders the project ID input with the documented placeholder", () => {
			setup()
			expect(screen.getByPlaceholderText("your-gcp-project-id")).toBeInTheDocument()
		})

		it("displays the existing antigravityProjectId value when configured", () => {
			setup({ apiConfiguration: { antigravityProjectId: "my-gcp-project" } })
			expect(screen.getByDisplayValue("my-gcp-project")).toBeInTheDocument()
		})

		it("calls setApiConfigurationField with `antigravityProjectId` on input", () => {
			const { setApiConfigurationField } = setup()
			const input = screen.getByPlaceholderText("your-gcp-project-id")
			fireEvent.input(input, { target: { value: "new-project-id" } })
			expect(setApiConfigurationField).toHaveBeenCalledWith("antigravityProjectId", "new-project-id")
		})
	})

	describe("legacy CLI removal", () => {
		it("does NOT render the legacy CLI command anywhere", () => {
			setup()
			expect(screen.queryByText("cli-proxy-api login antigravity")).toBeNull()
		})

		it("does NOT render an OAuth credentials path field", () => {
			setup()
			expect(screen.queryByText("settings:providers.antigravity.oauthPath")).toBeNull()
			expect(screen.queryByText("settings:providers.antigravity.setupInstructions")).toBeNull()
		})
	})
})
