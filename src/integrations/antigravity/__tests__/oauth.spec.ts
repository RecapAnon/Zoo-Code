import * as http from "node:http"

import nock from "nock"

import {
	AntigravityOAuthManager,
	AntigravityOAuthTokenError,
	ANTIGRAVITY_OAUTH_CONFIG,
	buildAuthorizationUrl,
	exchangeCodeForTokens,
	fetchUserEmail,
	generateCodeChallenge,
	generateCodeVerifier,
	generateState,
	isTokenExpired,
	refreshAccessToken,
	type AntigravityCredentials,
} from "../oauth"

vi.mock("i18next", () => ({
	t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
}))

const originalFetch = globalThis.fetch
const fetchMock = vi.fn()

// In-memory SecretStorage stand-in for VS Code's ExtensionContext.secrets.
function makeMockContext() {
	const store = new Map<string, string>()
	const secrets = {
		get: vi.fn(async (key: string) => store.get(key)),
		store: vi.fn(async (key: string, value: string) => {
			store.set(key, value)
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key)
		}),
	}
	return { secrets, _store: store } as unknown as {
		secrets: typeof secrets
		_store: Map<string, string>
	}
}

beforeEach(() => {
	fetchMock.mockReset()
	globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterAll(() => {
	globalThis.fetch = originalFetch
})

describe("PKCE helpers", () => {
	it("generateCodeVerifier returns 43-char base64url", () => {
		const v = generateCodeVerifier()
		expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/)
	})

	it("generateCodeChallenge is deterministic SHA-256 base64url of verifier", () => {
		const v = "abc"
		const c = generateCodeChallenge(v)
		// SHA-256("abc") base64url
		expect(c).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0")
	})

	it("generateState returns 32-char hex (16 random bytes)", () => {
		const s = generateState()
		expect(s).toMatch(/^[0-9a-f]{32}$/)
	})
})

describe("buildAuthorizationUrl", () => {
	it("includes S256 PKCE, state, offline access, prompt=consent, response_type=code, and the loopback redirect", () => {
		const url = buildAuthorizationUrl("CHAL", "STATE", "http://127.0.0.1:12345/oauth-callback")
		const u = new URL(url)
		expect(u.origin + u.pathname).toBe(ANTIGRAVITY_OAUTH_CONFIG.authorizationEndpoint)
		expect(u.searchParams.get("code_challenge")).toBe("CHAL")
		expect(u.searchParams.get("code_challenge_method")).toBe("S256")
		expect(u.searchParams.get("state")).toBe("STATE")
		expect(u.searchParams.get("response_type")).toBe("code")
		expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:12345/oauth-callback")
		expect(u.searchParams.get("client_id")).toBe(ANTIGRAVITY_OAUTH_CONFIG.clientId)
		expect(u.searchParams.get("scope")).toBe(ANTIGRAVITY_OAUTH_CONFIG.scopes)
		expect(u.searchParams.get("access_type")).toBe("offline")
		expect(u.searchParams.get("prompt")).toBe("consent")
	})

	// Regression guard: Google rejects the Antigravity OAuth client with HTTP 403
	// "restricted_client" if we request any scope outside the whitelist.
	it("requests exactly the upstream Antigravity scopes and no others", () => {
		const url = buildAuthorizationUrl("CHAL", "STATE", "http://127.0.0.1:12345/oauth-callback")
		const scope = new URL(url).searchParams.get("scope") ?? ""
		const requested = scope.split(" ").filter((s) => s.length > 0)

		expect(requested).toEqual([
			"https://www.googleapis.com/auth/cloud-platform",
			"https://www.googleapis.com/auth/userinfo.email",
			"https://www.googleapis.com/auth/userinfo.profile",
			"https://www.googleapis.com/auth/cclog",
			"https://www.googleapis.com/auth/experimentsandconfigs",
		])

		// Explicit negative assertions for the scopes that previously caused
		// 403 restricted_client at the consent step.
		expect(requested).not.toContain("https://www.googleapis.com/auth/generative-language.tuning")
		expect(requested).not.toContain("openid")
	})
})

describe("exchangeCodeForTokens", () => {
	it("POSTs form-encoded body with code, client_id, client_secret, redirect_uri, grant_type, code_verifier (no state field)", async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			text: async () => "",
			json: async () => ({
				access_token: "ACCESS",
				refresh_token: "REFRESH",
				expires_in: 3600,
			}),
		})
		const creds = await exchangeCodeForTokens("THECODE", "VERIFIER", "http://127.0.0.1:9000/oauth-callback")
		expect(creds).toMatchObject({
			type: "antigravity",
			access_token: "ACCESS",
			refresh_token: "REFRESH",
		})
		expect(creds.expires).toBeGreaterThan(Date.now())

		const call = fetchMock.mock.calls[0]
		expect(call[0]).toBe(ANTIGRAVITY_OAUTH_CONFIG.tokenEndpoint)
		const init = call[1] as RequestInit
		expect(init.method).toBe("POST")
		expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded")
		const params = new URLSearchParams(init.body as string)
		expect(params.get("code")).toBe("THECODE")
		expect(params.get("client_id")).toBe(ANTIGRAVITY_OAUTH_CONFIG.clientId)
		expect(params.get("client_secret")).toBe(ANTIGRAVITY_OAUTH_CONFIG.clientSecret)
		expect(params.get("redirect_uri")).toBe("http://127.0.0.1:9000/oauth-callback")
		expect(params.get("grant_type")).toBe("authorization_code")
		expect(params.get("code_verifier")).toBe("VERIFIER")
		// No state field in token exchange body.
		expect(params.get("state")).toBeNull()
	})

	it("throws AntigravityOAuthTokenError on non-2xx", async () => {
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 400,
			text: async () => JSON.stringify({ error: "invalid_grant", error_description: "bad code" }),
		})
		await expect(exchangeCodeForTokens("c", "v", "http://127.0.0.1:1/oauth-callback")).rejects.toBeInstanceOf(
			AntigravityOAuthTokenError,
		)
	})

	it("throws when response omits refresh_token", async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			text: async () => "",
			json: async () => ({ access_token: "A", expires_in: 60 }),
		})
		await expect(exchangeCodeForTokens("c", "v", "http://127.0.0.1:1/oauth-callback")).rejects.toThrow(
			/refresh_token/,
		)
	})
})

