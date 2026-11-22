import assert from "node:assert/strict";
import { afterEach, describe, test, mock } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
	type AssistantMessage,
	type Model,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
	ExtensionHandler,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import extension, { compactWithContinuity } from "../extensions/compaction-continuity.ts";

const originalTodoPath = process.env.PI_TODO_PATH;
function stubEnv(name: string, value: string): void {
	process.env[name] = value;
}
const model: Model<"anthropic-messages"> = {
	id: "stub",
	name: "Stub",
	api: "anthropic-messages",
	provider: "stub",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};
const directories: string[] = [];
const completionRule =
	"Work counts as done only when messages show it. Open todos and a non-complete goal are NOT done: perform and verify their work with tools before closing todos or marking the goal complete.";

afterEach(async () => {
	if (originalTodoPath === undefined) delete process.env.PI_TODO_PATH;
	else process.env.PI_TODO_PATH = originalTodoPath;
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function setup() {
	stubEnv("PI_TODO_PATH", "");
	const controller = new AbortController();
	const event: SessionBeforeCompactEvent = {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "kept",
			messagesToSummarize: [
				{ role: "user", content: "Fix a.ts and run checks", timestamp: 1 },
			],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 50000,
			fileOps: {
				read: new Set(),
				written: new Set(),
				edited: new Set(["a.ts"]),
			},
			settings: {
				enabled: true,
				reserveTokens: 16384,
				keepRecentTokens: 20000,
			},
		},
		branchEntries: [],
		customInstructions: "Preserve the issue number",
		reason: "manual",
		willRetry: false,
		signal: controller.signal,
	};
	const response: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [
			{
				type: "text",
				text: "## Progress\n### Done\n- [x] Fixed a.ts; check passed",
			},
		],
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
	const streamSimple = mock.fn<
		ExtensionContext["modelRegistry"]["streamSimple"]
	>(() => {
		const stream = createAssistantMessageEventStream();
		stream.end(response);
		return stream;
	});
	const getApiKeyAndHeaders = mock.fn<
		ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]
	>(async () => ({
		ok: true,
		apiKey: "stub-key",
		headers: { "X-Test": "header", "X-Remove": null },
		baseUrl: "https://example.invalid",
		env: { STUB: "value" },
	}));
	const ctx: Parameters<typeof compactWithContinuity>[1] = {
		model,
		cwd: "/nonexistent-compaction-continuity-test",
		sessionManager: { getBranch: () => [] },
		thinkingLevel: "high",
		modelRegistry: { getApiKeyAndHeaders, streamSimple },
	};
	return {
		event,
		ctx,
		controller,
		response,
		streamSimple,
		getApiKeyAndHeaders,
	};
}

async function liveSetup() {
	const fixture = setup();
	fixture.ctx.cwd = await mkdtemp(path.join(homedir(), ".pi-continuity-test-"));
	directories.push(fixture.ctx.cwd);
	const todosDir = path.join(fixture.ctx.cwd, ".pi/todos");
	await mkdir(todosDir, { recursive: true });
	return { ...fixture, todosDir };
}

function goalEntry(goal: unknown) {
	return {
		type: "custom" as const,
		id: "goal",
		parentId: null,
		timestamp: "2026-01-01T00:00:00Z",
		customType: "goal",
		data: { goal },
	};
}

function snapshot(summary: string) {
	return JSON.parse(
		summary.split("<live-state>\n")[1].split("\n</live-state>")[0],
	);
}

