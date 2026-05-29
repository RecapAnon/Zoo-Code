import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { ANTIGRAVITY_OAUTH_CLIENT_ID, ANTIGRAVITY_OAUTH_CLIENT_SECRET, AntigravityOAuthManager } from "../oauth"

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
	return {
		...actual,
		promises: {
			...actual.promises,
			readFile: vi.fn(),
		},
	}
})

vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("i18next", () => ({
	t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
}))

const readFileMock = fs.readFile as unknown as ReturnType<typeof vi.fn>

const originalFetch = globalThis.fetch
const fetchMock = vi.fn()

beforeEach(() => {
	readFileMock.mockReset()
	fetchMock.mockReset()
	globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterAll(() => {
	globalThis.fetch = originalFetch
})

function makeValidCreds(
	overrides: Partial<{ access_token: string; refresh_token: string; expires_in: number; timestamp: number }> = {},
) {
	return {
		access_token: "live-token",
		refresh_token: "refresh-token",
		expires_in: 3600,
		timestamp: Date.now(),
		type: "antigravity",
		...overrides,
	}
}

describe("AntigravityOAuthManager.ensureAuthenticated", () => {
	it("loads credentials from the default path when no custom path is set", async () => {
		const creds = makeValidCreds()
		readFileMock.mockResolvedValueOnce(JSON.stringify(creds))

		const manager = new AntigravityOAuthManager()
		const result = await manager.ensureAuthenticated()

		const expectedPath = path.join(os.homedir(), ".antigravity", "antigravity.json")
		expect(readFileMock).toHaveBeenCalledWith(expectedPath, "utf-8")
		expect(result.access_token).toBe("live-token")
	})

	it("defaults to the ~/.antigravity directory (not the legacy third-party dir)", async () => {
		const creds = makeValidCreds()
		readFileMock.mockResolvedValueOnce(JSON.stringify(creds))

		const manager = new AntigravityOAuthManager()
		await manager.ensureAuthenticated()

		const calledPath = readFileMock.mock.calls[0]?.[0] as string
		expect(calledPath).toBeDefined()
		const parsed = path.parse(calledPath)
		expect(parsed.base).toBe("antigravity.json")
		expect(path.basename(parsed.dir)).toBe(".antigravity")
	})

	it("expands ~ in a custom credential path", async () => {
		const creds = makeValidCreds()
		readFileMock.mockResolvedValueOnce(JSON.stringify(creds))

		const manager = new AntigravityOAuthManager()
		await manager.ensureAuthenticated({ path: "~/custom/creds.json" })

		const expectedPath = path.join(os.homedir(), "custom", "creds.json")
		expect(readFileMock).toHaveBeenCalledWith(expectedPath, "utf-8")
	})

	it("throws oauthLoadFailed when access_token is missing", async () => {
		readFileMock.mockResolvedValueOnce(JSON.stringify({ refresh_token: "x" }))
		const manager = new AntigravityOAuthManager()

		await expect(manager.ensureAuthenticated()).rejects.toThrow(/oauthLoadFailed/)
	})

	it("throws oauthLoadFailed when file cannot be read", async () => {
		readFileMock.mockRejectedValueOnce(new Error("ENOENT"))
		const manager = new AntigravityOAuthManager()

		await expect(manager.ensureAuthenticated()).rejects.toThrow(/oauthLoadFailed/)
	})

	it("refreshes an expired token using form-urlencoded refresh_token grant", async () => {
		const expiredCreds = makeValidCreds({
			access_token: "old-token",
			expires_in: 3600,
			// Far in the past so isTokenExpired returns true.
			timestamp: Date.now() - 7200 * 1000,
		})
		readFileMock.mockResolvedValueOnce(JSON.stringify(expiredCreds))

		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ access_token: "new-token", expires_in: 1800 }),
		})

		const manager = new AntigravityOAuthManager()
		const result = await manager.ensureAuthenticated()

		expect(result.access_token).toBe("new-token")
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const [url, init] = fetchMock.mock.calls[0]
		expect(url).toBe("https://oauth2.googleapis.com/token")
		expect((init as RequestInit).method).toBe("POST")
		const headers = (init as RequestInit).headers as Record<string, string>
		expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded")

		const body = new URLSearchParams(String((init as RequestInit).body))
		expect(body.get("client_id")).toBe(ANTIGRAVITY_OAUTH_CLIENT_ID)
		expect(body.get("client_secret")).toBe(ANTIGRAVITY_OAUTH_CLIENT_SECRET)
		expect(body.get("grant_type")).toBe("refresh_token")
		expect(body.get("refresh_token")).toBe("refresh-token")
	})

	it("dedupes concurrent refresh attempts into a single HTTP call", async () => {
		const expiredCreds = makeValidCreds({
			access_token: "old-token",
			timestamp: Date.now() - 7200 * 1000,
		})
		// Two concurrent callers will both load credentials, but only one refresh should fire.
		readFileMock.mockResolvedValue(JSON.stringify(expiredCreds))

		let resolveRefresh: ((v: { access_token: string; expires_in: number }) => void) | undefined
		fetchMock.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveRefresh = (v) =>
					resolve({
						ok: true,
						status: 200,
						json: async () => v,
					} as unknown as Response)
			}),
		)

		const manager = new AntigravityOAuthManager()
		const a = manager.ensureAuthenticated()
		const b = manager.ensureAuthenticated()

		// Allow microtasks to schedule the in-flight refresh promise.
		await Promise.resolve()
		resolveRefresh!({ access_token: "fresh", expires_in: 3600 })

		const [resA, resB] = await Promise.all([a, b])
		expect(resA.access_token).toBe("fresh")
		expect(resB.access_token).toBe("fresh")
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it("throws tokenRefreshFailed when refresh response is not OK", async () => {
		const expiredCreds = makeValidCreds({
			timestamp: Date.now() - 7200 * 1000,
		})
		readFileMock.mockResolvedValueOnce(JSON.stringify(expiredCreds))

		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 400,
			text: async () => '{"error":"invalid_grant"}',
		})

		const manager = new AntigravityOAuthManager()
		await expect(manager.ensureAuthenticated()).rejects.toThrow(/tokenRefreshFailed/)
	})

	it("throws tokenRefreshFailed when refresh_token is missing on expired creds", async () => {
		const expiredCreds = {
			access_token: "old-token",
			expires_in: 3600,
			timestamp: Date.now() - 7200 * 1000,
		}
		readFileMock.mockResolvedValueOnce(JSON.stringify(expiredCreds))

		const manager = new AntigravityOAuthManager()
		await expect(manager.ensureAuthenticated()).rejects.toThrow(/tokenRefreshFailed/)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe("AntigravityOAuthManager.forceRefresh", () => {
	it("refreshes regardless of local expiry state", async () => {
		const creds = makeValidCreds()
		readFileMock.mockResolvedValueOnce(JSON.stringify(creds))
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ access_token: "rotated", expires_in: 3600 }),
		})

		const manager = new AntigravityOAuthManager()
		const result = await manager.forceRefresh()

		expect(result.access_token).toBe("rotated")
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})
})

describe("AntigravityOAuthManager corrupt credentials", () => {
	it("throws oauthLoadFailed when the credential file is not valid JSON", async () => {
		readFileMock.mockResolvedValueOnce("{ not valid json")
		const manager = new AntigravityOAuthManager()

		await expect(manager.ensureAuthenticated()).rejects.toThrow(/oauthLoadFailed/)
		// Ensure we never attempted a refresh on corrupt input.
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