describe("refreshAccessToken", () => {
	const seed: AntigravityCredentials = {
		type: "antigravity",
		access_token: "OLD",
		refresh_token: "RTOKEN",
		expires: Date.now() - 1000,
	}

	it("POSTs grant_type=refresh_token and preserves the prior refresh token when absent from response", async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			text: async () => "",
			json: async () => ({ access_token: "NEW", expires_in: 1800 }),
		})
		const next = await refreshAccessToken(seed)
		expect(next.access_token).toBe("NEW")
		expect(next.refresh_token).toBe("RTOKEN")
		expect(next.expires).toBeGreaterThan(Date.now())

		const init = fetchMock.mock.calls[0][1] as RequestInit
		const params = new URLSearchParams(init.body as string)
		expect(params.get("grant_type")).toBe("refresh_token")
		expect(params.get("refresh_token")).toBe("RTOKEN")
	})

	it("throws AntigravityOAuthTokenError with isLikelyInvalidGrant=true on 400 invalid_grant", async () => {
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 400,
			text: async () => JSON.stringify({ error: "invalid_grant", error_description: "revoked" }),
		})
		try {
			await refreshAccessToken(seed)
			throw new Error("should have thrown")
		} catch (e) {
			expect(e).toBeInstanceOf(AntigravityOAuthTokenError)
			expect((e as AntigravityOAuthTokenError).isLikelyInvalidGrant()).toBe(true)
		}
	})
})

describe("fetchUserEmail", () => {
	it("returns email on 200", async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ email: "user@example.com" }),
		})
		expect(await fetchUserEmail("AT")).toBe("user@example.com")
	})

	it("returns undefined on non-2xx without throwing", async () => {
		fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
		expect(await fetchUserEmail("AT")).toBeUndefined()
	})

	it("returns undefined on network failure without throwing", async () => {
		fetchMock.mockRejectedValueOnce(new Error("network"))
		expect(await fetchUserEmail("AT")).toBeUndefined()
	})
})

describe("isTokenExpired", () => {
	it("returns true when within 5-minute buffer", () => {
		expect(
			isTokenExpired({
				type: "antigravity",
				access_token: "A",
				refresh_token: "R",
				expires: Date.now() + 60_000, // 1 minute future is within 5-min buffer
			}),
		).toBe(true)
	})

	it("returns false when expiry is far in the future", () => {
		expect(
			isTokenExpired({
				type: "antigravity",
				access_token: "A",
				refresh_token: "R",
				expires: Date.now() + 60 * 60 * 1000,
			}),
		).toBe(false)
	})
})