describe("compaction continuity", () => {
	test("feeds the latest goal and open/closed todo state to pi's real compactor", async () => {
		const { event, ctx, todosDir, streamSimple } = await liveSetup();
		ctx.sessionManager.getBranch = () => [
			goalEntry({ objective: "Old goal", status: "active" }),
			goalEntry({
				objective: "Ship the parser",
				status: "paused",
				tokenBudget: 10000,
				tokensUsed: 400,
			}),
		];
		await writeFile(
			path.join(todosDir, "11111111.md"),
			`${JSON.stringify({ id: "ignored", title: 'Handle { braces } and "quotes" \\ safely', assigned_to_session: "session.json" }, null, 2)}\n\nBody { ignored }`,
		);
		await writeFile(
			path.join(todosDir, "22222222.md"),
			JSON.stringify({ title: "Implemented parser", status: "CLOSED" }),
		);
		await writeFile(
			path.join(todosDir, "33333333.md"),
			JSON.stringify({ title: "Parser tests passed", status: "Done" }),
		);
		const result = await compactWithContinuity(event, ctx);
		const summary = result!.compaction!.summary;
		assert.deepEqual(snapshot(summary), {
			completionRule,
			goal: {
				objective: "Ship the parser",
				status: "paused",
				tokenBudget: 10000,
				tokensUsed: 400,
			},
			openTodos: [
				{
					id: "11111111",
					title: 'Handle { braces } and "quotes" \\ safely',
					status: "open",
					assignee: "session.json",
				},
			],
			openTodosOmitted: 0,
		});
		assert.equal(summary?.includes("Implemented parser"), false);
		assert.equal(summary?.includes("Parser tests passed"), false);
		assert.equal(summary?.includes("Old goal"), false);
		assert.match(
			summary,
			/<\/live-state>\n\nMessages after this summary[\s\S]*cheap read instead\.$/,
		);
		const prompt = JSON.stringify(streamSimple.mock.calls[0].arguments[1]);
		assert.ok(prompt?.includes("Ship the parser"));
		assert.ok(prompt?.includes("Implemented parser"));
		assert.ok(prompt?.includes("Parser tests passed"));
		assert.ok(
			prompt?.includes("closed/done todos are finished, never pending"),
		);
	});

	for (const kind of ["absent", "null", "invalid"])
		test(
			"omits an %s goal without reviving stale goals".replace(
				"%s",
				String(kind),
			),
			async () => {
				const { event, ctx } = setup();
				ctx.sessionManager.getBranch = () =>
					kind === "absent"
						? []
						: [
								goalEntry({ objective: "Stale goal", status: "active" }),
								goalEntry(
									kind === "null" ? null : { objective: 42, status: "active" },
								),
							];
				const result = await compactWithContinuity(event, ctx);
				assert.equal(
					result?.compaction?.summary?.includes("<live-state>"),
					false,
				);
				assert.equal(
					result?.compaction?.summary?.includes("Stale goal"),
					false,
				);
			},
		);

	test("preserves an empty open list when all todos are completed", async () => {
		const { event, ctx, todosDir } = await liveSetup();
		await writeFile(
			path.join(todosDir, "12345678.md"),
			JSON.stringify({ title: "Finished", status: "done" }),
		);
		const result = await compactWithContinuity(event, ctx);
		assert.deepEqual(snapshot(result!.compaction!.summary), {
			completionRule,
			openTodos: [],
			openTodosOmitted: 0,
		});
	});

	test("caps todo lists and explicitly counts omissions", async () => {
		const { event, ctx, todosDir, streamSimple } = await liveSetup();
		await Promise.all(
			Array.from({ length: 64 }, (_, index) =>
				writeFile(
					path.join(todosDir, `${index.toString(16).padStart(8, "0")}.md`),
					JSON.stringify({
						title: `Task ${index}`,
						status: index < 32 ? "open" : "closed",
					}),
				),
			),
		);
		const result = await compactWithContinuity(event, ctx);
		const state = snapshot(result!.compaction!.summary);
		assert.equal(state.openTodos?.length, 30);
		assert.deepEqual(state.openTodosOmitted, 2);
		assert.ok(
			JSON.stringify(streamSimple.mock.calls[0].arguments[1])?.includes(
				"Closed todos omitted: 2",
			),
		);
	});

	for (const kind of ["relative", "absolute"])
		test(
			"honors the trimmed %s PI_TODO_PATH override".replace("%s", String(kind)),
			async () => {
				const { event, ctx } = await liveSetup();
				const directory = path.join(ctx.cwd, "elsewhere");
				await mkdir(directory);
				await writeFile(
					path.join(directory, "abcdef12.md"),
					JSON.stringify({ title: "Override task", status: "open" }),
				);
				stubEnv(
					"PI_TODO_PATH",
					`  ${kind === "relative" ? "elsewhere" : directory}  `,
				);
				const result = await compactWithContinuity(event, ctx);
				assert.deepEqual(
					snapshot(result!.compaction!.summary).openTodos[0].title,
					"Override task",
				);
			},
		);

	test("ignores unreadable and malformed todo files independently", async () => {
		const { event, ctx, todosDir } = await liveSetup();
		await mkdir(path.join(todosDir, "unreadable.md"));
		await writeFile(path.join(todosDir, "bad.md"), "{not json}");
		await writeFile(
			path.join(todosDir, "good.md"),
			JSON.stringify({ title: "Still readable" }),
		);
		await writeFile(
			path.join(todosDir, "settings.json"),
			JSON.stringify({ title: "Not a todo" }),
		);
		const result = await compactWithContinuity(event, ctx);
		assert.deepEqual(snapshot(result!.compaction!.summary).openTodos, [
			{ id: "good", title: "Still readable", status: "open", assignee: null },
		]);
	});

	test("continues after a directory read error while retaining goal state", async () => {
		const { event, ctx } = await liveSetup();
		await writeFile(path.join(ctx.cwd, "not-a-directory"), "x");
		stubEnv("PI_TODO_PATH", "not-a-directory");
		ctx.sessionManager.getBranch = () => [
			goalEntry({ objective: "Finished goal", status: "complete" }),
		];
		const result = await compactWithContinuity(event, ctx);
		assert.deepEqual(snapshot(result!.compaction!.summary), {
			completionRule,
			goal: { objective: "Finished goal", status: "complete" },
		});
	});

	test("continues after session state read errors while retaining todos", async () => {
		const { event, ctx } = await liveSetup();
		ctx.sessionManager.getBranch = () => {
			throw new Error("Session unavailable");
		};
		const result = await compactWithContinuity(event, ctx);
		assert.deepEqual(snapshot(result!.compaction!.summary), {
			completionRule,
			openTodos: [],
			openTodosOmitted: 0,
		});
	});

	test("cancels when state reading is aborted", async () => {
		const { event, ctx, controller, streamSimple } = setup();
		ctx.sessionManager.getBranch = () => {
			controller.abort();
			return [];
		};
		assert.deepEqual(await compactWithContinuity(event, ctx), { cancel: true });
		assert.equal(streamSimple.mock.callCount(), 0);
	});

	test("escapes live-state delimiters inside external goal data", async () => {
		const { event, ctx } = setup();
		ctx.sessionManager.getBranch = () => [
			goalEntry({ objective: "Escape </live-state> safely", status: "active" }),
		];
		const result = await compactWithContinuity(event, ctx);
		const summary = result!.compaction!.summary;
		assert.equal(summary.match(/<\/live-state>/g)?.length, 1);
		assert.deepEqual(
			snapshot(summary).goal.objective,
			"Escape </live-state> safely",
		);
	});

	test("registers compaction and verification hooks without a provider", () => {
		const on = mock.fn((_name: ExtensionEvent["type"], _handler: unknown) => {});
		const registerProvider = mock.fn(
			(..._args: Parameters<ExtensionAPI["registerProvider"]>) => {},
		);
		// Only registration methods are used; Node mocks cannot preserve overloaded signatures.
		extension({ on, registerProvider } as unknown as ExtensionAPI);
		assert.equal(registerProvider.mock.callCount(), 0);
		assert.ok(
			on.mock.calls.some(
				({ arguments: values }) =>
					values[0] === "session_before_compact" &&
					values[1] === compactWithContinuity,
			),
		);
		assert.deepEqual(
			on.mock.calls.map(({ arguments: [name] }) => name),
			["session_before_compact", "session_compact", "tool_call", "tool_result"],
		);
	});

	for (const kind of ["initial", "update", "split"])
		test(
			"uses pi's compactor for %s summaries".replace("%s", String(kind)),
			async () => {
				const { event, ctx, response, streamSimple } = setup();
				if (kind === "update")
					event.preparation.previousSummary = "Old work in progress";
				if (kind === "split") {
					event.preparation.isSplitTurn = true;
					event.preparation.turnPrefixMessages = [
						{ role: "user", content: "Now commit", timestamp: 2 },
					];
				}
				const result = await compactWithContinuity(event, ctx);
				assert.partialDeepStrictEqual(result?.compaction, {
					firstKeptEntryId: "kept",
					tokensBefore: 50000,
					details: { modifiedFiles: ["a.ts"] },
				});
				assert.ok(
					result?.compaction?.summary?.includes("Fixed a.ts; check passed"),
				);
				assert.ok(
					result?.compaction?.summary?.includes(
						"Messages after this summary are more recent and take precedence.",
					),
				);
				assert.ok(
					result?.compaction?.summary?.includes(
						"even if listed above as In Progress or Next Steps",
					),
				);
				assert.ok(
					result?.compaction?.summary?.includes(
						"Continue from the most recent message without redoing completed steps",
					),
				);
				assert.ok(
					result?.compaction?.summary?.includes(
						"Open todos and a non-complete goal are NOT done",
					),
				);
				assert.match(
					result!.compaction!.summary,
					/if unsure, verify state with a cheap read instead\.$/,
				);
				assert.deepEqual(
					result?.compaction?.usage?.totalTokens,
					response.usage.totalTokens * (kind === "split" ? 2 : 1),
				);
				for (const {
					arguments: [model, context, options],
				} of streamSimple.mock.calls) {
					assert.deepEqual(model.baseUrl, "https://example.invalid");
					const prompt = JSON.stringify(context.messages);
					assert.ok(prompt?.includes("Preserve the issue number"));
					assert.ok(
						prompt?.includes(
							"Done items must be concrete: what changed, files, commands run and their results",
						),
					);
					assert.ok(
						prompt?.includes(
							"In Progress and Next Steps must contain only work not yet completed",
						),
					);
					assert.ok(prompt?.includes("never present it as pending"));
					assert.partialDeepStrictEqual(options, {
						apiKey: "stub-key",
						headers: { "X-Test": "header" },
						signal: event.signal,
						reasoning: "high",
						env: { STUB: "value" },
					});
					assert.equal(
						Object.hasOwn(options?.headers ?? {}, "X-Remove"),
						false,
					);
				}
			},
		);

	test("accepts empty custom instructions", async () => {
		const { event, ctx, streamSimple } = setup();
		event.customInstructions = undefined;
		assert.notEqual(
			(await compactWithContinuity(event, ctx))?.compaction,
			undefined,
		);
		assert.ok(
			JSON.stringify(streamSimple.mock.calls[0].arguments[1])?.includes(
				"Done items must be concrete",
			),
		);
	});

	test("falls back without a model or auth", async () => {
		const { event, ctx, streamSimple, getApiKeyAndHeaders } = setup();
		assert.equal(
			await compactWithContinuity(event, { ...ctx, model: undefined }),
			undefined,
		);
		assert.equal(getApiKeyAndHeaders.mock.callCount(), 0);
		getApiKeyAndHeaders.mock.mockImplementation(async () => ({
			ok: false,
			error: "No auth",
		}));
		assert.equal(await compactWithContinuity(event, ctx), undefined);
		assert.equal(streamSimple.mock.callCount(), 0);
	});

	test("falls back on auth errors and compaction errors", async () => {
		const { event, ctx, response, streamSimple, getApiKeyAndHeaders } = setup();
		getApiKeyAndHeaders.mock.mockImplementationOnce(async () => {
			throw new Error("Auth unavailable");
		});
		assert.equal(await compactWithContinuity(event, ctx), undefined);
		streamSimple.mock.mockImplementationOnce(() => {
			throw new Error("Stream failed");
		});
		assert.equal(await compactWithContinuity(event, ctx), undefined);
		response.stopReason = "error";
		response.errorMessage = "Provider failed";
		assert.equal(await compactWithContinuity(event, ctx), undefined);
	});

	test("cancels before starting or after auth is aborted", async () => {
		const { event, ctx, controller, getApiKeyAndHeaders, streamSimple } =
			setup();
		controller.abort();
		assert.deepEqual(await compactWithContinuity(event, ctx), { cancel: true });
		assert.equal(getApiKeyAndHeaders.mock.callCount(), 0);
		const next = new AbortController();
		event.signal = next.signal;
		getApiKeyAndHeaders.mock.mockImplementationOnce(async () => {
			next.abort();
			return { ok: true };
		});
		assert.deepEqual(await compactWithContinuity(event, ctx), { cancel: true });
		assert.equal(streamSimple.mock.callCount(), 0);
	});

	test("cancels if summarization is aborted or returns after cancellation", async () => {
		const { event, ctx, controller, response, streamSimple } = setup();
		streamSimple.mock.mockImplementationOnce(() => {
			controller.abort();
			const stream = createAssistantMessageEventStream();
			stream.end(response);
			return stream;
		});
		assert.deepEqual(await compactWithContinuity(event, ctx), { cancel: true });
	});

	test("cancels on AbortError without falling back", async () => {
		const { event, ctx, getApiKeyAndHeaders } = setup();
		getApiKeyAndHeaders.mock.mockImplementationOnce(async () => {
			throw new DOMException("Aborted", "AbortError");
		});
		assert.deepEqual(await compactWithContinuity(event, ctx), { cancel: true });
	});
});

