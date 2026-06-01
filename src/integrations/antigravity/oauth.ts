import * as crypto from "node:crypto"
import * as http from "node:http"
import { URL } from "node:url"

import { t } from "i18next"
import type { ExtensionContext } from "vscode"
import { z } from "zod"

// OAuth client and endpoint configuration for the Antigravity provider.
export const ANTIGRAVITY_OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
export const ANTIGRAVITY_OAUTH_CLIENT_SECRET = "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"

export const ANTIGRAVITY_OAUTH_CONFIG = {
	authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
	tokenEndpoint: "https://oauth2.googleapis.com/token",
	userInfoEndpoint: "https://www.googleapis.com/oauth2/v2/userinfo",
	clientId: ANTIGRAVITY_OAUTH_CLIENT_ID,
	clientSecret: ANTIGRAVITY_OAUTH_CLIENT_SECRET,
	scopes: [
		"https://www.googleapis.com/auth/cloud-platform",
		"https://www.googleapis.com/auth/userinfo.email",
		"https://www.googleapis.com/auth/userinfo.profile",
		"https://www.googleapis.com/auth/cclog",
		"https://www.googleapis.com/auth/experimentsandconfigs",
	].join(" "),
	callbackPath: "/oauth-callback",
	// RFC 8252: bind to the IPv4 literal loopback, not "localhost" (DNS-resolvable) or "0.0.0.0".
	callbackHost: "127.0.0.1",
	// Range of ports to try before giving up; ephemeral by default.
	maxPortBindRetries: 5,
} as const

// SecretStorage key for persisted tokens.
const ANTIGRAVITY_CREDENTIALS_KEY = "antigravity-oauth-credentials"

// 5-minute buffer when evaluating expiry; matches the established Claude Code pattern.
const REFRESH_BUFFER_MS = 5 * 60 * 1000
// 5 minute timeout for the entire authorization flow before we close the loopback server.
const AUTHORIZATION_FLOW_TIMEOUT_MS = 5 * 60 * 1000
// Default lifetime if the token endpoint omits expires_in (defensive fallback only).
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600

/**
 * Credentials persisted in SecretStorage.
 *
 * `expires` is an absolute millisecond timestamp (`Date.now()` style) instead of a
 * relative `expires_in` — simpler than re-resolving against a `timestamp` baseline.
 */
const antigravityCredentialsSchema = z.object({
	type: z.literal("antigravity"),
	access_token: z.string().min(1),
	refresh_token: z.string().min(1),
	expires: z.number(),
	email: z.string().optional(),
})

export type AntigravityCredentials = z.infer<typeof antigravityCredentialsSchema>

const tokenResponseSchema = z.object({
	access_token: z.string().min(1),
	// Refresh responses may omit refresh_token (common OAuth behavior); callers preserve the prior one.
	refresh_token: z.string().min(1).optional(),
	expires_in: z.number().optional(),
	token_type: z.string().optional(),
	scope: z.string().optional(),
	id_token: z.string().optional(),
})

/**
 * Typed OAuth token error so callers can detect invalid_grant and prune stored credentials.
 */
export class AntigravityOAuthTokenError extends Error {
	public readonly status?: number
	public readonly errorCode?: string

	constructor(message: string, opts?: { status?: number; errorCode?: string }) {
		super(message)
		this.name = "AntigravityOAuthTokenError"
		this.status = opts?.status
		this.errorCode = opts?.errorCode
	}

	public isLikelyInvalidGrant(): boolean {
		if (this.errorCode && /invalid_grant/i.test(this.errorCode)) {
			return true
		}
		if (this.status === 400 || this.status === 401 || this.status === 403) {
			return /invalid_grant|revoked|expired|invalid refresh/i.test(this.message)
		}
		return false
	}
}

function parseOAuthErrorDetails(errorText: string): { errorCode?: string; errorMessage?: string } {
	try {
		const json: unknown = JSON.parse(errorText)
		if (!json || typeof json !== "object") {
			return {}
		}
		const obj = json as Record<string, unknown>
		const errorField = obj.error
		const errorCode = typeof errorField === "string" ? errorField : undefined
		const errorDescription = obj.error_description
		const errorMessage = typeof errorDescription === "string" ? errorDescription : undefined
		return { errorCode, errorMessage }
	} catch {
		return {}
	}
}

