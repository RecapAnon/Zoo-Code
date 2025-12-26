import type { ModelInfo } from "../model.js"

import { geminiModels } from "./gemini.js"

export type GeminiOAuthModelId = keyof typeof geminiModels

export const geminiOauthDefaultModelId: GeminiOAuthModelId = "gemini-3-pro-preview"

export const geminiOauthModels = geminiModels as Record<GeminiOAuthModelId, ModelInfo>