function guardSetup() {
	const on = mock.fn((_name: ExtensionEvent["type"], _handler: unknown) => {});
	// Only registration is used; the mock cannot preserve overloaded signatures.
	extension({ on } as unknown as ExtensionAPI);
	function handler<E extends ExtensionEvent, R>(name: E["type"]) {
		// Registration names determine the event type, unlike the overloaded mock.
		return on.mock.calls.find(({ arguments: [event] }) => event === name)!
			.arguments[1] as unknown as ExtensionHandler<E, R>;
	}
	const toolCall = handler<ToolCallEvent, ToolCallEventResult>("tool_call");
	const toolResult = handler<ToolResultEvent, ToolResultEventResult>(
		"tool_result",
	);
	const compact = handler<SessionCompactEvent, undefined>("session_compact");
	// These handlers do not use context methods.
	const ctx = {} as ExtensionContext;
	let nextId = 0;
	return {
		on,
		compact: (
			fromExtension = true,
			reason: SessionCompactEvent["reason"] = "manual",
		) =>
			compact(
				{
					type: "session_compact",
					fromExtension,
					reason,
					willRetry: false,
					compactionEntry: {
						type: "compaction",
						id: "compaction",
						parentId: null,
						timestamp: new Date(0).toISOString(),
						summary: "Summary",
						firstKeptEntryId: "first",
						tokensBefore: 50000,
					},
				},
				ctx,
			),
		call: (
			toolName: string,
			input: Record<string, unknown> = {},
			toolCallId = `call-${nextId++}`,
		) => toolCall({ type: "tool_call", toolName, input, toolCallId }, ctx),
		result: (toolName: string, toolCallId: string, isError = false) =>
			toolResult(
				{
					type: "tool_result",
					toolName,
					toolCallId,
					input: {},
					content: [],
					details: undefined,
					isError,
				},
				ctx,
			),
	};
}