/**
 * PKCE code verifier: 32 random bytes base64url-encoded → 43 chars, in the RFC 7636 unreserved set.
 */
export function generateCodeVerifier(): string {
	return crypto.randomBytes(32).toString("base64url")
}

/**
 * PKCE S256 challenge: SHA-256 of the verifier, base64url-encoded.
 */
export function generateCodeChallenge(verifier: string): string {
	return crypto.createHash("sha256").update(verifier).digest().toString("base64url")
}

/**
 * Random opaque state for CSRF binding of the callback to the request.
 */
export function generateState(): string {
	return crypto.randomBytes(16).toString("hex")
}

/**
 * Build the authorization URL for the consent screen.
 */
export function buildAuthorizationUrl(codeChallenge: string, state: string, redirectUri: string): string {
	const params = new URLSearchParams({
		client_id: ANTIGRAVITY_OAUTH_CONFIG.clientId,
		redirect_uri: redirectUri,
		scope: ANTIGRAVITY_OAUTH_CONFIG.scopes,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
		response_type: "code",
		state,
		access_type: "offline",
		prompt: "consent",
	})
	return `${ANTIGRAVITY_OAUTH_CONFIG.authorizationEndpoint}?${params.toString()}`
}

/**
 * Exchange the authorization code for access + refresh tokens.
 * Sends client_secret (matches the existing refresh flow and Google's web-app-typed client
 * registration expectations); PKCE verifier is the actual public-client mitigation.
 */
export async function exchangeCodeForTokens(
	code: string,
	codeVerifier: string,
	redirectUri: string,
): Promise<AntigravityCredentials> {
	const body = new URLSearchParams({
		code,
		client_id: ANTIGRAVITY_OAUTH_CONFIG.clientId,
		client_secret: ANTIGRAVITY_OAUTH_CONFIG.clientSecret,
		redirect_uri: redirectUri,
		grant_type: "authorization_code",
		code_verifier: codeVerifier,
	})

	const response = await fetch(ANTIGRAVITY_OAUTH_CONFIG.tokenEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: body.toString(),
		signal: AbortSignal.timeout(30_000),
	})

	if (!response.ok) {
		let errorText = ""
		try {
			errorText = await response.text()
		} catch {
			// ignore body read failure
		}
		const { errorCode, errorMessage } = parseOAuthErrorDetails(errorText)
		// We deliberately do not echo the raw response body when it may contain sensitive fragments;
		// only include the structured fields we parsed.
		const details = errorMessage ?? errorCode ?? `HTTP ${response.status}`
		throw new AntigravityOAuthTokenError(`Token exchange failed: ${details}`, {
			status: response.status,
			errorCode,
		})
	}

	const raw = (await response.json()) as unknown
	const parsed = tokenResponseSchema.parse(raw)

	if (!parsed.refresh_token) {
		// The access token is unusable without a refresh token across restarts.
		throw new Error("Token exchange did not return a refresh_token")
	}

	const expiresInSeconds = typeof parsed.expires_in === "number" ? parsed.expires_in : DEFAULT_TOKEN_LIFETIME_SECONDS
	const expires = Date.now() + expiresInSeconds * 1000

	return {
		type: "antigravity",
		access_token: parsed.access_token,
		refresh_token: parsed.refresh_token,
		expires,
	}
}

/**
 * Refresh the access token using the stored refresh token.
 * Throws AntigravityOAuthTokenError so callers can detect invalid_grant and clear secrets.
 */
