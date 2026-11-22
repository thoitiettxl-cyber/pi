import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { seedModels } from "../src/models.ts";
import { transformMessages } from "../src/transform-messages.ts";

const assistant: AssistantMessage = {
	role: "assistant",
	api: "openai-responses",
	provider: "openai",
	model: "other",
	content: [
		{ type: "thinking", thinking: "private", thinkingSignature: "signed" },
		{ type: "toolCall", id: "foreign|item", name: "lookup", arguments: {}, thoughtSignature: "foreign" },
	],
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: 1,
};

describe("vendored transcript normalization", () => {
	it("normalizes foreign call/result ids and drops foreign signed reasoning", () => {
		const result = transformMessages(
			[
				assistant,
				{
					role: "toolResult",
					toolCallId: "foreign|item",
					toolName: "lookup",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 2,
				},
			],
			seedModels[0],
			(id) => id.split("|")[0],
		);
		expect(result[0].content).toEqual([{ type: "toolCall", id: "foreign", name: "lookup", arguments: {} }]);
		expect(result[1]).toMatchObject({ role: "toolResult", toolCallId: "foreign", isError: false });
		expect(assistant.content).toHaveLength(2);
	});

	it("synthesizes missing results and downgrades unsupported images", () => {
		const result = transformMessages(
			[
				assistant,
				{
					role: "user",
					content: [{ type: "image", mimeType: "image/png", data: "eA==" }],
					timestamp: 2,
				},
			],
			seedModels[0],
		);
		expect(result[1]).toMatchObject({ role: "toolResult", toolCallId: "foreign|item", isError: true });
		expect(result[2].content).toEqual([{ type: "text", text: "(image omitted: model does not support images)" }]);
	});

	it("accepts an empty transcript and drops incomplete assistant turns", () => {
		expect(transformMessages([], seedModels[0])).toEqual([]);
		expect(transformMessages([{ ...assistant, stopReason: "error" }], seedModels[0])).toEqual([]);
		expect(transformMessages([{ ...assistant, stopReason: "aborted" }], seedModels[0])).toEqual([]);
	});
});
