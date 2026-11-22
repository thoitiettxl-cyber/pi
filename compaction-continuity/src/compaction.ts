import {
	compact,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import {
	COMPLETION_RULE,
	liveStateBlock,
	liveStateInstructions,
	readLiveState,
} from "./live-state.ts";

type CompactionContext = Pick<
	ExtensionContext,
	"model" | "thinkingLevel" | "cwd"
> & {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">;
	modelRegistry: Pick<
		ExtensionContext["modelRegistry"],
		"getApiKeyAndHeaders" | "streamSimple"
	>;
};

const INSTRUCTIONS = `Keep the existing summary format and headings. Done items must be concrete: what changed, files, commands run and their results. In Progress and Next Steps must contain only work not yet completed in the conversation; never list completed work there. Move completed items from In Progress or Next Steps to Done. For split-turn summaries, describe completed work concretely and never present it as pending. Only summarize information present in the conversation.`;

const CONTINUITY_NOTE = `Messages after this summary are more recent and take precedence. Work they show as completed is done, even if listed above as In Progress or Next Steps. ${COMPLETION_RULE} Continue from the most recent message without redoing completed steps; if unsure, verify state with a cheap read instead.`;

export async function compactWithContinuity(
	event: SessionBeforeCompactEvent,
	ctx: CompactionContext,
): Promise<SessionBeforeCompactResult | undefined> {
	if (event.signal.aborted) return { cancel: true };
	if (!ctx.model) return;
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (event.signal.aborted) return { cancel: true };
		if (!auth.ok) return;
		const headers = auth.headers
			? Object.fromEntries(
					Object.entries(auth.headers).flatMap(([key, value]) =>
						value === null ? [] : [[key, value]],
					),
				)
			: undefined;
		const model = auth.baseUrl
			? { ...ctx.model, baseUrl: auth.baseUrl }
			: ctx.model;
		const state = await readLiveState(ctx.cwd, ctx.sessionManager);
		if (event.signal.aborted) return { cancel: true };
		const instructions = [
			event.customInstructions,
			INSTRUCTIONS,
			liveStateInstructions(state),
		]
			.filter(Boolean)
			.join("\n\n");
		const compaction = await compact(
			event.preparation,
			model,
			auth.apiKey,
			headers,
			instructions,
			event.signal,
			ctx.thinkingLevel,
			(requestModel, context, options) =>
				ctx.modelRegistry.streamSimple(requestModel, context, options),
			auth.env,
		);
		if (event.signal.aborted) return { cancel: true };
		return {
			compaction: {
				...compaction,
				summary: [compaction.summary, liveStateBlock(state), CONTINUITY_NOTE]
					.filter(Boolean)
					.join("\n\n"),
			},
		};
	} catch (error) {
		if (
			event.signal.aborted ||
			(error instanceof Error && error.name === "AbortError")
		)
			return { cancel: true };
		return;
	}
}