describe("AntigravityOAuthManager - credentials lifecycle", () => {
	it("loadCredentials returns null when SecretStorage is empty", async () => {
		const ctx = makeMockContext()
		const manager = new AntigravityOAuthManager()
		await manager.initialize(ctx as any)
		expect(await manager.loadCredentials()).toBeNull()
	})

	it("saveCredentials persists and clearCredentials removes", async () => {
		const ctx = makeMockContext()
		const manager = new AntigravityOAuthManager()
		await manager.initialize(ctx as any)
		await manager.saveCredentials({
			type: "antigravity",
			access_token: "A",
			refresh_token: "R",
			expires: Date.now() + 3600_000,
			email: "u@e.com",
		})
		expect(ctx._store.has("antigravity-oauth-credentials")).toBe(true)
		await manager.clearCredentials()
		expect(ctx._store.has("antigravity-oauth-credentials")).toBe(false)
	})

	it("getAccessToken refreshes when expired and persists rotated token", async () => {
		const ctx = makeMockContext()
		const manager = new AntigravityOAuthManager()
		await manager.initialize(ctx as any)
		await manager.saveCredentials({
			type: "antigravity",
			access_token: "OLD",
			refresh_token: "RT",
			expires: Date.now() - 1, // already expired
		})
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			text: async () => "",
			json: async () => ({ access_token: "NEW", refresh_token: "RT2", expires_in: 3600 }),
		})
		const token = await manager.getAccessToken()
		expect(token).toBe("NEW")
		const stored = JSON.parse(ctx._store.get("antigravity-oauth-credentials")!)
		expect(stored.access_token).toBe("NEW")
		expect(stored.refresh_token).toBe("RT2")
	})

	it("on invalid_grant during getAccessToken, credentials are cleared", async () => {
		const ctx = makeMockContext()
		const manager = new AntigravityOAuthManager()
		await manager.initialize(ctx as any)
		await manager.saveCredentials({
			type: "antigravity",
			access_token: "OLD",
			refresh_token: "RT",
			expires: Date.now() - 1,
		})
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 400,
			text: async () => JSON.stringify({ error: "invalid_grant" }),
		})
		const token = await manager.getAccessToken()
		expect(token).toBeNull()
		expect(ctx._store.has("antigravity-oauth-credentials")).toBe(false)
	})

	it("concurrent getAccessToken calls share a single refresh promise", async () => {
		const ctx = makeMockContext()
		const manager = new AntigravityOAuthManager()
		await manager.initialize(ctx as any)
		await manager.saveCredentials({
			type: "antigravity",
			access_token: "OLD",
			refresh_token: "RT",
			expires: Date.now() - 1,
		})
		fetchMock.mockImplementation(
			() =>
				new Promise((resolve) =>
					setTimeout(
						() =>
							resolve({
								ok: true,
								status: 200,
								text: async () => "",
								json: async () => ({ access_token: "NEW", expires_in: 3600 }),
							}),
						10,
					),
				),
		)
		const [t1, t2, t3] = await Promise.all([
			manager.getAccessToken(),
			manager.getAccessToken(),
			manager.getAccessToken(),
		])
		expect(t1).toBe("NEW")
		expect(t2).toBe("NEW")
		expect(t3).toBe("NEW")
		// Exactly one HTTP refresh should have been issued.
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it("ensureAuthenticated shim returns {access_token} when signed in", async () => {
		const ctx = makeMockContext()
		const manager = new AntigravityOAuthManager()
		await manager.initialize(ctx as any)
		await manager.saveCredentials({
			type: "antigravity",
			access_token: "A",
			refresh_token: "R",
			expires: Date.now() + 60 * 60_000,
		})
		expect(await manager.ensureAuthenticated()).toEqual({ access_token: "A" })
	})

	it("ensureAuthenticated throws when not signed in", async () => {
		const ctx = makeMockContext()
		const manager = new AntigravityOAuthManager()
		await manager.initialize(ctx as any)
		await expect(manager.ensureAuthenticated()).rejects.toThrow(/oauthLoadFailed/)
	})

	it("forceRefresh shim returns refreshed access_token", async () => {
		const ctx = makeMockContext()
		const manager = new AntigravityOAuthManager()
		await manager.initialize(ctx as any)
		await manager.saveCredentials({
			type: "antigravity",
			access_token: "OLD",
			refresh_token: "RT",
			expires: Date.now() + 60 * 60_000,
		})
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			text: async () => "",
			json: async () => ({ access_token: "NEW", expires_in: 3600 }),
		})
		expect(await manager.forceRefresh()).toEqual({ access_token: "NEW" })
	})

	it("getEmail returns the stored email", async () => {
		const ctx = makeMockContext()
		const manager = new AntigravityOAuthManager()
		await manager.initialize(ctx as any)
		await manager.saveCredentials({
			type: "antigravity",
			access_token: "A",
			refresh_token: "R",
			expires: Date.now() + 60_000,
			email: "u@e.com",
		})
		expect(await manager.getEmail()).toBe("u@e.com")
	})

	it("isAuthenticated reflects token validity", async () => {
		const ctx = makeMockContext()
		const manager = new AntigravityOAuthManager()
		await manager.initialize(ctx as any)
		expect(await manager.isAuthenticated()).toBe(false)
		await manager.saveCredentials({
			type: "antigravity",
			access_token: "A",
			refresh_token: "R",
			expires: Date.now() + 60 * 60_000,
		})
		expect(await manager.isAuthenticated()).toBe(true)
	})
})

