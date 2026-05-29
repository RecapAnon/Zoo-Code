import type { ModelInfo } from "../model.js"

export const antigravityModels = {
	"claude-opus-4-6-thinking": {
		maxTokens: 64_000,
		contextWindow: 200_000,
		supportsPromptCache: false,
		supportsReasoningBudget: true,
		maxThinkingTokens: 64_000,
		description: "Claude Opus 4.6 (Thinking)",
	},
	"claude-sonnet-4-6": {
		maxTokens: 64_000,
		contextWindow: 200_000,
		supportsPromptCache: false,
		supportsReasoningBudget: true,
		maxThinkingTokens: 64_000,
		description: "Claude Sonnet 4.6 (Thinking)",
	},
	"gemini-3-flash": {
		maxTokens: 65_536,
		contextWindow: 1_048_576,
		supportsPromptCache: false,
		supportsReasoningEffort: ["minimal", "low", "medium", "high"],
		maxThinkingTokens: 32_768,
		description: "Gemini 3 Flash",
	},
	"gemini-3-flash-agent": {
		maxTokens: 65_536,
		contextWindow: 1_048_576,
		supportsPromptCache: false,
		supportsReasoningEffort: ["minimal", "low", "medium", "high"],
		maxThinkingTokens: 32_768,
		description: "Gemini 3.5 Flash",
	},
	"gemini-3-pro-high": {
		maxTokens: 65_535,
		contextWindow: 1_048_576,
		supportsPromptCache: false,
		supportsReasoningEffort: ["low", "high"],
		maxThinkingTokens: 32_768,
		description: "Gemini 3 Pro (High)",
	},
	"gemini-3-pro-low": {
		maxTokens: 65_535,
		contextWindow: 1_048_576,
		supportsPromptCache: false,
		supportsReasoningEffort: ["low", "high"],
		maxThinkingTokens: 32_768,
		description: "Gemini 3 Pro (Low)",
	},
	"gemini-3.1-flash-image": {
		contextWindow: 1_048_576,
		supportsPromptCache: false,
		supportsImages: true,
		supportsReasoningEffort: ["minimal", "high"],
		maxThinkingTokens: 32_768,
		description: "Gemini 3.1 Flash Image",
	},
	"gemini-pro-agent": {
		maxTokens: 65_535,
		contextWindow: 1_048_576,
		supportsPromptCache: false,
		supportsReasoningEffort: ["low", "medium", "high"],
		maxThinkingTokens: 65_535,
		description: "Gemini 3.1 Pro (High)",
	},
	"gemini-3.1-pro-low": {
		maxTokens: 65_535,
		contextWindow: 1_048_576,
		supportsPromptCache: false,
		supportsReasoningEffort: ["low", "medium", "high"],
		maxThinkingTokens: 65_535,
		description: "Gemini 3.1 Pro (Low)",
	},
	"gpt-oss-120b-medium": {
		maxTokens: 32_768,
		contextWindow: 114_000,
		supportsPromptCache: false,
		description: "GPT-OSS 120B (Medium)",
	},
	"gemini-3.1-flash-lite": {
		maxTokens: 65_535,
		contextWindow: 1_048_576,
		supportsPromptCache: false,
		supportsReasoningEffort: ["minimal", "low", "medium", "high"],
		maxThinkingTokens: 65_535,
		description: "Gemini 3.1 Flash Lite",
	},
	"gemini-3.5-flash-low": {
		maxTokens: 65_535,
		contextWindow: 1_048_576,
		supportsPromptCache: false,
		supportsReasoningEffort: ["low", "medium", "high"],
		maxThinkingTokens: 65_535,
		description: "Gemini 3.5 Flash (Low)",
	},
} as const satisfies Record<string, ModelInfo>

export type AntigravityModelId = keyof typeof antigravityModels

export const antigravityDefaultModelId: AntigravityModelId = "gemini-3-pro-high"
