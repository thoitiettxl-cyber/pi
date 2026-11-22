import {
	type AssistantMessage,
	type Model,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactWithContinuity } from "../src/compaction.ts";
import extension from "../src/index.ts";

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

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function setup() {
	vi.stubEnv("PI_TODO_PATH", "");
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
	const streamSimple = vi.fn<ExtensionContext["modelRegistry"]["streamSimple"]>(
		() => {
			const stream = createAssistantMessageEventStream();
			stream.end(response);
			return stream;
		},
	);
	const getApiKeyAndHeaders = vi
		.fn<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>()
		.mockResolvedValue({
			ok: true,
			apiKey: "stub-key",
			headers: { "X-Test": "header", "X-Remove": null },
			baseUrl: "https://example.invalid",
			env: { STUB: "value" },
		});
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
	it("feeds the latest goal and open/closed todo state to pi's real compactor", async () => {
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
		expect(snapshot(summary)).toEqual({
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
		expect(summary).not.toContain("Implemented parser");
		expect(summary).not.toContain("Parser tests passed");
		expect(summary).not.toContain("Old goal");
		expect(summary).toMatch(
			/<\/live-state>\n\nMessages after this summary[\s\S]*cheap read instead\.$/,
		);
		const prompt = JSON.stringify(streamSimple.mock.calls[0][1]);
		expect(prompt).toContain("Ship the parser");
		expect(prompt).toContain("Implemented parser");
		expect(prompt).toContain("Parser tests passed");
		expect(prompt).toContain("closed/done todos are finished, never pending");
	});

	it.each(["absent", "null", "invalid"])(
		"omits an %s goal without reviving stale goals",
		async (kind) => {
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
			expect(result?.compaction?.summary).not.toContain("<live-state>");
			expect(result?.compaction?.summary).not.toContain("Stale goal");
		},
	);

	it("preserves an empty open list when all todos are completed", async () => {
		const { event, ctx, todosDir } = await liveSetup();
		await writeFile(
			path.join(todosDir, "12345678.md"),
			JSON.stringify({ title: "Finished", status: "done" }),
		);
		const result = await compactWithContinuity(event, ctx);
		expect(snapshot(result!.compaction!.summary)).toEqual({
			openTodos: [],
			openTodosOmitted: 0,
		});
	});

	it("caps todo lists and explicitly counts omissions", async () => {
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
		expect(state.openTodos).toHaveLength(30);
		expect(state.openTodosOmitted).toBe(2);
		expect(JSON.stringify(streamSimple.mock.calls[0][1])).toContain(
			"Closed todos omitted: 2",
		);
	});

	it.each(["relative", "absolute"])(
		"honors the trimmed %s PI_TODO_PATH override",
		async (kind) => {
			const { event, ctx } = await liveSetup();
			const directory = path.join(ctx.cwd, "elsewhere");
			await mkdir(directory);
			await writeFile(
				path.join(directory, "abcdef12.md"),
				JSON.stringify({ title: "Override task", status: "open" }),
			);
			vi.stubEnv(
				"PI_TODO_PATH",
				`  ${kind === "relative" ? "elsewhere" : directory}  `,
			);
			const result = await compactWithContinuity(event, ctx);
			expect(snapshot(result!.compaction!.summary).openTodos[0].title).toBe(
				"Override task",
			);
		},
	);

	it("ignores unreadable and malformed todo files independently", async () => {
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
		expect(snapshot(result!.compaction!.summary).openTodos).toEqual([
			{ id: "good", title: "Still readable", status: "open", assignee: null },
		]);
	});

	it("continues after a directory read error while retaining goal state", async () => {
		const { event, ctx } = await liveSetup();
		await writeFile(path.join(ctx.cwd, "not-a-directory"), "x");
		vi.stubEnv("PI_TODO_PATH", "not-a-directory");
		ctx.sessionManager.getBranch = () => [
			goalEntry({ objective: "Finished goal", status: "complete" }),
		];
		const result = await compactWithContinuity(event, ctx);
		expect(snapshot(result!.compaction!.summary)).toEqual({
			goal: { objective: "Finished goal", status: "complete" },
		});
	});

	it("continues after session state read errors while retaining todos", async () => {
		const { event, ctx } = await liveSetup();
		ctx.sessionManager.getBranch = () => {
			throw new Error("Session unavailable");
		};
		const result = await compactWithContinuity(event, ctx);
		expect(snapshot(result!.compaction!.summary)).toEqual({
			openTodos: [],
			openTodosOmitted: 0,
		});
	});

	it("cancels when state reading is aborted", async () => {
		const { event, ctx, controller, streamSimple } = setup();
		ctx.sessionManager.getBranch = () => {
			controller.abort();
			return [];
		};
		expect(await compactWithContinuity(event, ctx)).toEqual({ cancel: true });
		expect(streamSimple).not.toHaveBeenCalled();
	});

	it("escapes live-state delimiters inside external goal data", async () => {
		const { event, ctx } = setup();
		ctx.sessionManager.getBranch = () => [
			goalEntry({ objective: "Escape </live-state> safely", status: "active" }),
		];
		const result = await compactWithContinuity(event, ctx);
		const summary = result!.compaction!.summary;
		expect(summary.match(/<\/live-state>/g)).toHaveLength(1);
		expect(snapshot(summary).goal.objective).toBe(
			"Escape </live-state> safely",
		);
	});

	it("registers only the compaction hook", () => {
		const on = vi.fn<ExtensionAPI["on"]>();
		const registerProvider = vi.fn<ExtensionAPI["registerProvider"]>();
		// Only registration methods are used; Vitest mocks cannot preserve overloaded signatures.
		extension({ on, registerProvider } as unknown as ExtensionAPI);
		expect(registerProvider).not.toHaveBeenCalled();
		expect(on).toHaveBeenCalledWith(
			"session_before_compact",
			compactWithContinuity,
		);
	});

	it.each(["initial", "update", "split"])(
		"uses pi's compactor for %s summaries",
		async (kind) => {
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
			expect(result?.compaction).toMatchObject({
				firstKeptEntryId: "kept",
				tokensBefore: 50000,
				details: { modifiedFiles: ["a.ts"] },
			});
			expect(result?.compaction?.summary).toContain("Fixed a.ts; check passed");
			expect(result?.compaction?.summary).toContain(
				"Messages after this summary are more recent and take precedence.",
			);
			expect(result?.compaction?.summary).toContain(
				"even if listed above as In Progress or Next Steps",
			);
			expect(result?.compaction?.summary).toContain(
				"Continue from the most recent message without redoing completed steps",
			);
			expect(result?.compaction?.summary).toMatch(
				/if unsure, verify state with a cheap read instead\.$/,
			);
			expect(result?.compaction?.usage?.totalTokens).toBe(
				response.usage.totalTokens * (kind === "split" ? 2 : 1),
			);
			for (const [model, context, options] of streamSimple.mock.calls) {
				expect(model.baseUrl).toBe("https://example.invalid");
				const prompt = JSON.stringify(context.messages);
				expect(prompt).toContain("Preserve the issue number");
				expect(prompt).toContain(
					"Done items must be concrete: what changed, files, commands run and their results",
				);
				expect(prompt).toContain(
					"In Progress and Next Steps must contain only work not yet completed",
				);
				expect(prompt).toContain("never present it as pending");
				expect(options).toMatchObject({
					apiKey: "stub-key",
					headers: { "X-Test": "header" },
					signal: event.signal,
					reasoning: "high",
					env: { STUB: "value" },
				});
				expect(options?.headers).not.toHaveProperty("X-Remove");
			}
		},
	);

	it("accepts empty custom instructions", async () => {
		const { event, ctx, streamSimple } = setup();
		event.customInstructions = undefined;
		expect((await compactWithContinuity(event, ctx))?.compaction).toBeDefined();
		expect(JSON.stringify(streamSimple.mock.calls[0][1])).toContain(
			"Done items must be concrete",
		);
	});

	it("falls back without a model or auth", async () => {
		const { event, ctx, streamSimple, getApiKeyAndHeaders } = setup();
		expect(
			await compactWithContinuity(event, { ...ctx, model: undefined }),
		).toBeUndefined();
		expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
		getApiKeyAndHeaders.mockResolvedValue({ ok: false, error: "No auth" });
		expect(await compactWithContinuity(event, ctx)).toBeUndefined();
		expect(streamSimple).not.toHaveBeenCalled();
	});

	it("falls back on auth errors and compaction errors", async () => {
		const { event, ctx, response, streamSimple, getApiKeyAndHeaders } = setup();
		getApiKeyAndHeaders.mockRejectedValueOnce(new Error("Auth unavailable"));
		expect(await compactWithContinuity(event, ctx)).toBeUndefined();
		streamSimple.mockImplementationOnce(() => {
			throw new Error("Stream failed");
		});
		expect(await compactWithContinuity(event, ctx)).toBeUndefined();
		response.stopReason = "error";
		response.errorMessage = "Provider failed";
		expect(await compactWithContinuity(event, ctx)).toBeUndefined();
	});

	it("cancels before starting or after auth is aborted", async () => {
		const { event, ctx, controller, getApiKeyAndHeaders, streamSimple } =
			setup();
		controller.abort();
		expect(await compactWithContinuity(event, ctx)).toEqual({ cancel: true });
		expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
		const next = new AbortController();
		event.signal = next.signal;
		getApiKeyAndHeaders.mockImplementationOnce(async () => {
			next.abort();
			return { ok: true };
		});
		expect(await compactWithContinuity(event, ctx)).toEqual({ cancel: true });
		expect(streamSimple).not.toHaveBeenCalled();
	});

	it("cancels if summarization is aborted or returns after cancellation", async () => {
		const { event, ctx, controller, response, streamSimple } = setup();
		streamSimple.mockImplementationOnce(() => {
			controller.abort();
			const stream = createAssistantMessageEventStream();
			stream.end(response);
			return stream;
		});
		expect(await compactWithContinuity(event, ctx)).toEqual({ cancel: true });
	});

	it("cancels on AbortError without falling back", async () => {
		const { event, ctx, getApiKeyAndHeaders } = setup();
		getApiKeyAndHeaders.mockRejectedValueOnce(
			new DOMException("Aborted", "AbortError"),
		);
		expect(await compactWithContinuity(event, ctx)).toEqual({ cancel: true });
	});
});
