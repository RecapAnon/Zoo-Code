import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { safeWriteJson } from "../../utils/safeWriteJson"

const ROO_DIR = ".roo"
const GEMINI_OAUTH_CREDENTIAL_FILENAME = "gemini-oauth.json"
const OAUTH_TOKEN_BUFFER_MS = 30_000

const GEMINI_OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
const GEMINI_OAUTH_SCOPES = "https://www.googleapis.com/auth/cloud-platform"

export interface GeminiOAuthTokenPayload {
	access_token: string
	client_id?: string
	client_secret?: string
	refresh_token?: string
	expiry_date?: number
	last_refresh?: string
}

export interface GeminiOAuthCredentials {
	token: GeminiOAuthTokenPayload
	client_id?: string
	client_secret?: string
	project_id?: string
	email?: string
	auto?: boolean
	checked?: boolean
	type?: string
}

type CredentialsPathOptions = {
	path?: string
}

function getGeminiCachedCredentialPath(customPath?: string): string {
	if (customPath) {
		if (customPath.startsWith("~/")) {
			return path.join(os.homedir(), customPath.slice(2))
		}
		return path.resolve(customPath)
	}
	return path.join(os.homedir(), ROO_DIR, GEMINI_OAUTH_CREDENTIAL_FILENAME)
}

function parseExpiry(expiryDate?: number): number | null {
	if (typeof expiryDate === "number") {
		return expiryDate
	}
	return null
}

function isTokenValid(token?: GeminiOAuthTokenPayload): boolean {
	if (!token) return false
	const expiry = parseExpiry(token.expiry_date)
	if (!expiry) return false
	return Date.now() < expiry - OAUTH_TOKEN_BUFFER_MS
}

function getClientCredentials(credentials: GeminiOAuthCredentials): { clientId: string; clientSecret: string } | null {
	const clientId = credentials.token.client_id ?? credentials.client_id
	const clientSecret = credentials.token.client_secret ?? credentials.client_secret
	if (!clientId || !clientSecret) {
		return null
	}
	return { clientId, clientSecret }
}

function parseOAuthErrorDetails(errorText: string): { errorCode?: string; errorMessage?: string } {
	try {
		const json: unknown = JSON.parse(errorText)
		if (!json || typeof json !== "object") {
			return {}
		}

		const obj = json as Record<string, unknown>
		const errorField = obj.error

		const errorCode: string | undefined =
			typeof errorField === "string"
				? errorField
				: errorField &&
					  typeof errorField === "object" &&
					  typeof (errorField as Record<string, unknown>).type === "string"
					? ((errorField as Record<string, unknown>).type as string)
					: undefined

		const errorDescription = obj.error_description
		const errorMessageFromError =
			errorField && typeof errorField === "object" ? (errorField as Record<string, unknown>).message : undefined

		const errorMessage: string | undefined =
			typeof errorDescription === "string"
				? errorDescription
				: typeof errorMessageFromError === "string"
					? errorMessageFromError
					: typeof obj.message === "string"
						? obj.message
						: undefined

		return { errorCode, errorMessage }
	} catch {
		return {}
	}
}

class GeminiOAuthTokenError extends Error {
	public readonly status?: number
	public readonly errorCode?: string

	constructor(message: string, opts?: { status?: number; errorCode?: string }) {
		super(message)
		this.name = "GeminiOAuthTokenError"
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

export class GeminiOAuthManager {
	private credentials: GeminiOAuthCredentials | null = null
	private credentialsPath: string | null = null
	private refreshPromise: Promise<GeminiOAuthCredentials> | null = null

	private resolvePath(options?: CredentialsPathOptions): string {
		return getGeminiCachedCredentialPath(options?.path)
	}

	private async loadCredentials(pathOverride?: string): Promise<GeminiOAuthCredentials> {
		const filePath = getGeminiCachedCredentialPath(pathOverride)
		if (this.credentials && this.credentialsPath === filePath) {
			return this.credentials
		}

		const credsStr = await fs.readFile(filePath, "utf-8")
		const parsed = JSON.parse(credsStr) as GeminiOAuthCredentials

		if (!parsed?.token?.access_token) {
			throw new Error("Gemini OAuth credentials missing access_token.")
		}

		this.credentials = parsed
		this.credentialsPath = filePath
		return parsed
	}

	private async persistCredentials(pathOverride: string, credentials: GeminiOAuthCredentials): Promise<void> {
		try {
			await safeWriteJson(getGeminiCachedCredentialPath(pathOverride), credentials)
		} catch (error) {
			console.error("Failed to save refreshed Gemini OAuth credentials:", error)
		}
	}

	private async doRefreshAccessToken(
		credentials: GeminiOAuthCredentials,
		pathOverride: string,
	): Promise<GeminiOAuthCredentials> {
		if (!credentials.token.refresh_token) {
			throw new GeminiOAuthTokenError("No refresh token available in credentials.")
		}
		const clientCreds = getClientCredentials(credentials)
		if (!clientCreds) {
			throw new GeminiOAuthTokenError("No client credentials available.")
		}

		const body = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: credentials.token.refresh_token,
			client_id: clientCreds.clientId,
			client_secret: clientCreds.clientSecret,
			scope: GEMINI_OAUTH_SCOPES,
		})

		const response = await fetch(GEMINI_OAUTH_TOKEN_ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: body.toString(),
			signal: AbortSignal.timeout(30_000),
		})

