#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const NATIVE_SEARCH_APIS = new Set(["openai-responses", "anthropic-messages", "openai-codex-responses"]);

function parseArgs(argv) {
	const out = {
		provider: undefined,
		model: undefined,
		purpose: "general research support",
		timeoutMs: 120000,
		json: false,
		help: false,
		query: "",
	};

	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			out.help = true;
			continue;
		}
		if (arg === "--json") {
			out.json = true;
			continue;
		}
		if (arg === "--provider") {
			out.provider = argv[++i];
			continue;
		}
		if (arg.startsWith("--provider=")) {
			out.provider = arg.slice("--provider=".length);
			continue;
		}
		if (arg === "--model") {
			out.model = argv[++i];
			continue;
		}
		if (arg.startsWith("--model=")) {
			out.model = arg.slice("--model=".length);
			continue;
		}
		if (arg === "--purpose") {
			out.purpose = argv[++i] || out.purpose;
			continue;
		}
		if (arg.startsWith("--purpose=")) {
			out.purpose = arg.slice("--purpose=".length) || out.purpose;
			continue;
		}
		if (arg === "--timeout") {
			out.timeoutMs = Math.max(1000, Number(argv[++i] || out.timeoutMs));
			continue;
		}
		if (arg.startsWith("--timeout=")) {
			out.timeoutMs = Math.max(1000, Number(arg.slice("--timeout=".length) || out.timeoutMs));
			continue;
		}
		positional.push(arg);
	}

	out.query = positional.join(" ").trim();
	return out;
}

function usage() {
	return `Usage:
  node search.mjs "<query>" [--purpose "<why>"] [--provider <id>] [--model <id>] [--json]

Uses session PI_PROVIDER / PI_MODEL when --provider / --model are omitted.

Examples:
  node search.mjs "latest python release" --purpose "update dependency notes"
  node search.mjs "HTTP/3 browser support 2026"
  node search.mjs "vite 7 breaking changes" --json`;
}

