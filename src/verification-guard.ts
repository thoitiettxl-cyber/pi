import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATE_TOOLS = new Set(["todo", "get_goal", "create_goal", "update_goal"]);

export function registerVerificationGuard(pi: ExtensionAPI): void {
	let needsVerification = false;
	const pendingCalls = new Set<string>();

	pi.on("session_compact", () => {
		needsVerification = true;
		pendingCalls.clear();
	});

	pi.on("tool_call", (event) => {
		if (!needsVerification) return;
		const closesTodo =
			event.toolName === "todo" &&
			(event.input.action === "update" || event.input.action === "create") &&
			typeof event.input.status === "string" &&
			["closed", "done"].includes(event.input.status.toLowerCase());
		const completesGoal =
			event.toolName === "update_goal" && event.input.status === "complete";
		if (closesTodo || completesGoal) {
			return {
				block: true,
				reason:
					"Post-compaction verification required. Open todos and a non-complete goal are NOT done. Check or do the remaining work with tools (read, bash, write, edit, etc.), verify the result, then retry closing the todo or completing the goal. Goal/todo getters do not verify the work. A paused goal is not a completed goal; do explicitly requested work without inventing a goal-resume step.",
			};
		}
		if (!STATE_TOOLS.has(event.toolName)) pendingCalls.add(event.toolCallId);
	});

	pi.on("tool_result", (event) => {
		// Only calls started in this compaction window can unlock it.
		if (needsVerification && pendingCalls.delete(event.toolCallId)) {
			needsVerification = false;
			pendingCalls.clear();
		}
	});
}
