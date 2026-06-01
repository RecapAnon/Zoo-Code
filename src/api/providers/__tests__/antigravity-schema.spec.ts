import { buildFunctionDeclaration, sanitizeToolSchema, usesAntigravitySchemaDialect } from "../antigravity-schema"

describe("usesAntigravitySchemaDialect", () => {
	it.each([
		["claude-sonnet-4-6", true],
		["claude-haiku-4-5", true],
		["gemini-3-pro-high", true],
		["gemini-3-pro-low", true],
		["gemini-3.1-pro-high", true],
		["gemini-3.5-flash-low", false],
		["gemini-3.5-flash-medium", false],
		["gemini-2.5-flash", false],
		["gpt-oss-120b-medium", false],
		["", false],
	])("returns the right dialect for %s", (modelId, expected) => {
		expect(usesAntigravitySchemaDialect(modelId)).toBe(expected)
	})
})

describe("sanitizeToolSchema (Gemini dialect — gemini-3.5-flash-low)", () => {
	const model = "gemini-3.5-flash-low"

	it("removes $schema, title, additionalProperties, and other structural keywords at every level", () => {
		const out = sanitizeToolSchema(
			{
				$schema: "http://json-schema.org/draft-07/schema#",
				title: "Outer",
				type: "object",
				additionalProperties: false,
				properties: {
					nested: {
						type: "object",
						title: "Nested",
						additionalProperties: false,
						properties: { x: { type: "string" } },
					},
				},
			},
			model,
		)!
		expect(out.$schema).toBeUndefined()
		expect(out.title).toBeUndefined()
		expect(out.additionalProperties).toBeUndefined()
		const nested = (out.properties as any).nested
		expect(nested.title).toBeUndefined()
		expect(nested.additionalProperties).toBeUndefined()
	})

	it('flattens type: ["string", "null"] to a single type and drops nullable for the Gemini dialect', () => {
		const out = sanitizeToolSchema(
			{
				type: "object",
				properties: { x: { type: ["string", "null"], description: "x field" } },
			},
			model,
		)!
		const x = (out.properties as any).x
		expect(x.type).toBe("string")
		expect(x.nullable).toBeUndefined()
	})

	it("flattens to first non-null type and appends a description hint when there are multiple non-null alternatives", () => {
		const out = sanitizeToolSchema(
			{
				type: "object",
				properties: { x: { type: ["number", "string", "null"] } },
			},
			model,
		)!
		const x = (out.properties as any).x
		expect(x.type).toBe("number")
		expect(typeof x.description).toBe("string")
		expect(x.description).toContain("Accepts: number | string")
	})

	it("moves constraint keywords (minLength, minItems, maxItems, pattern, format) into description and removes the keys", () => {
		const out = sanitizeToolSchema(
			{
				type: "object",
				properties: {
					q: { type: "string", minLength: 1, pattern: "^.+$", description: "Question" },
					a: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } },
				},
			},
			model,
		)!
		const q = (out.properties as any).q
		const a = (out.properties as any).a
		expect(q.minLength).toBeUndefined()
		expect(q.pattern).toBeUndefined()
		expect(q.description).toContain("minLength: 1")
		expect(q.description).toContain("pattern: ^.+$")
		expect(a.minItems).toBeUndefined()
		expect(a.maxItems).toBeUndefined()
		expect(a.description).toContain("minItems: 1")
		expect(a.description).toContain("maxItems: 4")
	})

	it("preserves required entries that match remaining properties and prunes orphaned ones", () => {
		const out = sanitizeToolSchema(
			{
				type: "object",
				properties: {
					a: { type: "string" },
					b: { type: "string" },
				},
				required: ["a", "b", "ghost"],
			},
			model,
		)!
		expect(out.required).toEqual(["a", "b"])
	})

	it("strips required entirely when all entries are orphaned after sanitization", () => {
		const out = sanitizeToolSchema(
			{
				type: "object",
				properties: {},
				required: ["ghost"],
			},
			model,
		)!
		expect(out.required).toBeUndefined()
	})

	it("does not mutate the input schema", () => {
		const input = {
			type: "object",
			additionalProperties: false,
			properties: { x: { type: ["string", "null"], minLength: 1 } },
		}
		const snapshot = JSON.parse(JSON.stringify(input))
		sanitizeToolSchema(input, model)
		expect(input).toEqual(snapshot)
	})

	it("returns undefined when schema is null/undefined/non-object", () => {
		expect(sanitizeToolSchema(undefined, model)).toBeUndefined()
		expect(sanitizeToolSchema(null, model)).toBeUndefined()
		expect(sanitizeToolSchema("not a schema", model)).toBeUndefined()
		expect(sanitizeToolSchema(42, model)).toBeUndefined()
	})
})

describe("sanitizeToolSchema (Antigravity dialect — gemini-3-pro-high / claude)", () => {
	it("keeps nullable when flattening type arrays for the Antigravity dialect", () => {
		const out = sanitizeToolSchema(
			{ type: "object", properties: { x: { type: ["string", "null"] } } },
			"gemini-3-pro-high",
		)!
		const x = (out.properties as any).x
		expect(x.type).toBe("string")
		expect(x.nullable).toBe(true)
	})

	it("keeps nullable when flattening type arrays for claude models too", () => {
		const out = sanitizeToolSchema(
			{ type: "object", properties: { x: { type: ["string", "null"] } } },
			"claude-sonnet-4-6",
		)!
		const x = (out.properties as any).x
		expect(x.nullable).toBe(true)
	})

	it("still strips additionalProperties and structural keywords for the Antigravity dialect", () => {
		const out = sanitizeToolSchema(
			{ type: "object", additionalProperties: false, properties: { x: { type: "string" } } },
			"gemini-3-pro-high",
		)!
		expect(out.additionalProperties).toBeUndefined()
	})
})

describe("buildFunctionDeclaration", () => {
	it("emits `parameters` (NOT `parametersJsonSchema`) for any model", () => {
		const decl = buildFunctionDeclaration(
			{
				function: {
					name: "ask_followup_question",
					description: "Ask a question.",
					parameters: { type: "object", properties: { q: { type: "string" } } },
				},
			},
			"gemini-3.5-flash-low",
		)
		expect(decl.name).toBe("ask_followup_question")
		expect(decl.description).toBe("Ask a question.")
		expect(decl.parameters).toBeDefined()
		expect((decl as any).parametersJsonSchema).toBeUndefined()
	})

	it("omits the parameters field when the tool has no parameters", () => {
		const decl = buildFunctionDeclaration(
			{ function: { name: "ping", description: "no args" } },
			"gemini-3.5-flash-low",
		)
		expect(decl.name).toBe("ping")
		expect(decl.parameters).toBeUndefined()
	})

	it("omits the description when the tool has none", () => {
		const decl = buildFunctionDeclaration(
			{ function: { name: "ping", parameters: { type: "object" } } },
			"gemini-3.5-flash-low",
		)
		expect(decl.description).toBeUndefined()
	})
})
