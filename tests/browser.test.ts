import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { parseFlags } from "../skills/web-browser/scripts/cli.js";

async function runScript(name: string, args: string[], mocks: Record<string, unknown>) {
	const url = new URL(`../skills/web-browser/scripts/${name}.js`, import.meta.url);
	const source = (await readFile(url, "utf8")).split("\n").slice(2).join("\n")
		.replace(/^import[\s\S]*?from ["'][^"']+["'];\n/gm, "")
		.replaceAll("import.meta.url", JSON.stringify(url.href));
	const output: string[] = [];
	await vm.runInNewContext(`(async () => { ${source}\n })()`, {
		URL, Set, Date, parseFlags, setTimeout, clearTimeout,
		process: { argv: ["node", url.pathname, ...args], env: {}, exit(code: number) { throw new Error(`exit ${code}`); } },
		console: { log: (...parts: unknown[]) => output.push(parts.join(" ")), error: (...parts: unknown[]) => output.push(parts.join(" ")) },
		...mocks,
	});
	return output;
}

test("logs paging resumes after the last printed sequence and survives ring-buffer wrap", async () => {
	const store = { version: 4, nextSeq: 2006, dropped: 5, entries: Array.from({ length: 2000 }, (_, i) => ({ seq: i + 6, level: "log", message: String(i + 6) })) };
	const page = vm.createContext({ window: { __agentLogs: store } });
	const mocks = { ensureBroker: async () => {}, cdpCall: async () => {}, brokerRequest: async () => ({ events: [] }), evaluate: async (code: string) => vm.runInContext(code, page) };
	const first = await runScript("logs-tail", ["--limit=2"], mocks);
	assert.ok(first.includes("entries printed: 2; next --since=7"), first.join("\n"));
	const next = await runScript("logs-tail", ["--limit=2", "--since=7"], mocks);
	assert.ok(next.some((line) => line.startsWith("[log] 8 ")), next.join("\n"));
	assert.ok(next.includes("entries printed: 2; next --since=9"));
	const wrapped = await runScript("logs-tail", ["--limit=2", "--since=2004"], mocks);
	assert.ok(wrapped.some((line) => line.startsWith("[log] 2005 ")), wrapped.join("\n"));
});
