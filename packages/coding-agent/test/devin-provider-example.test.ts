import { type AssistantMessage, type Context, normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEVIN_PROVIDER_ID, devinProvider } from "../examples/extensions/custom-provider-devin/index.ts";

interface Call {
	method: string;
	url: string;
	body?: unknown;
	authorization?: string;
}

/** Stubs fetch with scripted Devin API responses, answered in order, and records the requests. */
function stubDevinApi(responses: unknown[]): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		const headers = init.headers as Record<string, string>;
		calls.push({
			method: init.method ?? "GET",
			url,
			body: init.body ? JSON.parse(init.body as string) : undefined,
			authorization: headers.Authorization,
		});
		const next = responses.shift();
		if (next === undefined) throw new Error(`Unexpected request ${init.method} ${url}`);
		return new Response(JSON.stringify(next), { status: 200 });
	});
	return calls;
}

async function run(context: Context, apiKey = "devin-key"): Promise<AssistantMessage> {
	const provider = devinProvider(1);
	const model = provider.getModels()[0];
	return provider.streamSimple(model, normalizeContext(context), { apiKey }).result();
}

function devinReply(text: string, sessionId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "devin-sessions",
		provider: DEVIN_PROVIDER_ID,
		model: "devin",
		responseId: sessionId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("custom-provider-devin example", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("creates a session for the first prompt and waits for Devin's reply", async () => {
		const calls = stubDevinApi([
			{ session_id: "devin-1", url: "https://app.devin.ai/sessions/1" },
			{ session_id: "devin-1", status_enum: "working", messages: [] },
			{
				session_id: "devin-1",
				status_enum: "blocked",
				messages: [
					{ type: "initial_user_message", message: "Fix the bug" },
					{ type: "devin_message", message: "Done, PR opened." },
				],
			},
		]);

		const result = await run({ messages: [{ role: "user", content: "Fix the bug", timestamp: 1 }] });

		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("devin-1");
		expect(result.content).toEqual([
			{ type: "text", text: "Done, PR opened.\n\nDevin session: https://app.devin.ai/sessions/1" },
		]);
		expect(calls[0]).toEqual({
			method: "POST",
			url: "https://api.devin.ai/v1/sessions",
			body: { prompt: "Fix the bug" },
			authorization: "Bearer devin-key",
		});
		expect(calls.slice(1).map((call) => `${call.method} ${call.url}`)).toEqual([
			"GET https://api.devin.ai/v1/sessions/devin-1",
			"GET https://api.devin.ai/v1/sessions/devin-1",
		]);
	});

	it("sends follow-up prompts to the session of the last Devin reply and returns only new replies", async () => {
		const calls = stubDevinApi([
			{ session_id: "devin-1", status_enum: "blocked", messages: [{ type: "devin_message", message: "First" }] },
			null,
			{ session_id: "devin-1", status_enum: "blocked", messages: [{ type: "devin_message", message: "First" }] },
			{
				session_id: "devin-1",
				status_enum: "blocked",
				messages: [
					{ type: "devin_message", message: "First" },
					{ type: "user_message", message: "Also add tests" },
					{ type: "devin_message", message: "Tests added." },
				],
			},
		]);

		const result = await run({
			messages: [
				{ role: "user", content: "Fix the bug", timestamp: 1 },
				devinReply("First", "devin-1"),
				{ role: "user", content: [{ type: "text", text: "Also add tests" }], timestamp: 2 },
			],
		});

		expect(result.content).toEqual([{ type: "text", text: "Tests added." }]);
		expect(result.responseId).toBe("devin-1");
		expect(calls[1]).toMatchObject({
			method: "POST",
			url: "https://api.devin.ai/v1/sessions/devin-1/message",
			body: { message: "Also add tests" },
		});
	});

	it("ends the turn without a reply when the session has stopped", async () => {
		stubDevinApi([
			{ session_id: "devin-1", url: "https://app.devin.ai/sessions/1" },
			{ session_id: "devin-1", status_enum: "expired", messages: [] },
		]);

		const result = await run({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] });

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Devin session: https://app.devin.ai/sessions/1" }]);
	});

	it("reports Devin API failures as errors", async () => {
		vi.stubGlobal("fetch", async () => new Response("invalid key", { status: 401 }));

		const result = await run({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Devin API POST /sessions failed: 401 invalid key");
	});
});
