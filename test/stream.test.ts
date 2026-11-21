import { gunzipSync, gzipSync } from "node:zlib";
import { type AssistantMessage, isContextOverflow, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectFrameDecoder, frameConnectMessage } from "../src/connect-frame.ts";
import {
	AssignModelRequestSchema,
	AssignModelResponseSchema,
	ChatToolCallSchema,
	type GetChatMessageRequest,
	GetChatMessageRequestSchema,
	type GetChatMessageResponse,
	GetChatMessageResponseSchema,
	GetUserJwtRequestSchema,
	GetUserJwtResponseSchema,
	ModelAssignmentSchema,
	ModelUsageStatsSchema,
	StopReason,
} from "../src/devin-proto.ts";
import { type DevinModel, seedModels } from "../src/models.ts";
import { create, fromBinary, toBinary } from "../src/protobuf.ts";
import { streamDevin } from "../src/stream.ts";

const model = seedModels[0];
const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] } as TranscriptContext;
afterEach(() => vi.unstubAllGlobals());

function frame(message: Partial<GetChatMessageResponse>, compressed = false): Buffer {
	const bytes = toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, message));
	return frameConnectMessage(compressed ? gzipSync(bytes) : bytes, compressed ? 1 : 0);
}

function transport(frames: Buffer[], inspect?: (request: GetChatMessageRequest) => void, router = false): typeof fetch {
	return vi.fn<typeof fetch>(async (input, init) => {
		const url = String(input);
		const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
		if (url.endsWith("/GetUserJwt")) {
			const request = fromBinary(GetUserJwtRequestSchema, body);
			expect(request.metadata).toMatchObject({
				apiKey: "devin-session-token$a.b.c",
				ideType: "chisel",
				ideName: "devin-cli",
			});
			return new Response(
				toBinary(
					GetUserJwtResponseSchema,
					create(GetUserJwtResponseSchema, {
						userJwt: "user-jwt",
						customApiServerUrl: router ? "https://custom.invalid/" : "",
					}),
				),
			);
		}
		if (url.endsWith("/AssignModel")) {
			expect(router).toBe(true);
			expect(url.startsWith("https://custom.invalid/")).toBe(true);
			const request = fromBinary(AssignModelRequestSchema, body);
			expect(request).toMatchObject({ cascadeId: "session", modelRouterUid: "adaptive" });
			expect(request.chatMessagePrompt?.prompt).toBe("hello");
			return new Response(
				toBinary(
					AssignModelResponseSchema,
					create(AssignModelResponseSchema, {
						assignment: create(ModelAssignmentSchema, { assignmentJwt: "assignment", modelUid: "gemini-test" }),
					}),
				),
			);
		}
		expect(url).toContain("/GetChatMessage");
		const envelopes = [...new ConnectFrameDecoder().decode(body)];
		expect(envelopes).toHaveLength(1);
		const envelope = envelopes[0];
		const request = fromBinary(
			GetChatMessageRequestSchema,
			envelope.flags & 1 ? gunzipSync(envelope.payload) : envelope.payload,
		);
		inspect?.(request);
		const bytes = Buffer.concat(frames);
		// Split headers and protobuf payloads across reads, not just whole frames.
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					for (let start = 0; start < bytes.length; start += 3) controller.enqueue(bytes.subarray(start, start + 3));
					controller.close();
				},
			}),
		);
	});
}

