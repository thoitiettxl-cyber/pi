import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/goal.ts";

function setupGoal() {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
	const tools = new Map<string, { execute: (id: string, params: unknown, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<unknown> }>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const saved: { action: string; goal: { tokensUsed: number; status: string } }[] = [];
	extension({
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) { handlers.set(name, handler); },
		registerTool(tool: { name: string } & Parameters<typeof tools.set>[1]) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: Parameters<typeof commands.set>[1]) { commands.set(name, command); }, sendMessage() {},
		appendEntry(_type: string, data: typeof saved[number]) { saved.push(data); },
	} as unknown as ExtensionAPI);
	const ctx = { hasUI: false, hasPendingMessages: () => true, sessionManager: { getSessionId: () => "test" } } as unknown as ExtensionContext;
	return { handlers, tools, commands, saved, ctx };
}

test("goals created mid-turn are charged usage and hit their budget", async () => {
	const { handlers, tools, saved, ctx } = setupGoal();
	for (let turn = 0; turn < 2; turn++) {
		await handlers.get("agent_start")!({}, ctx);
		const creationMessage = { role: "assistant", usage: { input: 20, output: 10 }, stopReason: "toolUse" };
		await handlers.get("message_start")!({ message: creationMessage }, ctx);
		await handlers.get("message_end")!({ message: creationMessage }, ctx);
		await tools.get("create_goal")!.execute("create", { objective: "test", token_budget: 10 }, undefined, undefined, ctx);
		const message = { role: "assistant", usage: { input: 7, output: 5 }, stopReason: "stop" };
		await handlers.get("message_start")!({ message }, ctx);
		await handlers.get("message_end")!({ message }, ctx);
		await handlers.get("agent_end")!({ messages: [creationMessage, message] }, ctx);
		assert.equal(saved.at(-1)!.action, "account");
		assert.equal(saved.at(-1)!.goal.tokensUsed, 12);
		assert.equal(saved.at(-1)!.goal.status, "budgetLimited");
		await tools.get("update_goal")!.execute("complete", { status: "complete" }, undefined, undefined, ctx);
	}
});

test("pausing a streaming response still charges it to the goal active at message start", async () => {
	const { handlers, tools, commands, saved, ctx } = setupGoal();
	await tools.get("create_goal")!.execute("goal", { objective: "test" }, undefined, undefined, ctx);
	await handlers.get("message_start")!({ message: { role: "assistant" } }, ctx);
	await commands.get("goal")!.handler("pause", ctx);
	await handlers.get("message_end")!({ message: { role: "assistant", usage: { input: 7, output: 5 } } }, ctx);
	assert.equal(saved.at(-1)!.goal.tokensUsed, 12);
	assert.equal(saved.at(-1)!.goal.status, "paused");
	await commands.get("goal")!.handler("resume", ctx);
	assert.equal(saved.at(-1)!.goal.tokensUsed, 12);
});

test("a replacement goal is charged only messages after its creation", async () => {
	const { handlers, tools, saved, ctx } = setupGoal();
	const oldMessage = { role: "assistant", usage: { input: 7, output: 5 }, stopReason: "toolUse" };
	const newMessage = { role: "assistant", usage: { input: 3, output: 2 }, stopReason: "stop" };
	await tools.get("create_goal")!.execute("old", { objective: "old" }, undefined, undefined, ctx);
	await handlers.get("agent_start")!({}, ctx);
	await handlers.get("message_start")!({ message: oldMessage }, ctx);
	await handlers.get("message_end")!({ message: oldMessage }, ctx);
	await tools.get("update_goal")!.execute("complete", { status: "complete" }, undefined, undefined, ctx);
	await tools.get("create_goal")!.execute("new", { objective: "new", token_budget: 10 }, undefined, undefined, ctx);
	await handlers.get("message_start")!({ message: newMessage }, ctx);
	await handlers.get("message_end")!({ message: newMessage }, ctx);
	await handlers.get("agent_end")!({ messages: [oldMessage, newMessage] }, ctx);
	assert.equal(saved.at(-1)!.goal.tokensUsed, 5);
	assert.equal(saved.at(-1)!.goal.status, "active");
	assert.equal(saved.find((entry) => entry.action === "status")!.goal.tokensUsed, 12);
});

test("resuming or replacing a goal mid-response does not charge an unrelated response", async () => {
	for (const replace of [false, true]) {
		const { handlers, tools, commands, saved, ctx } = setupGoal();
		await tools.get("create_goal")!.execute("goal", { objective: "old" }, undefined, undefined, ctx);
		await commands.get("goal")!.handler("pause", ctx);
		await handlers.get("message_start")!({ message: { role: "assistant" } }, ctx);
		if (replace) {
			await commands.get("goal")!.handler("clear", ctx);
			await tools.get("create_goal")!.execute("new", { objective: "new" }, undefined, undefined, ctx);
		} else await commands.get("goal")!.handler("resume", ctx);
		await handlers.get("message_end")!({ message: { role: "assistant", usage: { input: 7, output: 5 } } }, ctx);
		assert.equal(saved.at(-1)!.goal.tokensUsed, 0);
	}
});