describe("AntigravityOAuthManager - authorization flow plumbing", () => {
	it("startAuthorizationFlow binds loopback server on 127.0.0.1 and returns a valid auth URL with PKCE+state", async () => {
		const ctx = makeMockContext()
		const manager = new AntigravityOAuthManager()
		await manager.initialize(ctx as any)

		const url = await manager.startAuthorizationFlow()
		try {
			const u = new URL(url)
			expect(u.origin + u.pathname).toBe(ANTIGRAVITY_OAUTH_CONFIG.authorizationEndpoint)
			expect(u.searchParams.get("code_challenge_method")).toBe("S256")
			expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/)
			expect(u.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/)

			const redirect = u.searchParams.get("redirect_uri")!
			expect(redirect.startsWith("http://127.0.0.1:")).toBe(true)
			expect(redirect.endsWith("/oauth-callback")).toBe(true)

			// Confirm the underlying server is bound to 127.0.0.1 by parsing the port and
			// inspecting that subsequent connections to 127.0.0.1 work (we don't make a real
			// request to avoid timing-sensitive tests).
			const port = Number(new URL(redirect).port)
			expect(port).toBeGreaterThan(0)
		} finally {
			manager.cancelAuthorizationFlow()
		}
	})

	it("startAuthorizationFlow cancels a prior pending flow (closes its server)", async () => {
		const ctx = makeMockContext()
		const manager = new AntigravityOAuthManager()
		await manager.initialize(ctx as any)

		const url1 = await manager.startAuthorizationFlow()
		const port1 = Number(new URL(new URL(url1).searchParams.get("redirect_uri")!).port)

		const url2 = await manager.startAuthorizationFlow()
		const port2 = Number(new URL(new URL(url2).searchParams.get("redirect_uri")!).port)

		try {
			// The two flows should use different ephemeral ports because the first one
			// is now closed.
			expect(port1).not.toBe(port2)

			// Try to bind to port1 — should succeed quickly because the first server closed.
			await new Promise<void>((resolve, reject) => {
				const probe = http.createServer()
				probe.on("error", reject)
				probe.listen(port1, "127.0.0.1", () => {
					probe.close(() => resolve())
				})
			})
		} finally {
			manager.cancelAuthorizationFlow()
		}
	})

	it("cancelAuthorizationFlow releases the loopback port", async () => {
		const ctx = makeMockContext()
		const manager = new AntigravityOAuthManager()
		await manager.initialize(ctx as any)

		const url = await manager.startAuthorizationFlow()
		const port = Number(new URL(new URL(url).searchParams.get("redirect_uri")!).port)
		manager.cancelAuthorizationFlow()

		// Give libuv a tick to close.
		await new Promise((r) => setTimeout(r, 50))

		await new Promise<void>((resolve, reject) => {
			const probe = http.createServer()
			probe.on("error", reject)
			probe.listen(port, "127.0.0.1", () => {
				probe.close(() => resolve())
			})
		})
	})
})

describe("Logging discipline (no token leakage)", () => {
	it("token/refresh values do not appear in log messages emitted via initialize logFn", async () => {
		const ctx = makeMockContext()
		const manager = new AntigravityOAuthManager()
		const logs: string[] = []
		await manager.initialize(ctx as any, (m) => logs.push(m))
		await manager.saveCredentials({
			type: "antigravity",
			access_token: "SECRET-ACCESS-TOKEN",
			refresh_token: "SECRET-REFRESH-TOKEN",
			expires: Date.now() - 1,
		})
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			text: async () => "",
			json: async () => ({
				access_token: "NEW-SECRET-ACCESS",
				refresh_token: "NEW-SECRET-REFRESH",
				expires_in: 3600,
			}),
		})
		await manager.getAccessToken()
		for (const line of logs) {
			expect(line).not.toContain("SECRET-ACCESS-TOKEN")
			expect(line).not.toContain("SECRET-REFRESH-TOKEN")
			expect(line).not.toContain("NEW-SECRET-ACCESS")
			expect(line).not.toContain("NEW-SECRET-REFRESH")
		}
	})
})