export async function refreshAccessToken(credentials: AntigravityCredentials): Promise<AntigravityCredentials> {
	const body = new URLSearchParams({
		client_id: ANTIGRAVITY_OAUTH_CONFIG.clientId,
		client_secret: ANTIGRAVITY_OAUTH_CONFIG.clientSecret,
		grant_type: "refresh_token",
		refresh_token: credentials.refresh_token,
	})

	const response = await fetch(ANTIGRAVITY_OAUTH_CONFIG.tokenEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: body.toString(),
		signal: AbortSignal.timeout(30_000),
	})

	if (!response.ok) {
		let errorText = ""
		try {
			errorText = await response.text()
		} catch {
			// ignore body read failure
		}
		const { errorCode, errorMessage } = parseOAuthErrorDetails(errorText)
		const details = errorMessage ?? errorCode ?? `HTTP ${response.status}`
		throw new AntigravityOAuthTokenError(`Token refresh failed: ${details}`, {
			status: response.status,
			errorCode,
		})
	}

	const raw = (await response.json()) as unknown
	const parsed = tokenResponseSchema.parse(raw)

	const expiresInSeconds = typeof parsed.expires_in === "number" ? parsed.expires_in : DEFAULT_TOKEN_LIFETIME_SECONDS
	const expires = Date.now() + expiresInSeconds * 1000

	return {
		type: "antigravity",
		access_token: parsed.access_token,
		// Google may rotate the refresh token; preserve the prior one when absent.
		refresh_token: parsed.refresh_token ?? credentials.refresh_token,
		expires,
		email: credentials.email,
	}
}

/**
 * Fetch the authenticated user's email. Best-effort: any failure returns undefined.
 */
export async function fetchUserEmail(accessToken: string): Promise<string | undefined> {
	try {
		const response = await fetch(`${ANTIGRAVITY_OAUTH_CONFIG.userInfoEndpoint}?alt=json`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/json",
			},
			signal: AbortSignal.timeout(10_000),
		})
		if (!response.ok) {
			return undefined
		}
		const json = (await response.json()) as { email?: unknown }
		return typeof json?.email === "string" ? json.email : undefined
	} catch {
		return undefined
	}
}

/**
 * Returns true if the credential is expired or within the refresh buffer window.
 */
export function isTokenExpired(credentials: AntigravityCredentials): boolean {
	return Date.now() >= credentials.expires - REFRESH_BUFFER_MS
}

interface PendingAuthorizationFlow {
	codeVerifier: string
	state: string
	redirectUri: string
	port: number
	server?: http.Server
}

/**
 * AntigravityOAuthManager
 *
 * Owns the native PKCE-based OAuth flow, SecretStorage-backed token persistence, refresh
 * single-flighting, and invalid_grant cleanup.
 *
 * Layered to mirror ClaudeCodeOAuthManager so review heuristics carry over.
 */
export class AntigravityOAuthManager {
	private context: ExtensionContext | null = null
	private credentials: AntigravityCredentials | null = null
	private logFn: ((message: string) => void) | null = null
	private refreshPromise: Promise<AntigravityCredentials> | null = null
	private pendingAuth: PendingAuthorizationFlow | null = null

	private log(message: string): void {
		if (this.logFn) {
			this.logFn(message)
		} else {
			console.log(message)
		}
	}

	private logError(message: string, error?: unknown): void {
		const details = error instanceof Error ? error.message : error !== undefined ? String(error) : undefined
		const full = details ? `${message} ${details}` : message
		this.log(full)
		console.error(full)
	}

	/**
	 * Initialize with VS Code extension context. Optionally a logger function to route
	 * output-channel lines.
	 */
	async initialize(context: ExtensionContext, logFn?: (message: string) => void): Promise<void> {
		this.context = context
		this.logFn = logFn ?? null
	}

	/**
	 * Load credentials from SecretStorage into memory.
	 */
	async loadCredentials(): Promise<AntigravityCredentials | null> {
		if (!this.context) return null
		try {
			const credentialsJson = await this.context.secrets.get(ANTIGRAVITY_CREDENTIALS_KEY)
			if (!credentialsJson) {
				this.credentials = null
				return null
			}
			const parsed = JSON.parse(credentialsJson)
			this.credentials = antigravityCredentialsSchema.parse(parsed)
			return this.credentials
		} catch (error) {
			this.logError("[antigravity-oauth] Failed to load credentials:", error)
			return null
		}
	}

