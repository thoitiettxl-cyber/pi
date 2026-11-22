import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/goal.ts";

test("goals created mid-turn are charged usage and hit their budget", async () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
	const tools = new Map<string, { execute: (id: string, params: unknown, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<unknown> }>();
	const saved: { action: string; goal: { tokensUsed: number; status: string } }[] = [];
	extension({
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) { handlers.set(name, handler); },
		registerTool(tool: { name: string } & Parameters<typeof tools.set>[1]) { tools.set(tool.name, tool); },
		registerCommand() {}, sendMessage() {},
		appendEntry(_type: string, data: typeof saved[number]) { saved.push(data); },
	} as unknown as ExtensionAPI);
	const ctx = { hasUI: false, hasPendingMessages: () => true, sessionManager: { getSessionId: () => "test" } } as unknown as ExtensionContext;
	for (let turn = 0; turn < 2; turn++) {
		await handlers.get("agent_start")!({}, ctx);
		await tools.get("create_goal")!.execute("create", { objective: "test", token_budget: 10 }, undefined, undefined, ctx);
		await handlers.get("agent_end")!({ messages: [{ role: "assistant", usage: { input: 7, output: 5 }, stopReason: "stop" }] }, ctx);
		assert.equal(saved.at(-1)!.action, "account");
		assert.equal(saved.at(-1)!.goal.tokensUsed, 12);
		assert.equal(saved.at(-1)!.goal.status, "budgetLimited");
		await tools.get("update_goal")!.execute("complete", { status: "complete" }, undefined, undefined, ctx);
	}
});