		if (!response.ok) {
			const errorText = await response.text()
			const { errorCode, errorMessage } = parseOAuthErrorDetails(errorText)
			const details = errorMessage ? errorMessage : errorText
			throw new GeminiOAuthTokenError(
				`Token refresh failed: ${response.status} ${response.statusText}${details ? ` - ${details}` : ""}`,
				{ status: response.status, errorCode },
			)
		}

		const tokenData = await response.json()

		if (tokenData.error) {
			throw new GeminiOAuthTokenError(`Token refresh failed: ${tokenData.error} - ${tokenData.error_description}`)
		}

		const updated: GeminiOAuthCredentials = {
			...credentials,
			token: {
				...credentials.token,
				access_token: tokenData.access_token,
				refresh_token: tokenData.refresh_token || credentials.token.refresh_token,
				expiry_date: Date.now() + tokenData.expires_in * 1000,
				last_refresh: new Date().toISOString(),
			},
		}

		this.credentials = updated
		this.credentialsPath = getGeminiCachedCredentialPath(pathOverride)
		await this.persistCredentials(pathOverride, updated)
		return updated
	}

	private async refreshAccessToken(
		credentials: GeminiOAuthCredentials,
		pathOverride: string,
	): Promise<GeminiOAuthCredentials> {
		if (this.refreshPromise) {
			return this.refreshPromise
		}

		this.refreshPromise = this.doRefreshAccessToken(credentials, pathOverride)

		try {
			return await this.refreshPromise
		} finally {
			this.refreshPromise = null
		}
	}

	async getCredentials(options?: CredentialsPathOptions): Promise<GeminiOAuthCredentials | null> {
		try {
			return await this.loadCredentials(options?.path)
		} catch (error) {
			console.error("Failed to load Gemini OAuth credentials:", error)
			return null
		}
	}

	async getAccessToken(options?: CredentialsPathOptions): Promise<string | null> {
		const pathOverride = this.resolvePath(options)
		let credentials = await this.getCredentials(options)
		if (!credentials) {
			return null
		}

		if (!isTokenValid(credentials.token)) {
			try {
				credentials = await this.refreshAccessToken(credentials, pathOverride)
			} catch (error) {
				console.error("Failed to refresh Gemini OAuth token:", error)
				if (error instanceof GeminiOAuthTokenError && error.isLikelyInvalidGrant()) {
					console.error("Gemini OAuth refresh token appears invalid; re-authentication required.")
				}
				return null
			}
		}

		return credentials.token.access_token
	}

	async forceRefreshAccessToken(options?: CredentialsPathOptions): Promise<string | null> {
		const pathOverride = this.resolvePath(options)
		const credentials = await this.getCredentials(options)
		if (!credentials) {
			return null
		}

		try {
			const refreshed = await this.refreshAccessToken(credentials, pathOverride)
			return refreshed.token.access_token
		} catch (error) {
			console.error("Failed to force refresh Gemini OAuth token:", error)
			if (error instanceof GeminiOAuthTokenError && error.isLikelyInvalidGrant()) {
				console.error("Gemini OAuth refresh token appears invalid; re-authentication required.")
			}
			return null
		}
	}

	async getProjectId(options?: CredentialsPathOptions & { projectIdOverride?: string }): Promise<string | null> {
		const credentials = await this.getCredentials({ path: options?.path })
		return options?.projectIdOverride ?? credentials?.project_id ?? null
	}
}

export const geminiOAuthManager = new GeminiOAuthManager()
