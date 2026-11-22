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
	const store = { version: 5, nextSeq: 2006, dropped: 5, entries: Array.from({ length: 2000 }, (_, i) => ({ seq: i + 6, level: "log", message: String(i + 6) })) };
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

test("logs follow restarts its cursor when the page buffer resets", async () => {
	const store = { version: 5, generation: "old", nextSeq: 101, dropped: 0, entries: [{ seq: 100, level: "log", message: "old page" }] };
	const page = vm.createContext({ window: { __agentLogs: store } });
	let reads = 0;
	const output = await runScript("logs-tail", ["--follow", "--for=0.05", "--poll", "20", "--since=99", "--limit=200"], {
		ensureBroker: async () => {}, cdpCall: async () => {}, brokerRequest: async () => ({ events: [] }),
		evaluate: async (code: string) => {
			if (code.includes("const store") && ++reads === 2) {
				store.generation = "new";
				store.nextSeq = 2;
				store.entries = [{ seq: 1, level: "log", message: "new page" }];
			}
			return vm.runInContext(code, page);
		},
	});
	assert.ok(output.some((line) => line.startsWith("[log] new page")), output.join("\n"));
});

test("logs follow stops immediately when the last buffered record reaches the limit", async () => {
	for (const limit of [0, 1]) {
		const store = { version: 5, nextSeq: limit + 1, dropped: 0, entries: limit ? [{ seq: 1, level: "log", message: "only record" }] : [] };
		const page = vm.createContext({ window: { __agentLogs: store } });
		let reads = 0;
		await runScript("logs-tail", ["--follow", "--for=0.05", "--poll", "20", `--limit=${limit}`], {
			ensureBroker: async () => {}, cdpCall: async () => {}, brokerRequest: async () => ({ events: [] }),
			evaluate: async (code: string) => {
				if (code.includes("const store")) reads++;
				return vm.runInContext(code, page);
			},
		});
		assert.equal(reads, 1, `limit=${limit}`);
	}
});

test("eval --json awaits promises and await expressions, preserving BigInts", async () => {
	for (const code of ["Promise.resolve({answer:42})", "await Promise.resolve({answer:42})", "({answer:42})", "Promise.resolve({answer:42n})", "Promise.resolve(null)"]) {
		const output = await runScript("eval", [code, "--json"], {
			ensureBroker: async () => {}, applyActiveEmulation: async () => {}, sessionAdapter: () => ({}),
			evaluate: async (expression: string) => vm.runInNewContext(expression),
			cdpCall: async () => { throw new Error("Unexpected statement fallback"); },
		});
		const expected = code.includes("null") ? null : { answer: code.includes("42n") ? "42" : 42 };
		assert.deepEqual(JSON.parse(output.join("\n")), expected, code);
	}
});

test("eval never retries runtime SyntaxErrors after side effects", async () => {
	for (const json of [false, true]) {
		const page = vm.createContext({ writes: 0 });
		let fallbacks = 0;
		const code = "(writes++, Promise.reject(new SyntaxError('write failed')))";
		const output = await runScript("eval", [code, ...(json ? ["--json"] : [])], {
			ensureBroker: async () => {}, applyActiveEmulation: async () => {}, sessionAdapter: () => ({}),
			evaluate: async (expression: string) => {
				try { return await vm.runInContext(expression, page); }
				catch (error) { throw new Error(`SyntaxError: ${(error as Error).message}`); }
			},
			cdpCall: async (_method: string, params: { expression: string }) => {
				fallbacks++;
				try { await vm.runInContext(params.expression, page); } catch {}
				return { result: { value: null } };
			}, remoteObjectValue: (result: { value: unknown }) => result.value,
		});
		assert.equal(page.writes, 1, output.join("\n"));
		assert.equal(fallbacks, 0);
		assert.ok(output.some((line) => line.includes("write failed")));
	}
});

test("eval still executes statement lists once after a compile-only parse check", async () => {
	const page = vm.createContext({ writes: 0 });
	const output = await runScript("eval", ["const value = 42; writes++; value", "--json"], {
		ensureBroker: async () => {}, applyActiveEmulation: async () => {}, sessionAdapter: () => ({}),
		evaluate: async () => { throw new Error("Statements must not run as an expression"); },
		cdpCall: async (_method: string, params: { expression: string }) => ({ result: { value: vm.runInContext(params.expression, page) } }),
		remoteObjectValue: (result: { value: unknown }) => result.value,
	});
	assert.equal(page.writes, 1);
	assert.deepEqual(output, ["42"]);
});

test("stop --keep-server retains endpoint ownership but drops the broker pid", async () => {
	for (const keep of [true, false]) {
		let state: Record<string, unknown> | null = { serverPid: 123, brokerPid: 456, port: 9222, host: "127.0.0.1", stealth: true };
		try {
			await runScript("stop", keep ? ["--keep-server"] : [], {
				BROKER_PID_FILE: "unused", STORAGE_DIR: "unused", getPort: () => 9222,
				readState: () => state, clearState: () => { state = null; }, writeState: (value: Record<string, unknown>) => { state = value; },
				isProcessAlive: () => false, existsSync: () => false, execFileSync: () => "", findObscuraProcesses: () => [],
			});
		} catch (error) {
			assert.match(String(error), /exit 0/);
		}
		if (keep) {
			assert.equal(state?.serverPid, 123);
			assert.equal(state?.brokerPid, undefined);
			assert.equal(state?.port, 9222);
		} else assert.equal(state, null);
	}
});
