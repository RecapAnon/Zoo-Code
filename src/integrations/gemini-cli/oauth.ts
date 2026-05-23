import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { OAuth2Client } from "google-auth-library"
import { t } from "i18next"

import { safeWriteJson } from "../../utils/safeWriteJson"

const GEMINI_DIR = ".gemini"
const GEMINI_OAUTH_CREDENTIAL_FILENAME = "oauth_creds.json"

export const GEMINI_OAUTH_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"
export const GEMINI_OAUTH_CLIENT_SECRET = "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"

const GEMINI_OAUTH_API_CLIENT = "google-api-nodejs-client/9.15.1"
const GEMINI_OAUTH_API_CLIENT_PLATFORM = "gl-node/22.17.0"
const GEMINI_OAUTH_CLIENT_METADATA = "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI"

export interface GeminiOAuthCredentials {
	access_token: string
	refresh_token?: string
	token_type?: string
	expiry_date?: number
	scope?: string
	id_token?: string
}

type CredentialsPathOptions = {
	path?: string
}

function resolveGeminiCredentialPath(customPath?: string): string {
	if (customPath) {
		if (customPath.startsWith("~/")) {
			return path.join(os.homedir(), customPath.slice(2))
		}
		return path.resolve(customPath)
	}
	return path.join(os.homedir(), GEMINI_DIR, GEMINI_OAUTH_CREDENTIAL_FILENAME)
}

function isTokenExpired(expiryDate?: number): boolean {
	return typeof expiryDate === "number" && expiryDate < Date.now()
}

export class GeminiOAuthManager {
	private credentials: GeminiOAuthCredentials | null = null
	private credentialsPath: string | null = null
	private refreshPromise: Promise<GeminiOAuthCredentials> | null = null
	private authClient: OAuth2Client

	constructor() {
		this.authClient = new OAuth2Client({
			clientId: GEMINI_OAUTH_CLIENT_ID,
			clientSecret: GEMINI_OAUTH_CLIENT_SECRET,
		})
		const transporter = this.authClient.transporter as { defaults?: { headers?: Record<string, string> } }
		const currentHeaders = transporter.defaults?.headers ?? {}
		transporter.defaults = {
			...transporter.defaults,
			headers: {
				...currentHeaders,
				"User-Agent": GEMINI_OAUTH_API_CLIENT,
				"X-Goog-Api-Client": GEMINI_OAUTH_API_CLIENT_PLATFORM,
				"Client-Metadata": GEMINI_OAUTH_CLIENT_METADATA,
			},
		}
	}

	private resolvePath(options?: CredentialsPathOptions): string {
		return resolveGeminiCredentialPath(options?.path)
	}

	private setAuthClientCredentials(credentials: GeminiOAuthCredentials): void {
		this.authClient.setCredentials({
			access_token: credentials.access_token,
			refresh_token: credentials.refresh_token,
			expiry_date: credentials.expiry_date,
			token_type: credentials.token_type,
		})
	}

	private async loadOAuthCredentials(filePath: string): Promise<GeminiOAuthCredentials> {
		if (this.credentials && this.credentialsPath === filePath) {
			return this.credentials
		}

		try {
			const credData = await fs.readFile(filePath, "utf-8")
			const parsed = JSON.parse(credData) as GeminiOAuthCredentials

			if (!parsed?.access_token) {
				throw new Error("Gemini OAuth credentials missing access_token.")
			}

			this.credentials = parsed
			this.credentialsPath = filePath
			this.setAuthClientCredentials(parsed)
			return parsed
		} catch (error) {
			throw new Error(t("common:errors.geminiCli.notAuthenticated"))
		}
	}

	private async persistCredentials(filePath: string, credentials: GeminiOAuthCredentials): Promise<void> {
		try {
			await safeWriteJson(filePath, credentials)
		} catch (error) {
			console.error("Failed to save refreshed Gemini OAuth credentials:", error)
		}
	}

	private async doRefreshAccessToken(
		credentials: GeminiOAuthCredentials,
		filePath: string,
	): Promise<GeminiOAuthCredentials> {
		const { credentials: refreshed } = await this.authClient.refreshAccessToken()

		if (!refreshed.access_token) {
			throw new Error("Gemini OAuth refresh did not return an access token.")
		}

		const updated: GeminiOAuthCredentials = {
			...credentials,
			access_token: refreshed.access_token,
			refresh_token: refreshed.refresh_token ?? credentials.refresh_token,
			token_type: refreshed.token_type ?? credentials.token_type ?? "Bearer",
			expiry_date: refreshed.expiry_date ?? Date.now() + 3600 * 1000,
			scope: typeof refreshed.scope === "string" ? refreshed.scope : credentials.scope,
			id_token: typeof refreshed.id_token === "string" ? refreshed.id_token : credentials.id_token,
		}

		this.credentials = updated
		this.credentialsPath = filePath
		this.setAuthClientCredentials(updated)
		await this.persistCredentials(filePath, updated)
		return updated
	}

	private async refreshAccessToken(
		credentials: GeminiOAuthCredentials,
		filePath: string,
	): Promise<GeminiOAuthCredentials> {
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

	async ensureAuthenticated(options?: CredentialsPathOptions): Promise<GeminiOAuthCredentials> {
		const filePath = this.resolvePath(options)
		let credentials = await this.loadOAuthCredentials(filePath)

		if (isTokenExpired(credentials.expiry_date)) {
			try {
				credentials = await this.refreshAccessToken(credentials, filePath)
			} catch (error) {
				throw new Error(t("common:errors.geminiCli.genericError", { error }))
			}
		}

		return credentials
	}

	async getAccessToken(options?: CredentialsPathOptions): Promise<string | null> {
		const credentials = await this.ensureAuthenticated(options)
		return credentials.access_token ?? null
	}

	getAuthClient(): OAuth2Client {
		return this.authClient
	}
}

export const geminiOAuthManager = new GeminiOAuthManager()