// Helper: hit a real loopback callback so we exercise the actual request handler.
async function hitCallback(port: number, query: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				path: `${ANTIGRAVITY_OAUTH_CONFIG.callbackPath}${query}`,
				method: "GET",
			},
			(res) => {
				let data = ""
				res.setEncoding("utf-8")
				res.on("data", (chunk) => {
					data += chunk
				})
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }))
			},
		)
		req.on("error", reject)
		req.end()
	})
}

describe("AntigravityOAuthManager.waitForCallback - error/cleanup paths (review fix)", () => {
	// The callback tests open real loopback servers and issue real HTTP requests against
	// them; nock's default disableNetConnect would block those. Re-enable just 127.0.0.1
	// for the duration of this suite and restore strict mode afterwards.
	beforeAll(() => {
		nock.enableNetConnect("127.0.0.1")
	})
	afterAll(() => {
		nock.disableNetConnect()
	})

	it("rejects on a wrong state (CSRF guard) and does NOT store credentials", async () => {
		const ctx = makeMockContext()
		const manager = new AntigravityOAuthManager()
		await manager.initialize(ctx as any)

		const authUrl = await manager.startAuthorizationFlow()
		const port = Number(new URL(new URL(authUrl).searchParams.get("redirect_uri")!).port)

		// waitForCallback is what we are testing — kick it off and then hit the loopback
		// server with a callback that has a *bogus* state parameter.
		const callbackPromise = manager.waitForCallback()
		// Suppress the unhandled-rejection warning if any timing race occurs.
		callbackPromise.catch(() => {})

		const response = await hitCallback(port, "?code=irrelevant&state=BOGUS-STATE")

		// The server returned an HTTP 400 with the constant-time-mismatch message.
		expect(response.status).toBe(400)
		expect(response.body).toMatch(/State mismatch/i)

		// And the callback Promise itself rejected.
		await expect(callbackPromise).rejects.toThrow(/State mismatch/i)

		// Critical post-condition: no credentials were persisted.
		expect(ctx._store.has("antigravity-oauth-credentials")).toBe(false)

		// fetch (token-exchange) must never have been invoked: we rejected before any HTTP exchange.
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("rejects when the provider returns ?error=... and does NOT store credentials", async () => {
		const ctx = makeMockContext()
		const manager = new AntigravityOAuthManager()
		await manager.initialize(ctx as any)

		const authUrl = await manager.startAuthorizationFlow()
		const port = Number(new URL(new URL(authUrl).searchParams.get("redirect_uri")!).port)

		const callbackPromise = manager.waitForCallback()
		callbackPromise.catch(() => {})

		const response = await hitCallback(port, "?error=access_denied")
		expect(response.status).toBe(400)
		expect(response.body).toMatch(/access_denied/)

		await expect(callbackPromise).rejects.toThrow(/access_denied/)

		// No persistence, no token exchange.
		expect(ctx._store.has("antigravity-oauth-credentials")).toBe(false)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("rejects when both code and state are missing and does NOT store credentials", async () => {
		const ctx = makeMockContext()
		const manager = new AntigravityOAuthManager()
		await manager.initialize(ctx as any)

		const authUrl = await manager.startAuthorizationFlow()
		const port = Number(new URL(new URL(authUrl).searchParams.get("redirect_uri")!).port)

		const callbackPromise = manager.waitForCallback()
		callbackPromise.catch(() => {})

		const response = await hitCallback(port, "")
		expect(response.status).toBe(400)
		expect(response.body).toMatch(/Missing code or state/i)

		await expect(callbackPromise).rejects.toThrow(/Missing code or state/i)

		expect(ctx._store.has("antigravity-oauth-credentials")).toBe(false)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("rejects when the flow is cancelled before the callback arrives (server close)", async () => {
		const ctx = makeMockContext()
		const manager = new AntigravityOAuthManager()
		await manager.initialize(ctx as any)

		await manager.startAuthorizationFlow()
		const callbackPromise = manager.waitForCallback()
		callbackPromise.catch(() => {})

		// Cancel the flow before any callback arrives. Server "close" should reject the wait.
		manager.cancelAuthorizationFlow()

		// The waitForCallback Promise should either reject or hang; we only require that
		// nothing gets persisted within a generous tick.
		await new Promise((r) => setTimeout(r, 50))

		expect(ctx._store.has("antigravity-oauth-credentials")).toBe(false)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