function nonempty(value) {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function readJson(path, fallback = {}) {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return fallback;
	}
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function getAgentDir() {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (!configured) return join(homedir(), ".pi", "agent");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
	return configured;
}

function findPiExecutable() {
	const cmd = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(cmd, ["pi"], { encoding: "utf8" });
	if (result.status !== 0) return undefined;
	const first = result.stdout
		.split(/\r?\n/)
		.map((x) => x.trim())
		.find(Boolean);
	return first || undefined;
}

function collectModuleCandidates(fileName, envVarName) {
	const candidates = new Set();

	const add = (p) => {
		if (!p) return;
		const abs = isAbsolute(p) ? p : resolve(p);
		candidates.add(abs);
	};

	if (envVarName && process.env[envVarName]) add(process.env[envVarName]);

	const cwd = process.cwd();
	const scriptDir = dirname(fileURLToPath(import.meta.url));
	for (const start of [cwd, scriptDir]) {
		let dir = start;
		for (let i = 0; i < 8; i++) {
			add(join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", fileName));
			add(join(dir, "packages", "ai", "dist", fileName));
			add(join(dir, "ai", "dist", fileName));
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}

	const piExec = findPiExecutable();
	if (piExec) {
		try {
			const piReal = realpathSync(piExec);
			const piDir = dirname(piReal);
			add(join(piDir, "..", "..", "ai", "dist", fileName));
			add(join(piDir, "..", "..", "pi-ai", "dist", fileName));
			add(join(piDir, "..", "node_modules", "@earendil-works", "pi-ai", "dist", fileName));
			add(join(piDir, "..", "..", "node_modules", "@earendil-works", "pi-ai", "dist", fileName));
		} catch {
			// ignore
		}
	}

	const installRoot = process.env.PI_MANAGED_INSTALL_ROOT || join(homedir(), ".pi", "agent", "install");
	const releasesDir = join(installRoot, "releases");
	if (existsSync(releasesDir)) {
		try {
			for (const name of readdirSync(releasesDir)) {
				add(join(releasesDir, name, "node_modules", "@earendil-works", "pi-ai", "dist", fileName));
			}
		} catch {
			// ignore
		}
	}

	add(join(homedir(), "Development", "pi-mono", "packages", "ai", "dist", fileName));

	return Array.from(candidates);
}

async function importIfExists(path, tried) {
	if (!existsSync(path)) return undefined;
	try {
		return await import(pathToFileURL(path).href);
	} catch (err) {
		tried.push(`${path} (${err?.code || err?.message || "failed"})`);
		return undefined;
	}
}

async function loadPiAi() {
	const tried = [];

	try {
		const [index, all] = await Promise.all([
			import("@earendil-works/pi-ai"),
			import("@earendil-works/pi-ai/providers/all"),
		]);
		if (typeof all.builtinModels === "function" && typeof index.contentText === "function") {
			return { builtinModels: all.builtinModels, contentText: index.contentText };
		}
		tried.push("@earendil-works/pi-ai (missing builtinModels or contentText)");
	} catch (err) {
		tried.push(`@earendil-works/pi-ai (${err?.code || err?.message || "not found"})`);
	}

	if (process.env.PI_AI_MODULE_PATH) {
		const indexPath = process.env.PI_AI_MODULE_PATH;
		const distDir = dirname(indexPath);
		const allPath = join(distDir, "providers", "all.js");
		const indexMod = await importIfExists(indexPath, tried);
		const allMod = await importIfExists(allPath, tried);
		if (typeof allMod?.builtinModels === "function" && typeof indexMod?.contentText === "function") {
			return { builtinModels: allMod.builtinModels, contentText: indexMod.contentText };
		}
	}

	for (const allPath of collectModuleCandidates("providers/all.js")) {
		const indexPath = join(dirname(allPath), "..", "index.js");
		const allMod = await importIfExists(allPath, tried);
		const indexMod = await importIfExists(indexPath, tried);
		if (typeof allMod?.builtinModels === "function" && typeof indexMod?.contentText === "function") {
			return { builtinModels: allMod.builtinModels, contentText: indexMod.contentText };
		}
	}

	throw new Error(
		`Could not load @earendil-works/pi-ai. Set PI_AI_MODULE_PATH to its dist/index.js.\nTried:\n- ${tried.join("\n- ")}`,
	);
}

function createFileCredentialStore(authPath) {
	let chain = Promise.resolve();
	const enqueue = (fn) => {
		const run = chain.then(fn, fn);
		chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	return {
		async read(providerId) {
			const data = readJson(authPath, {});
			const cred = data[providerId];
			return cred && typeof cred === "object" ? cred : undefined;
		},
		async list() {
			const data = readJson(authPath, {});
			return Object.entries(data)
				.filter(([, credential]) => credential && typeof credential === "object" && credential.type)
				.map(([providerId, credential]) => ({ providerId, type: credential.type }));
		},
		modify(providerId, fn) {
			return enqueue(async () => {
				const data = readJson(authPath, {});
				const current = data[providerId];
				const next = await fn(current);
				if (next !== undefined) {
					data[providerId] = next;
					writeJson(authPath, data);
				}
				return next ?? current;
			});
		},
		delete(providerId) {
			return enqueue(async () => {
				const data = readJson(authPath, {});
				delete data[providerId];
				writeJson(authPath, data);
			});
		},
	};
}

function resolveSessionTarget(args, settings) {
	const provider =
		nonempty(args.provider) || nonempty(process.env.PI_PROVIDER) || nonempty(settings?.defaultProvider);
	const model =
		nonempty(args.model) || nonempty(process.env.PI_MODEL) || nonempty(settings?.defaultModel);
	if (!provider || !model) {
		throw new Error(
			"Could not resolve provider/model. Pass --provider/--model or run from a Pi bash tool (PI_PROVIDER/PI_MODEL).",
		);
	}
	return { provider, model };
}

function lookupCustomApi(agentDir, provider, modelId) {
	const data = readJson(join(agentDir, "models.json"), {});
	const entry = data?.providers?.[provider];
	if (!entry || typeof entry !== "object") return undefined;
	const models = Array.isArray(entry.models) ? entry.models : [];
	const found = models.find((item) => item && item.id === modelId);
	return nonempty(found?.api) || nonempty(entry.api) || undefined;
}

function unsupportedSearchError(api, provider, modelId) {
	return new Error(
		`Native web search is not implemented for api '${api}' (provider '${provider}', model '${modelId}'). Use Exa web_search_exa, then Firecrawl firecrawl_search.`,
	);
}

function hasToolType(tools, type) {
	return Array.isArray(tools) && tools.some((tool) => tool && tool.type === type);
}

function injectNativeSearch(api) {
	return (payload) => {
		if (!payload || typeof payload !== "object") return payload;

		if (api === "openai-responses" || api === "openai-codex-responses") {
			const tools = Array.isArray(payload.tools) ? payload.tools.slice() : [];
			if (!hasToolType(tools, "web_search") && !hasToolType(tools, "web_search_2025_08_26")) {
				tools.push({ type: "web_search" });
			}
			return { ...payload, tools };
		}

		if (api === "anthropic-messages") {
			const tools = Array.isArray(payload.tools) ? payload.tools.slice() : [];
			if (!hasToolType(tools, "web_search_20250305")) {
				tools.push({ type: "web_search_20250305", name: "web_search", max_uses: 5 });
			}
			const betas = Array.isArray(payload.betas) ? payload.betas.slice() : [];
			if (!betas.includes("web-search-2025-03-05")) {
				betas.push("web-search-2025-03-05");
			}
			return { ...payload, tools, betas };
		}

		return payload;
	};
}

function buildUserPrompt(query, purpose) {
	return `Search the internet for: ${query}\n\nPurpose: ${purpose}\n\nReturn a concise research summary with:\n- 3 to 7 key findings\n- for every finding: title, why it matters for this purpose, and a full canonical URL (https://...)\n- if multiple sources disagree, call that out\n- finish with a short recommendation on which source(s) to trust first.`;
}

function buildSystemPrompt() {
	return "You are a fast web research assistant. Always produce practical summaries and include full source URLs (no shortened links).";
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.query) {
		console.error(usage());
		process.exit(args.help ? 0 : 1);
	}

	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const settings = readJson(join(agentDir, "settings.json"), {});
	const { provider, model: modelId } = resolveSessionTarget(args, settings);

	const { builtinModels, contentText } = await loadPiAi();
	const models = builtinModels({ credentials: createFileCredentialStore(authPath) });
	const model = models.getModel(provider, modelId);
	const api = model?.api || lookupCustomApi(agentDir, provider, modelId) || "unknown";

	if (!NATIVE_SEARCH_APIS.has(api) || !model) {
		throw unsupportedSearchError(api, provider, modelId);
	}

	const message = await models.completeSimple(
		model,
		{
			systemPrompt: buildSystemPrompt(),
			messages: [{ role: "user", content: buildUserPrompt(args.query, args.purpose) }],
		},
		{
			timeoutMs: args.timeoutMs,
			maxTokens: 1800,
			toolChoice: "auto",
			onPayload: injectNativeSearch(api),
		},
	);

	if (message?.stopReason === "error") {
		throw new Error(message.errorMessage || `${provider} request failed`);
	}

	const text = contentText(message?.content || []).trim();
	if (!text) {
		throw new Error(`${provider} returned an empty response`);
	}

	if (args.json) {
		console.log(
			JSON.stringify(
				{
					provider,
					model: model.id,
					query: args.query,
					purpose: args.purpose,
					result: text,
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(`Provider: ${provider}`);
	console.log(`Model: ${model.id}`);
	console.log("");
	console.log(text);
}

main().catch((err) => {
	console.error(`Error: ${err?.message || err}`);
	process.exit(1);
});
