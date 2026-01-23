import type { ModelInfo } from "../model.js"

export type CodexOAuthModelId =
	| "gpt-5.2-codex"
	| "gpt-5.1-codex-max"
	| "gpt-5.1-codex"
	| "gpt-5.1-codex-mini"
	| "gpt-5.2"
	| "gpt-5.1"
	| "gpt-5-codex"
	| "gpt-5"
	| "gpt-5-codex-mini"
	| "codex-mini-latest"
	| "bengalfox"
	| "boomslang"

export const codexOauthDefaultModelId: CodexOAuthModelId = "gpt-5.2-codex"

export const codexOauthModels = {
	"gpt-5.2-codex": {
		maxTokens: -1,
		contextWindow: 272000,
		supportsImages: false,
		supportsPromptCache: false,
		supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
		reasoningEffort: "medium",
		includedTools: ["apply_patch"],
		description: "Codex-optimized flagship for deep and fast reasoning.",
	},
	"gpt-5.1-codex-max": {
		maxTokens: -1,
		contextWindow: 272000,
		supportsImages: false,
		supportsPromptCache: false,
		supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
		reasoningEffort: "medium",
		includedTools: ["apply_patch"],
		description: "Codex-optimized flagship for deep and fast reasoning.",
	},
	"gpt-5.1-codex": {
		maxTokens: -1,
		contextWindow: 272000,
		supportsImages: false,
		supportsPromptCache: false,
		supportsReasoningEffort: ["low", "medium", "high"],
		reasoningEffort: "medium",
		includedTools: ["apply_patch"],
		description: "Optimized for codex.",
	},
	"gpt-5.1-codex-mini": {
		maxTokens: -1,
		contextWindow: 272000,
		supportsImages: false,
		supportsPromptCache: false,
		supportsReasoningEffort: ["medium", "high"],
		reasoningEffort: "medium",
		includedTools: ["apply_patch"],
		description: "Optimized for codex. Cheaper, faster, but less capable.",
	},
	"gpt-5.2": {
		maxTokens: -1,
		contextWindow: 272000,
		supportsImages: false,
		supportsPromptCache: false,
		supportsVerbosity: true,
		supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
		reasoningEffort: "medium",
		includedTools: ["apply_patch"],
		description: "Latest frontier model with improvements across knowledge, reasoning and coding",
	},
	"gpt-5.1": {
		maxTokens: -1,
		contextWindow: 272000,
		supportsImages: false,
		supportsPromptCache: false,
		supportsVerbosity: true,
		supportsReasoningEffort: ["low", "medium", "high"],
		reasoningEffort: "medium",
		includedTools: ["apply_patch"],
		description: "Broad world knowledge with strong general reasoning.",
	},
	"gpt-5-codex": {
		maxTokens: -1,
		contextWindow: 272000,
		supportsImages: false,
		supportsPromptCache: false,
		supportsReasoningEffort: ["low", "medium", "high"],
		reasoningEffort: "medium",
		includedTools: ["apply_patch"],
		description: "Optimized for codex.",
	},
	"gpt-5": {
		maxTokens: -1,
		contextWindow: 272000,
		supportsImages: false,
		supportsPromptCache: false,
		supportsVerbosity: true,
		supportsReasoningEffort: ["minimal", "low", "medium", "high"],
		reasoningEffort: "medium",
		description: "Broad world knowledge with strong general reasoning.",
	},
	"gpt-5-codex-mini": {
		maxTokens: -1,
		contextWindow: 272000,
		supportsImages: false,
		supportsPromptCache: false,
		supportsReasoningEffort: ["medium", "high"],
		reasoningEffort: "medium",
		includedTools: ["apply_patch"],
		description: "Optimized for codex. Cheaper, faster, but less capable.",
	},
	"codex-mini-latest": {
		maxTokens: -1,
		contextWindow: 200000,
		supportsImages: false,
		supportsPromptCache: false,
		supportsReasoningEffort: ["minimal", "low", "medium"],
		reasoningEffort: "medium",
		description: "Legacy Codex mini model.",
	},
	bengalfox: {
		maxTokens: -1,
		contextWindow: 272000,
		supportsImages: false,
		supportsPromptCache: false,
		supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
		reasoningEffort: "medium",
		includedTools: ["apply_patch"],
		description: "bengalfox",
	},
	boomslang: {
		maxTokens: -1,
		contextWindow: 272000,
		supportsImages: false,
		supportsPromptCache: false,
		supportsVerbosity: true,
		supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
		reasoningEffort: "medium",
		includedTools: ["apply_patch"],
		description: "boomslang",
	},
} as const satisfies Record<CodexOAuthModelId, ModelInfo>
