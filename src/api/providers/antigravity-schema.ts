/**
 * Models that use the Antigravity schema dialect (placeholders kept, `title`
 * kept, `nullable` kept). All other Antigravity models use the stricter Gemini
 * dialect.
 *
 * Mirrors `useAntigravitySchema` in `antigravity_executor.go`:
 *   strings.Contains(modelName, "claude") ||
 *   strings.Contains(modelName, "gemini-3-pro") ||
 *   strings.Contains(modelName, "gemini-3.1-pro")
 */
export function usesAntigravitySchemaDialect(modelId: string): boolean {
	return modelId.includes("claude") || modelId.includes("gemini-3-pro") || modelId.includes("gemini-3.1-pro")
}

/**
 * Keywords whose only purpose is constraint metadata. They are stripped from
 * the schema (and, where possible, surfaced into `description` so the model
 * still sees the intent).
 */
const CONSTRAINT_KEYWORDS = [
	"minLength",
	"maxLength",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"pattern",
	"minItems",
	"maxItems",
	"uniqueItems",
	"format",
	"default",
	"examples",
] as const

/**
 * Keywords the Gemini schema dialect does not understand at all. They are
 * removed unconditionally.
 */
const UNSUPPORTED_STRUCTURAL_KEYWORDS = [
	"$schema",
	"$defs",
	"definitions",
	"const",
	"$ref",
	"$id",
	"additionalProperties",
	"propertyNames",
	"patternProperties",
] as const

/**
 * Keywords the Gemini dialect strips beyond what the Antigravity dialect
 * strips. (Antigravity keeps `nullable` and `title` so Claude's VALIDATED mode
 * can surface them; Gemini ignores both.)
 */
const GEMINI_ONLY_EXTRA_STRIPS = ["nullable", "title"] as const

type JsonObject = Record<string, unknown>

function isPlainObject(v: unknown): v is JsonObject {
	return typeof v === "object" && v !== null && !Array.isArray(v)
}

function appendDescriptionHint(node: JsonObject, hint: string): void {
	const existing = typeof node.description === "string" ? node.description : ""
	if (!existing) {
		node.description = hint
		return
	}
	if (existing.includes(hint)) return
	node.description = `${existing} (${hint})`
}

/**
 * Flatten a JSON Schema `type: ["string", "null"]` (or any other multi-type
 * array) to a single concrete type. When `null` is one of the alternatives and
 * the dialect supports it, also set `nullable: true`. Multiple non-null
 * alternatives are reduced to the first one and the rest are surfaced as a
 * description hint so the model still sees the intent.
 */
function flattenTypeArray(node: JsonObject, dialect: "antigravity" | "gemini"): void {
	if (!Array.isArray(node.type)) return
	const types = (node.type as unknown[]).map((t) => String(t))
	const hasNull = types.includes("null")
	const nonNull = types.filter((t) => t !== "null" && t !== "")
	const primary = nonNull.length > 0 ? nonNull[0] : "string"
	node.type = primary
	if (nonNull.length > 1) {
		appendDescriptionHint(node, `Accepts: ${nonNull.join(" | ")}`)
	}
	if (hasNull && dialect === "antigravity") {
		// Gemini dialect drops `nullable` entirely later; only the Antigravity
		// dialect keeps it.
		node.nullable = true
	}
}

/**
 * Recursively clean a single JSON Schema node in place.
 *
 * The walk descends into:
 *   - `properties.*`
 *   - `items` (object or array)
 *   - `anyOf` / `oneOf` / `allOf` array members (we do NOT flatten them; we
 *     only sanitize their children). Today we do not emit any of these from
 *     `metadata.tools`, but cleaning defensively keeps the sanitizer robust.
 *   - `additionalProperties` when it is a schema (rare; before we strip it).
 */