	/**
	 * Persist credentials to SecretStorage.
	 */
	async saveCredentials(credentials: AntigravityCredentials): Promise<void> {
		if (!this.context) {
			throw new Error("OAuth manager not initialized")
		}
		await this.context.secrets.store(ANTIGRAVITY_CREDENTIALS_KEY, JSON.stringify(credentials))
		this.credentials = credentials
	}

	/**
	 * Remove credentials from SecretStorage.
	 */
	async clearCredentials(): Promise<void> {
		if (!this.context) return
		await this.context.secrets.delete(ANTIGRAVITY_CREDENTIALS_KEY)
		this.credentials = null
	}

	/**
	 * Return the email associated with the stored credentials, if known.
	 */
	async getEmail(): Promise<string | null> {
		if (!this.credentials) {
			await this.loadCredentials()
		}
		return this.credentials?.email ?? null
	}

	/**
	 * Return a valid access token, refreshing if expired. Returns null when not authenticated.
	 */
	async getAccessToken(): Promise<string | null> {
		if (!this.credentials) {
			await this.loadCredentials()
		}
		if (!this.credentials) {
			return null
		}

		if (isTokenExpired(this.credentials)) {
			try {
				if (!this.refreshPromise) {
					const prev = this.credentials
					this.log(`[antigravity-oauth] Access token expired (expires=${prev.expires}). Refreshing...`)
					this.refreshPromise = refreshAccessToken(prev).then((newCreds) => {
						const rotated = newCreds.refresh_token !== prev.refresh_token
						this.log(
							`[antigravity-oauth] Refresh response received (expires_in≈${Math.round(
								(newCreds.expires - Date.now()) / 1000,
							)}s, refresh_token_rotated=${rotated})`,
						)
						return newCreds
					})
				}
				const refreshed = await this.refreshPromise
				this.refreshPromise = null
				await this.saveCredentials(refreshed)
				this.log(`[antigravity-oauth] Token persisted (expires=${refreshed.expires})`)
			} catch (error) {
				this.refreshPromise = null
				this.logError("[antigravity-oauth] Failed to refresh token:", error)
				if (error instanceof AntigravityOAuthTokenError && error.isLikelyInvalidGrant()) {
					this.log("[antigravity-oauth] Refresh token appears invalid; clearing stored credentials")
					await this.clearCredentials()
				}
				return null
			}
		}

		return this.credentials.access_token
	}

	/**
	 * Force a refresh even when the local expiry has not been reached (recovers from server-side
	 * revocation that yields a 401 on the API call). Returns the new access token, or null on failure.
	 */
	async forceRefreshAccessToken(): Promise<string | null> {
		if (!this.credentials) {
			await this.loadCredentials()
		}
		if (!this.credentials) {
			return null
		}
		try {
			if (!this.refreshPromise) {
				const prev = this.credentials
				this.log(`[antigravity-oauth] Forcing token refresh (expires=${prev.expires})...`)
				this.refreshPromise = refreshAccessToken(prev).then((newCreds) => {
					const rotated = newCreds.refresh_token !== prev.refresh_token
					this.log(
						`[antigravity-oauth] Forced refresh response received (expires_in≈${Math.round(
							(newCreds.expires - Date.now()) / 1000,
						)}s, refresh_token_rotated=${rotated})`,
					)
					return newCreds
				})
			}
			const refreshed = await this.refreshPromise
			this.refreshPromise = null
			await this.saveCredentials(refreshed)
			this.log(`[antigravity-oauth] Forced token persisted (expires=${refreshed.expires})`)
			return refreshed.access_token
		} catch (error) {
			this.refreshPromise = null
			this.logError("[antigravity-oauth] Failed to force refresh token:", error)
			if (error instanceof AntigravityOAuthTokenError && error.isLikelyInvalidGrant()) {
				this.log("[antigravity-oauth] Refresh token appears invalid; clearing stored credentials")
				await this.clearCredentials()
			}
			return null
		}
	}

	/**
	 * Returns true if a usable token is available (loads from SecretStorage if necessary).
	 */
	async isAuthenticated(): Promise<boolean> {
		const token = await this.getAccessToken()
		return token !== null
	}

