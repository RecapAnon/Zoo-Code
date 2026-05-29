import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { t } from "i18next"

import { safeWriteJson } from "../../utils/safeWriteJson"

const ANTIGRAVITY_DIR = ".antigravity"
const ANTIGRAVITY_OAUTH_CREDENTIAL_FILENAME = "antigravity.json"

export const ANTIGRAVITY_OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
export const ANTIGRAVITY_OAUTH_CLIENT_SECRET = "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"

const ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token"
const REFRESH_SKEW_MS = 3_000_000
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600

/**
 * Antigravity OAuth credential file schema.
 *
 * Differs from Gemini CLI's schema: Antigravity stores `timestamp + expires_in` instead of a
 * pre-computed `expiry_date`. Expiry in milliseconds is computed as
 * `timestamp + expires_in * 1000`.
 */
export interface AntigravityOAuthCredentials {
	access_token: string
	refresh_token?: string
	expires_in?: number // seconds until expiry, relative to `timestamp`
	timestamp?: number // unix milliseconds when the access_token was issued
	expired?: string // RFC3339 string, informational only
	type?: string // "antigravity"
}

type CredentialsPathOptions = {
	path?: string
}

interface TokenRefreshResponse {
	access_token?: string
	refresh_token?: string
	expires_in?: number
	token_type?: string
	scope?: string
	id_token?: string
}

function resolveAntigravityCredentialPath(customPath?: string): string {
	if (customPath) {
		if (customPath.startsWith("~/")) {
			return path.join(os.homedir(), customPath.slice(2))
		}
		return path.resolve(customPath)
	}
	return path.join(os.homedir(), ANTIGRAVITY_DIR, ANTIGRAVITY_OAUTH_CREDENTIAL_FILENAME)
}

function computeExpiryMs(credentials: AntigravityOAuthCredentials): number | undefined {
	if (typeof credentials.timestamp !== "number" || typeof credentials.expires_in !== "number") {
		return undefined
	}
	return credentials.timestamp + credentials.expires_in * 1000
}

function isTokenExpired(credentials: AntigravityOAuthCredentials): boolean {
	const expiryMs = computeExpiryMs(credentials)
	if (typeof expiryMs !== "number") {
		// No expiry information — treat as expired so we attempt refresh if a refresh token exists.
		return true
	}
	return Date.now() > expiryMs - REFRESH_SKEW_MS
}

export class AntigravityOAuthManager {
	private credentials: AntigravityOAuthCredentials | null = null
	private credentialsPath: string | null = null
	private refreshPromise: Promise<AntigravityOAuthCredentials> | null = null

	private resolvePath(options?: CredentialsPathOptions): string {
		return resolveAntigravityCredentialPath(options?.path)
	}

	private async loadOAuthCredentials(filePath: string): Promise<AntigravityOAuthCredentials> {
		if (this.credentials && this.credentialsPath === filePath) {
			return this.credentials
		}

		let raw: string
		try {
			raw = await fs.readFile(filePath, "utf-8")
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			throw new Error(t("common:errors.antigravity.oauthLoadFailed", { error: message }))
		}

		let parsed: AntigravityOAuthCredentials
		try {
			parsed = JSON.parse(raw) as AntigravityOAuthCredentials
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			throw new Error(t("common:errors.antigravity.oauthLoadFailed", { error: message }))
		}

		if (!parsed?.access_token) {
			throw new Error(
				t("common:errors.antigravity.oauthLoadFailed", {
					error: "missing access_token",
				}),
			)
		}

		this.credentials = parsed
		this.credentialsPath = filePath
		return parsed
	}

	private async persistCredentials(filePath: string, credentials: AntigravityOAuthCredentials): Promise<void> {
		try {
			await safeWriteJson(filePath, credentials)
		} catch (error) {
			// Persisting refreshed credentials is best-effort: an in-memory copy still works for the
			// current process. Log without leaking the token contents.
			console.error("Failed to save refreshed Antigravity OAuth credentials:", error)
		}
	}