function cleanSchemaNode(node: unknown, dialect: "antigravity" | "gemini"): void {
	if (!isPlainObject(node)) return

	// 1. Append description hints for constraint keywords, then delete them.
	for (const key of CONSTRAINT_KEYWORDS) {
		if (key in node) {
			const value = node[key]
			if (value !== undefined && value !== null && !isPlainObject(value) && !Array.isArray(value)) {
				appendDescriptionHint(node, `${key}: ${String(value)}`)
			}
			delete node[key]
		}
	}

	// 2. additionalProperties: false → description hint, then drop the key.
	if (node.additionalProperties === false) {
		appendDescriptionHint(node, "No extra properties allowed")
	}

	// 3. Drop structural keywords the upstream rejects.
	for (const key of UNSUPPORTED_STRUCTURAL_KEYWORDS) {
		if (key in node) delete node[key]
	}

	// 4. Gemini-only extra strips.
	if (dialect === "gemini") {
		for (const key of GEMINI_ONLY_EXTRA_STRIPS) {
			if (key in node) delete node[key]
		}
	}

	// 5. Flatten multi-type arrays.
	flattenTypeArray(node, dialect)

	// 6. Recurse into known schema-bearing children.
	if (isPlainObject(node.properties)) {
		for (const child of Object.values(node.properties as JsonObject)) {
			cleanSchemaNode(child, dialect)
		}
	}
	if (isPlainObject(node.items)) {
		cleanSchemaNode(node.items, dialect)
	} else if (Array.isArray(node.items)) {
		for (const child of node.items) cleanSchemaNode(child, dialect)
	}
	for (const composite of ["anyOf", "oneOf", "allOf"] as const) {
		const arr = node[composite]
		if (Array.isArray(arr)) {
			for (const child of arr) cleanSchemaNode(child, dialect)
		}
	}

	// 7. Required: prune entries that no longer exist in properties.
	if (Array.isArray(node.required) && isPlainObject(node.properties)) {
		const props = node.properties as JsonObject
		const filtered = (node.required as unknown[]).filter(
			(r) => typeof r === "string" && Object.prototype.hasOwnProperty.call(props, r),
		)
		if (filtered.length === 0) {
			delete node.required
		} else {
			node.required = filtered
		}
	}
}

/**
 * Deep-clone a JSON-safe value. We rely on `JSON.parse(JSON.stringify(...))`
 * because every input is, by construction, a JSON-serializable payload
 * (`metadata.tools[*].function.parameters` is plain JSON). Functions, symbols,
 * `undefined` properties, etc. are not part of the tool schema contract.
 */
function deepClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Sanitize a single tool's parameter schema and return the cleaned object.
 * Pure: callers may pass the original `metadata.tools[*].function.parameters`
 * value without worrying about mutation.
 */
export function sanitizeToolSchema(schema: unknown, modelId: string): Record<string, unknown> | undefined {
	if (schema === undefined || schema === null) return undefined
	if (!isPlainObject(schema)) return undefined
	const dialect: "antigravity" | "gemini" = usesAntigravitySchemaDialect(modelId) ? "antigravity" : "gemini"
	const cloned = deepClone(schema)
	cleanSchemaNode(cloned, dialect)
	return cloned
}

/**
 * Build the `functionDeclarations[*]` entry for a single tool, applying the
 * sanitizer and emitting the upstream-expected field name `parameters` (NOT
 * `parametersJsonSchema`).
 */
export function buildFunctionDeclaration(
	tool: {
		function: { name: string; description?: string; parameters?: unknown }
	},
	modelId: string,
): { name: string; description?: string; parameters?: Record<string, unknown> } {
	const decl: { name: string; description?: string; parameters?: Record<string, unknown> } = {
		name: tool.function.name,
	}
	if (tool.function.description !== undefined) {
		decl.description = tool.function.description
	}
	const sanitized = sanitizeToolSchema(tool.function.parameters, modelId)
	if (sanitized !== undefined) {
		decl.parameters = sanitized
	}
	return decl
}