describe("Cascade stream", () => {
	it("accumulates signature-only thinking fragments including an empty signed block", async () => {
		for (const deltaThinking of ["plan", ""]) {
			const result = await streamDevin(model, context, {
				apiKey: "a.b.c",
				fetch: transport([
					frame({ deltaThinking, deltaSignature: "part-1" }),
					frame({ deltaSignature: "-part-2" }),
					frame({ deltaText: "answer" }),
				]),
			}).result();
			expect(result.content[0]).toEqual({
				type: "thinking",
				thinking: deltaThinking,
				thinkingSignature: "part-1-part-2",
			});
			expect(result.stopReason).toBe("stop");
		}
	});

	it("decodes gzip text/thinking, signatures, token usage and cost with hooks", async () => {
		const onPayload = vi.fn((payload: unknown) => payload);
		const onResponse = vi.fn();
		const onProviderStreamEvent = vi.fn();
		const fetch = transport(
			[
				frame({ deltaThinking: "plan", deltaSignature: "signed", messageId: "response" }, true),
				frame({ deltaText: "hello", actualModelUid: "upstream" }),
				frame({
					usage: create(ModelUsageStatsSchema, {
						inputTokens: 100n,
						outputTokens: 20n,
						cacheReadTokens: 10n,
						cacheWriteTokens: 5n,
					}),
				}),
				frameConnectMessage(Buffer.from("{}"), 2),
			],
			(request) => {
				expect(request.metadata).toMatchObject({ apiKey: "devin-session-token$a.b.c", userJwt: "user-jwt" });
				expect(request.cascadeId).toBe("session");
				expect(request.configuration).toMatchObject({
					temperature: 0.0001,
					topK: 40n,
					topP: Math.fround(0.95),
					maxTokens: 128000n,
				});
			},
		);
		const priced: DevinModel = { ...model, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } };
		const stream = streamDevin(priced, context, {
			apiKey: "a.b.c",
			fetch,
			sessionId: "session",
			temperature: 0,
			onPayload,
			onResponse,
			onProviderStreamEvent,
		});
		const events = [];
		for await (const event of stream) events.push(event.type);
		const result = await stream.result();
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "plan", thinkingSignature: "signed" },
			{ type: "text", text: "hello" },
		]);
		expect(result).toMatchObject({
			responseId: "response",
			responseModel: "upstream",
			stopReason: "stop",
			usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, totalTokens: 135 },
		});
		expect(result.usage.cost.total).toBeCloseTo(0.00014725);
		expect(events).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(onPayload).toHaveBeenCalledOnce();
		expect(onResponse).toHaveBeenCalledOnce();
		expect(onProviderStreamEvent).toHaveBeenCalledTimes(3);
	});

	it("accepts fragment and cumulative tool argument deltas", async () => {
		const chunks = [
			create(ChatToolCallSchema, { id: "call", name: "lookup", argumentsJson: '{"x":' }),
			create(ChatToolCallSchema, { argumentsJson: "1" }),
			create(ChatToolCallSchema, { argumentsJson: '{"x":1}' }),
		];
		const result = await streamDevin(model, context, {
			apiKey: "a.b.c",
			fetch: transport(chunks.map((call) => frame({ deltaToolCalls: [call] }))),
		}).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([{ type: "toolCall", id: "call", name: "lookup", arguments: { x: 1 } }]);
	});

	it("handles empty responses and MAX_TOKENS", async () => {
		const empty = await streamDevin(model, context, { apiKey: "a.b.c", fetch: transport([]) }).result();
		expect(empty.content).toEqual([]);
		expect(empty.stopReason).toBe("stop");
		const limited = await streamDevin(model, context, {
			apiKey: "a.b.c",
			fetch: transport([frame({ stopReason: StopReason.MAX_TOKENS })]),
		}).result();
		expect(limited.stopReason).toBe("length");
	});

	it("preserves MAX_TOKENS when a tool call is truncated", async () => {
		const result = await streamDevin(model, context, {
			apiKey: "a.b.c",
			fetch: transport([
				frame({ deltaToolCalls: [create(ChatToolCallSchema, { id: "call", name: "lookup", argumentsJson: '{"x":' })] }),
				frame({ stopReason: StopReason.MAX_TOKENS }),
			]),
		}).result();
		expect(result.stopReason).toBe("length");
		expect(result.content[0]).toMatchObject({ type: "toolCall", id: "call" });
	});

	it("surfaces compressed trailer errors with details", async () => {
		const trailer = {
			error: { code: "permission_denied", message: "not allowed", details: [{ type: "debug", debug: "detail" }] },
		};
		const result = await streamDevin(model, context, {
			apiKey: "a.b.c",
			fetch: transport([frameConnectMessage(gzipSync(JSON.stringify(trailer)), 3)]),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("permission_denied: not allowed");
		expect(result.errorMessage).toContain("debug: detail");
	});

	it("surfaces a model ERROR stop even without an error trailer or with tool output", async () => {
		for (const deltaToolCalls of [
			[],
			[create(ChatToolCallSchema, { id: "call", name: "lookup", argumentsJson: "{}" })],
		]) {
			const stream = streamDevin(model, context, {
				apiKey: "a.b.c",
				fetch: transport([
					frame({ deltaText: "partial", deltaToolCalls }),
					frame({ stopReason: StopReason.ERROR }),
					frameConnectMessage(Buffer.from("{}"), 2),
				]),
			});
			const events = [];
			for await (const event of stream) events.push(event.type);
			const result = await stream.result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("StopReason.ERROR");
			expect(events.at(-1)).toBe("error");
			expect(events).not.toContain("done");
		}
	});

	it("classifies only large shrinkable history as context overflow", async () => {
		const trailer = frameConnectMessage(
			Buffer.from(JSON.stringify({ error: { code: "invalid_argument", message: "an internal error occurred" } })),
			2,
		);
		const history = {
			messages: [
				{ role: "user", content: "x".repeat(530000), timestamp: 1 },
				{ role: "user", content: "hello", timestamp: 2 },
			],
		} as TranscriptContext;
		const result = await streamDevin(model, history, { apiKey: "a.b.c", fetch: transport([trailer]) }).result();
		expect(isContextOverflow(result)).toBe(true);
		const small = await streamDevin(model, context, { apiKey: "a.b.c", fetch: transport([trailer]) }).result();
		expect(isContextOverflow(small)).toBe(false);
		const activeOnly = { messages: [{ role: "user", content: "x".repeat(530000), timestamp: 1 }] } as TranscriptContext;
		const active = await streamDevin(model, activeOnly, { apiKey: "a.b.c", fetch: transport([trailer]) }).result();
		expect(isContextOverflow(active)).toBe(false);
	});

	it("aborts before fetch and while waiting on the body", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetch = vi.fn<typeof globalThis.fetch>();
		const cancelled = await streamDevin(model, context, { apiKey: "a.b.c", fetch, signal: controller.signal }).result();
		expect(cancelled.stopReason).toBe("aborted");
		expect(fetch).not.toHaveBeenCalled();
		const active = new AbortController();
		const bodyStarted = Promise.withResolvers<void>();
		const hanging: typeof globalThis.fetch = async (url, init) => {
			if (String(url).endsWith("/GetUserJwt")) return transport([])(url, init);
			return new Response(
				new ReadableStream({
					start() {
						bodyStarted.resolve();
					},
				}),
			);
		};
		const stream = streamDevin(model, context, { apiKey: "a.b.c", fetch: hanging, signal: active.signal });
		await bodyStarted.promise;
		active.abort();
		expect((await stream.result()).stopReason).toBe("aborted");
	});

	it("assigns router models and uses the custom server and assignment JWT", async () => {
		const router: DevinModel = { ...model, id: "adaptive", devin: { modelRouter: true } };
		const result = await streamDevin(router, context, {
			apiKey: "a.b.c",
			sessionId: "session",
			fetch: transport(
				[frame({ deltaText: "routed" })],
				(request) => {
					expect(request.chatModelUid).toBe("gemini-test");
					expect(request.modelAssignmentJwt).toBe("assignment");
					expect(request.cascadeId).toBe("session");
				},
				true,
			),
		}).result();
		expect(result.responseModel).toBe("gemini-test");
		expect(result.stopReason).toBe("stop");
	});

	it("uses transcripts, image history, foreign call ids, effort routing and Gemini schemas", async () => {
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "other",
			content: [{ type: "toolCall", id: "call|item", name: "lookup", arguments: {} }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		};
		const transcript = {
			messages: [
				{
					role: "system",
					content: "system",
					timestamp: 0,
					toolsAdded: [
						{
							name: "lookup",
							description: "look",
							parameters: { type: "object", properties: { x: { type: ["number", "null"] } } },
						},
					],
				},
				{
					role: "user",
					content: [
						{ type: "text", text: "image" },
						{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
					],
					timestamp: 1,
				},
				assistant,
				{
					role: "toolResult",
					toolCallId: "call|item",
					toolName: "lookup",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 3,
				},
			],
		} as TranscriptContext;
		const gemini: DevinModel = {
			...model,
			input: ["text", "image"],
			id: "gemini-test",
			devin: { effortRouting: { high: "gemini-high" }, supportsParallelToolCalls: true },
		};
		const result = await streamDevin(gemini, transcript, {
			apiKey: "a.b.c",
			reasoning: "high",
			fetch: transport([frame({ deltaText: "ok" })], (request) => {
				expect(request.prompt).toBe("system");
				expect(request.chatModelUid).toBe("gemini-high");
				expect(request.chatMessagePrompts[0].images[0]).toMatchObject({
					mimeType: "image/png",
					base64Data: "aGVsbG8=",
				});
				expect(request.chatMessagePrompts[1].toolCalls[0].id).toBe("call");
				expect(request.chatMessagePrompts[2].toolCallId).toBe("call");
				expect(request.disableParallelToolCalls).toBe(false);
				expect(JSON.parse(request.tools[0].jsonSchemaString).properties.x.type).toBe("number");
			}),
		}).result();
		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("stop");
	});

	it("reports HTTP failures without echoing HTML or secrets", async () => {
		const fetch: typeof globalThis.fetch = async () => new Response("<html>secret</html>", { status: 403 });
		const result = await streamDevin(model, context, { apiKey: "a.b.c", fetch }).result();
		expect(result.errorMessage).toBe("Devin auth error 403");
		expect(() => streamDevin(model, context)).toThrow("API key missing");
	});

	it("routes undefined reasoning to Off instead of the account thinking default", async () => {
		const routed: DevinModel = {
			...model,
			devin: {
				defaultLevel: "high",
				requestModelId: "default-high",
				effortRouting: { off: "no-thinking", high: "thinking-high" },
			},
			samplingParamsByThinkingLevel: { off: { top_k: 10 }, high: { top_k: 80 } },
		};
		for (const reasoning of [undefined, "high"] as const) {
			const result = await streamDevin(routed, context, {
				apiKey: "a.b.c",
				reasoning,
				fetch: transport([frame({ deltaText: "ok" })], (request) => {
					expect(request.chatModelUid).toBe(reasoning ? "thinking-high" : "no-thinking");
					expect(request.configuration?.topK).toBe(reasoning ? 80n : 10n);
				}),
			}).result();
			expect(result.stopReason).toBe("stop");
		}
	});

	it("resolves model sampling defaults and payload replacements", async () => {
		const configured: DevinModel = {
			...model,
			samplingParams: { top_p: 0.8, top_k: 12, temperature: 0.4 },
			samplingParamsByThinkingLevel: { high: { top_k: 15 } },
		};
		const result = await streamDevin(configured, context, {
			apiKey: "a.b.c",
			reasoning: "high",
			samplingParams: { top_k: 16 },
			maxTokens: 99,
			onPayload: (payload) => ({ ...(payload as GetChatMessageRequest), cascadeId: "replaced" }),
			fetch: transport([frame({ deltaText: "ok" })], (request) => {
				expect(request.cascadeId).toBe("replaced");
				expect(request.configuration).toMatchObject({
					topK: 16n,
					topP: Math.fround(0.8),
					temperature: 0.4,
					maxTokens: 99n,
				});
			}),
		}).result();
		expect(result.errorMessage).toBeUndefined();
	});
});
