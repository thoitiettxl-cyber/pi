import {
	type AssistantMessage,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { compactWithContinuity } from "../src/compaction.ts";
import extension from "../src/index.ts";
import { seedModels } from "../src/models.ts";

function setup() {
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
		api: seedModels[0].api,
		provider: "devin",
		model: seedModels[0].id,
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
		model: seedModels[0],
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

describe("compaction continuity", () => {
	it("registers alongside the Devin provider", () => {
		const on = vi.fn<ExtensionAPI["on"]>();
		const registerProvider = vi.fn<ExtensionAPI["registerProvider"]>();
		// Only registration methods are used; Vitest mocks cannot preserve overloaded signatures.
		extension({ on, registerProvider } as unknown as ExtensionAPI);
		expect(registerProvider).toHaveBeenCalledOnce();
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
