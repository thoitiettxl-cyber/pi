import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
	ExtensionHandler,
	SessionCompactEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import extension from "../src/index.ts";

function setup() {
	const on = vi.fn<ExtensionAPI["on"]>();
	// Only registration is used; the mock cannot preserve overloaded signatures.
	extension({ on } as unknown as ExtensionAPI);
	function handler<E extends ExtensionEvent, R>(name: E["type"]) {
		// Registration names determine the event type, unlike the overloaded mock.
		return on.mock.calls.find(
			([event]) => event === name,
		)![1] as unknown as ExtensionHandler<E, R>;
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
	it("does not restrict completion before compaction", async () => {
		const guard = setup();
		expect(await guard.call("todo", close)).toBeUndefined();
		expect(await guard.call("update_goal", complete)).toBeUndefined();
	});

	it.each(["closed", "CLOSED", "done", "Done"])(
		"blocks todo update/create with status %s after compaction",
		async (status) => {
			const guard = setup();
			await guard.compact();
			for (const action of ["update", "create"]) {
				expect(
					await guard.call("todo", { ...close, status, action }),
				).toMatchObject({
					block: true,
					reason: expect.stringContaining(
						"Check or do the remaining work with tools",
					),
				});
			}
		},
	);

	it("blocks goal completion and repeated completion calls", async () => {
		const guard = setup();
		await guard.compact();
		for (let i = 0; i < 2; i++) {
			expect(await guard.call("update_goal", complete)).toMatchObject({
				block: true,
			});
			expect(await guard.call("todo", close)).toMatchObject({ block: true });
		}
	});

	it("allows state management without treating it as verification", async () => {
		const guard = setup();
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
			expect(await guard.call(name, input, "state")).toBeUndefined();
			await guard.result(name, "state");
		}
		expect(await guard.call("todo", close)).toMatchObject({ block: true });
		expect(await guard.call("update_goal", complete)).toMatchObject({
			block: true,
		});
	});

	it.each(["read", "bash", "ls", "grep", "write", "edit", "custom_check"])(
		"allows completion only after an unrelated %s call returns",
		async (tool) => {
			const guard = setup();
			await guard.compact();
			expect(await guard.call(tool, {}, "verify")).toBeUndefined();
			expect(await guard.call("todo", close)).toMatchObject({ block: true });
			expect(await guard.call("update_goal", complete)).toMatchObject({
				block: true,
			});
			await guard.result(tool, "verify");
			expect(await guard.call("todo", close)).toBeUndefined();
			expect(await guard.call("update_goal", complete)).toBeUndefined();
		},
	);

	it.each([true, false])(
		"resets on every compaction (fromExtension=%s)",
		async (fromExtension) => {
			const guard = setup();
			for (const reason of ["manual", "threshold", "overflow"] as const) {
				await guard.compact(fromExtension, reason);
				expect(await guard.call("todo", close)).toMatchObject({ block: true });
				await guard.call("read", {}, "verify");
				await guard.result("read", "verify");
				expect(await guard.call("todo", close)).toBeUndefined();
			}
		},
	);

	it("does not unlock for an old or unknown tool result", async () => {
		const guard = setup();
		await guard.call("read", {}, "before-first");
		await guard.compact();
		await guard.call("read", {}, "before-next");
		await guard.compact();
		for (const id of ["before-first", "before-next", "unknown"]) {
			await guard.result("read", id);
			expect(await guard.call("todo", close)).toMatchObject({ block: true });
		}
	});

	it("counts a tool execution error as a call that ran", async () => {
		const guard = setup();
		await guard.compact();
		await guard.call("read", {}, "missing-file");
		await guard.result("read", "missing-file", true);
		expect(await guard.call("todo", close)).toBeUndefined();
	});

	it("does not arm on failed/aborted compactions or install any tools", async () => {
		const guard = setup();
		expect(guard.on.mock.calls.map(([name]) => name)).toEqual([
			"session_before_compact",
			"session_compact",
			"tool_call",
			"tool_result",
		]);
		expect(await guard.call("update_goal", complete)).toBeUndefined();
	});

	it("keeps separate extension instances independent", async () => {
		const first = setup();
		const second = setup();
		await first.compact();
		expect(await first.call("todo", close)).toMatchObject({ block: true });
		expect(await second.call("todo", close)).toBeUndefined();
	});
});