	/**
	 * Shim returning a credential object so the provider handler keeps a single property accessor.
	 * Throws when not authenticated so the provider surface remains throw-on-missing-token.
	 */
	async ensureAuthenticated(): Promise<{ access_token: string }> {
		const token = await this.getAccessToken()
		if (!token) {
			throw new Error(
				t("common:errors.antigravity.oauthLoadFailed", {
					error: "not signed in",
				}),
			)
		}
		return { access_token: token }
	}

	/**
	 * Shim returning a credential object after a forced refresh; mirrors ensureAuthenticated()'s shape.
	 */
	async forceRefresh(): Promise<{ access_token: string }> {
		const token = await this.forceRefreshAccessToken()
		if (!token) {
			throw new Error(
				t("common:errors.antigravity.tokenRefreshFailed", {
					error: "refresh failed",
				}),
			)
		}
		return { access_token: token }
	}

	/**
	 * Return the current in-memory credentials (does not load from SecretStorage).
	 */
	getCredentials(): AntigravityCredentials | null {
		return this.credentials
	}

	/**
	 * Start the authorization flow.
	 *
	 * - Picks an ephemeral loopback port (tries up to maxPortBindRetries).
	 * - Cancels any previously pending flow.
	 * - Returns the authorization URL the caller must open in the browser.
	 * - Throws if no port could be bound.
	 *
	 * The caller is expected to subsequently `await waitForCallback()` to receive the code.
	 */
	async startAuthorizationFlow(): Promise<string> {
		this.cancelAuthorizationFlow()

		const codeVerifier = generateCodeVerifier()
		const codeChallenge = generateCodeChallenge(codeVerifier)
		const state = generateState()
		const { server, port } = await this.bindLoopbackServer()
		const redirectUri = `http://${ANTIGRAVITY_OAUTH_CONFIG.callbackHost}:${port}${ANTIGRAVITY_OAUTH_CONFIG.callbackPath}`

		this.pendingAuth = { codeVerifier, state, redirectUri, port, server }

		this.log(`[antigravity-oauth] Starting flow on ${redirectUri}`)
		return buildAuthorizationUrl(codeChallenge, state, redirectUri)
	}

	/**
	 * Try to bind a loopback HTTP server on an ephemeral port. Uses port 0 to let the OS pick a
	 * free port; retries up to maxPortBindRetries times if listen rejects (e.g., EADDRINUSE).
	 *
	 * We bind explicitly to 127.0.0.1 (never 0.0.0.0 / ::) per RFC 8252 §7.3.
	 */
	private async bindLoopbackServer(): Promise<{ server: http.Server; port: number }> {
		let lastError: unknown
		for (let attempt = 0; attempt < ANTIGRAVITY_OAUTH_CONFIG.maxPortBindRetries; attempt++) {
			try {
				const server = http.createServer()
				const port = await new Promise<number>((resolve, reject) => {
					const onError = (err: NodeJS.ErrnoException) => {
						server.removeListener("listening", onListening)
						reject(err)
					}
					const onListening = () => {
						server.removeListener("error", onError)
						const address = server.address()
						if (address && typeof address === "object") {
							resolve(address.port)
						} else {
							reject(new Error("Loopback server did not return a port address"))
						}
					}
					server.once("error", onError)
					server.once("listening", onListening)
					// Bind explicitly to 127.0.0.1 (RFC 8252 §7.3).
					server.listen(0, ANTIGRAVITY_OAUTH_CONFIG.callbackHost)
				})
				return { server, port }
			} catch (error) {
				lastError = error
			}
		}
		throw new Error(
			`Could not bind a loopback port for Antigravity sign-in after ${ANTIGRAVITY_OAUTH_CONFIG.maxPortBindRetries} attempts: ${
				lastError instanceof Error ? lastError.message : String(lastError)
			}`,
		)
	}

