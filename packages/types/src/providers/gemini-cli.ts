import type { ModelInfo } from "../model.js"

import { geminiModels } from "./gemini.js"

export type GeminiCliModelId = keyof typeof geminiModels

export const geminiCliDefaultModelId: GeminiCliModelId = "gemini-3-pro-preview"

export const geminiCliModels = geminiModels as Record<GeminiCliModelId, ModelInfo>