	private async doRefreshAccessToken(
		credentials: AntigravityOAuthCredentials,
		filePath: string,
	): Promise<AntigravityOAuthCredentials> {
		if (!credentials.refresh_token) {
			throw new Error(
				t("common:errors.antigravity.tokenRefreshFailed", {
					error: "missing refresh_token",
				}),
			)
		}

		const body = new URLSearchParams({
			client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
			client_secret: ANTIGRAVITY_OAUTH_CLIENT_SECRET,
			grant_type: "refresh_token",
			refresh_token: credentials.refresh_token,
		})

		let response: Response
		try {
			response = await fetch(ANTIGRAVITY_TOKEN_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json",
				},
				body: body.toString(),
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			throw new Error(t("common:errors.antigravity.tokenRefreshFailed", { error: message }))
		}

		if (!response.ok) {
			// Read body for diagnostics but do not include any access_token that might appear in the
			// error JSON envelope (Google's error responses don't include tokens, but be defensive).
			let detail = `HTTP ${response.status}`
			try {
				const text = await response.text()
				if (text) {
					detail = `${detail}: ${text}`
				}
			} catch {
				// ignore body read failures
			}
			throw new Error(t("common:errors.antigravity.tokenRefreshFailed", { error: detail }))
		}

		let payload: TokenRefreshResponse
		try {
			payload = (await response.json()) as TokenRefreshResponse
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			throw new Error(t("common:errors.antigravity.tokenRefreshFailed", { error: message }))
		}

		if (!payload.access_token) {
			throw new Error(
				t("common:errors.antigravity.tokenRefreshFailed", {
					error: "response missing access_token",
				}),
			)
		}

		const now = Date.now()
		const expiresIn =
			typeof payload.expires_in === "number" && payload.expires_in > 0
				? payload.expires_in
				: DEFAULT_TOKEN_LIFETIME_SECONDS

		const updated: AntigravityOAuthCredentials = {
			...credentials,
			access_token: payload.access_token,
			refresh_token: payload.refresh_token ?? credentials.refresh_token,
			expires_in: expiresIn,
			timestamp: now,
			expired: new Date(now + expiresIn * 1000).toISOString(),
			type: credentials.type ?? "antigravity",
		}

		this.credentials = updated
		this.credentialsPath = filePath
		await this.persistCredentials(filePath, updated)
		return updated
	}

	private async refreshAccessToken(
		credentials: AntigravityOAuthCredentials,
		filePath: string,
	): Promise<AntigravityOAuthCredentials> {
		// Single-flight: dedupe concurrent refresh attempts so we issue one HTTP call no matter
		// how many callers race into ensureAuthenticated().
		if (this.refreshPromise) {
			return this.refreshPromise
		}

		this.refreshPromise = this.doRefreshAccessToken(credentials, filePath)

		try {
			return await this.refreshPromise
		} finally {
			this.refreshPromise = null
		}
	}

	async ensureAuthenticated(options?: CredentialsPathOptions): Promise<AntigravityOAuthCredentials> {
		const filePath = this.resolvePath(options)
		let credentials = await this.loadOAuthCredentials(filePath)

		if (isTokenExpired(credentials)) {
			credentials = await this.refreshAccessToken(credentials, filePath)
		}

		return credentials
	}

	async getAccessToken(options?: CredentialsPathOptions): Promise<string | null> {
		const credentials = await this.ensureAuthenticated(options)
		return credentials.access_token ?? null
	}

	/**
	 * Force a refresh of the in-memory + on-disk credentials using the current refresh token.
	 * Used by the handler's single 401 retry path to recover from a server-side token revocation
	 * (token still appears unexpired locally but the API rejects it).
	 */
	async forceRefresh(options?: CredentialsPathOptions): Promise<AntigravityOAuthCredentials> {
		const filePath = this.resolvePath(options)
		const credentials = await this.loadOAuthCredentials(filePath)
		return this.refreshAccessToken(credentials, filePath)
	}
}

export const antigravityOAuthManager = new AntigravityOAuthManager()