	/**
	 * Wait for the OAuth callback. Resolves with credentials (and possibly an email) on success.
	 *
	 * - Validates state (constant-time compare).
	 * - Closes the server on success, error, timeout, and cancellation.
	 * - Never logs the auth code, tokens, or the raw callback URL with its code/state params.
	 */
	async waitForCallback(): Promise<AntigravityCredentials> {
		if (!this.pendingAuth) {
			throw new Error("No pending authorization flow")
		}
		const flow = this.pendingAuth
		const server = flow.server
		if (!server) {
			throw new Error("Authorization flow has no bound server")
		}

		return new Promise<AntigravityCredentials>((resolve, reject) => {
			let settled = false
			const closeServer = () => {
				try {
					server.close()
				} catch {
					// ignore
				}
			}

			const safeResolve = (creds: AntigravityCredentials) => {
				if (settled) return
				settled = true
				clearTimeout(timeout)
				if (this.pendingAuth === flow) {
					this.pendingAuth = null
				}
				closeServer()
				resolve(creds)
			}
			const safeReject = (error: unknown) => {
				if (settled) return
				settled = true
				clearTimeout(timeout)
				if (this.pendingAuth === flow) {
					this.pendingAuth = null
				}
				closeServer()
				reject(error instanceof Error ? error : new Error(String(error)))
			}

			server.removeAllListeners("request")
			server.on("request", async (req, res) => {
				try {
					// Do NOT log req.url verbatim: it contains the authorization code and state.
					const url = new URL(req.url || "", `http://${ANTIGRAVITY_OAUTH_CONFIG.callbackHost}:${flow.port}`)
					if (url.pathname !== ANTIGRAVITY_OAUTH_CONFIG.callbackPath) {
						res.writeHead(404)
						res.end("Not Found")
						return
					}

					const code = url.searchParams.get("code")
					const state = url.searchParams.get("state")
					const errParam = url.searchParams.get("error")

					if (errParam) {
						res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
						res.end(`Authentication failed: ${errParam}`)
						safeReject(new Error(`OAuth error: ${errParam}`))
						return
					}

					if (!code || !state) {
						res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
						res.end("Missing code or state parameter")
						safeReject(new Error("Missing code or state parameter"))
						return
					}

					// Constant-time state comparison.
					const expectedState = Buffer.from(flow.state, "utf-8")
					const receivedState = Buffer.from(state, "utf-8")
					const stateMatches =
						expectedState.length === receivedState.length &&
						crypto.timingSafeEqual(expectedState, receivedState)
					if (!stateMatches) {
						res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
						res.end("State mismatch - possible CSRF attack")
						safeReject(new Error("State mismatch"))
						return
					}

					try {
						const credentials = await exchangeCodeForTokens(code, flow.codeVerifier, flow.redirectUri)
						// Best-effort email lookup; never fatal.
						const email = await fetchUserEmail(credentials.access_token)
						const credsWithEmail: AntigravityCredentials = email ? { ...credentials, email } : credentials
						await this.saveCredentials(credsWithEmail)

						res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
						res.end(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Antigravity Authentication Successful</title>
</head>
<body style="font-family: system-ui; text-align: center; padding: 50px;">
<h1>&#10003; Authentication Successful</h1>
<p>You can close this window and return to VS Code.</p>
<script>window.close();</script>
</body>
</html>`)
						this.log(`[antigravity-oauth] Token persisted (expires=${credsWithEmail.expires})`)
						safeResolve(credsWithEmail)
					} catch (exchangeError) {
						res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" })
						res.end("Token exchange failed")
						safeReject(exchangeError)
					}
				} catch (err) {
					try {
						res.writeHead(500)
						res.end("Internal server error")
					} catch {
						// ignore
					}
					safeReject(err)
				}
			})

			server.on("error", (err: NodeJS.ErrnoException) => {
				safeReject(err)
			})

			const timeout = setTimeout(() => {
				safeReject(new Error("Authentication timed out"))
			}, AUTHORIZATION_FLOW_TIMEOUT_MS)

			server.on("close", () => {
				clearTimeout(timeout)
			})
		})
	}

	/**
	 * Cancel any pending flow and close its loopback server.
	 */
	cancelAuthorizationFlow(): void {
		if (this.pendingAuth?.server) {
			try {
				this.pendingAuth.server.close()
			} catch {
				// ignore
			}
		}
		this.pendingAuth = null
	}
}

// Singleton instance used by the extension host and provider handler.
export const antigravityOAuthManager = new AntigravityOAuthManager()
