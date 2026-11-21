import { describe, expect, it } from "vitest";
import { normalizeSchemaForGoogle } from "../src/schema.ts";

describe("Gemini tool schema normalization", () => {
	it("preserves properties named const while normalizing their schemas", () => {
		const schema = {
			type: "object",
			properties: {
				const: { type: "string", description: "A parameter named const" },
				nested: {
					type: "object",
					properties: { const: { const: "fixed" } },
					required: ["const"],
				},
			},
			required: ["const", "nested"],
		};
		expect(normalizeSchemaForGoogle(schema)).toMatchObject({
			type: "object",
			properties: {
				const: { type: "string", description: "A parameter named const" },
				nested: { properties: { const: { type: "string", enum: ["fixed"] } }, required: ["const"] },
			},
			required: ["const", "nested"],
		});
		expect(schema.properties.nested.properties.const).toEqual({ const: "fixed" });
	});

	it("still converts schema keyword const and accepts empty property maps", () => {
		expect(normalizeSchemaForGoogle({ const: "fixed" })).toMatchObject({ type: "string", enum: ["fixed"] });
		expect(normalizeSchemaForGoogle({ type: "object", properties: {} })).toMatchObject({
			type: "object",
			properties: {},
		});
	});
});
