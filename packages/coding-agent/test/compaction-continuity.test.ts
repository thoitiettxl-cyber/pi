import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { convertToLlm, createCompactionSummaryMessage } from "../src/core/messages.ts";

describe("compaction summary continuity", () => {
	it.each(["## Next Steps\n1. Run tests", ""])("includes precedence instructions after summary %j", (summary) => {
		const recent: AgentMessage = {
			role: "user",
			content: "Tests already passed. Continue with the commit.",
			timestamp: 2,
		};
		const messages = convertToLlm([createCompactionSummaryMessage(summary, 50000, "2026-01-01"), recent]);

		expect(messages[0]).toMatchObject({
			role: "user",
			content: [
				{
					type: "text",
					text: `The conversation history before this point was compacted into the following summary:

<summary>
${summary}
</summary>

Messages after this summary are more recent and take precedence. Work they show as completed is done, even if listed above as In Progress or Next Steps. Continue from the most recent message without redoing completed steps; if unsure, verify state with a cheap read instead.`,
				},
			],
		});
		expect(messages[1]).toBe(recent);
	});
});