const close = { action: "update", id: "todo-id", status: "closed" };
const complete = { status: "complete" };

describe("post-compaction verification guard", () => {
	test("does not restrict completion before compaction", async () => {
		const guard = guardSetup();
		assert.equal(await guard.call("todo", close), undefined);
		assert.equal(await guard.call("update_goal", complete), undefined);
	});

	for (const status of ["closed", "CLOSED", "done", "Done"])
		test(
			"blocks todo update/create with status %s after compaction".replace(
				"%s",
				String(status),
			),
			async () => {
				const guard = guardSetup();
				await guard.compact();
				for (const action of ["update", "create"]) {
					const result = await guard.call("todo", { ...close, status, action });
					assert.partialDeepStrictEqual(result, {
						block: true,
					});
					assert.ok(result);
					assert.match(
						result.reason!,
						/Check or do the remaining work with tools/,
					);
				}
			},
		);

	test("blocks goal completion and repeated completion calls", async () => {
		const guard = guardSetup();
		await guard.compact();
		for (let i = 0; i < 2; i++) {
			assert.partialDeepStrictEqual(await guard.call("update_goal", complete), {
				block: true,
			});
			assert.partialDeepStrictEqual(await guard.call("todo", close), {
				block: true,
			});
		}
	});

	test("allows state management without treating it as verification", async () => {
		const guard = guardSetup();
		await guard.compact();
		const inputs: [string, Record<string, unknown>][] = [
			["get_goal", {}],
			["create_goal", { objective: "Work" }],
			["update_goal", { status: "blocked" }],
			["todo", { action: "create", status: "open" }],
			["todo", { action: "update", status: "open" }],
			...["list", "get", "claim", "release", "append", "delete"].map(
				(action): [string, Record<string, unknown>] => ["todo", { action }],
			),
		];
		for (const [name, input] of inputs) {
			assert.equal(await guard.call(name, input, "state"), undefined);
			await guard.result(name, "state");
		}
		assert.partialDeepStrictEqual(await guard.call("todo", close), {
			block: true,
		});
		assert.partialDeepStrictEqual(await guard.call("update_goal", complete), {
			block: true,
		});
	});

	for (const tool of [
		"read",
		"bash",
		"ls",
		"grep",
		"write",
		"edit",
		"custom_check",
	])
		test(
			"allows completion only after an unrelated %s call returns".replace(
				"%s",
				String(tool),
			),
			async () => {
				const guard = guardSetup();
				await guard.compact();
				assert.equal(await guard.call(tool, {}, "verify"), undefined);
				assert.partialDeepStrictEqual(await guard.call("todo", close), {
					block: true,
				});
				assert.partialDeepStrictEqual(
					await guard.call("update_goal", complete),
					{
						block: true,
					},
				);
				await guard.result(tool, "verify");
				assert.equal(await guard.call("todo", close), undefined);
				assert.equal(await guard.call("update_goal", complete), undefined);
			},
		);

	for (const fromExtension of [true, false])
		test(
			"resets on every compaction (fromExtension=%s)".replace(
				"%s",
				String(fromExtension),
			),
			async () => {
				const guard = guardSetup();
				for (const reason of ["manual", "threshold", "overflow"] as const) {
					await guard.compact(fromExtension, reason);
					assert.partialDeepStrictEqual(await guard.call("todo", close), {
						block: true,
					});
					await guard.call("read", {}, "verify");
					await guard.result("read", "verify");
					assert.equal(await guard.call("todo", close), undefined);
				}
			},
		);

	test("does not unlock for an old or unknown tool result", async () => {
		const guard = guardSetup();
		await guard.call("read", {}, "before-first");
		await guard.compact();
		await guard.call("read", {}, "before-next");
		await guard.compact();
		for (const id of ["before-first", "before-next", "unknown"]) {
			await guard.result("read", id);
			assert.partialDeepStrictEqual(await guard.call("todo", close), {
				block: true,
			});
		}
	});

	test("counts a tool execution error as a call that ran", async () => {
		const guard = guardSetup();
		await guard.compact();
		await guard.call("read", {}, "missing-file");
		await guard.result("read", "missing-file", true);
		assert.equal(await guard.call("todo", close), undefined);
	});

	test("does not arm on failed/aborted compactions or install any tools", async () => {
		const guard = guardSetup();
		assert.deepEqual(
			guard.on.mock.calls.map(({ arguments: [name] }) => name),
			["session_before_compact", "session_compact", "tool_call", "tool_result"],
		);
		assert.equal(await guard.call("update_goal", complete), undefined);
	});

	test("keeps separate extension instances independent", async () => {
		const first = guardSetup();
		const second = guardSetup();
		await first.compact();
		assert.partialDeepStrictEqual(await first.call("todo", close), {
			block: true,
		});
		assert.equal(await second.call("todo", close), undefined);
	});
});
