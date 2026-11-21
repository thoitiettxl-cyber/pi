// Ported from oh-my-pi (MIT)
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { browserCode } from "./callback.ts";
import { generatePKCE } from "./pkce.ts";
import { isRecord } from "./utils.ts";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const REDIRECT_URI = "http://127.0.0.1:59653/callback";

export const devinOAuth: OAuthAuth = {
	name: "Devin",
	isSubscription: true,
	login: async (interaction) => {
		const method = await interaction.prompt({
			type: "select",
			message: "Devin login method",
			options: [
				{ id: "browser", label: "Sign in with Devin in a browser" },
				{ id: "cli", label: "Use existing Devin CLI credentials" },
			],
		});
		interaction.signal.throwIfAborted();
		if (method === "cli") return tokenCredential(await readDevinCliCredentials(devinCliCredentialPaths()));
		if (method !== "browser") throw new Error("Unknown Devin login method");
		return loginBrowser(interaction);
	},
	refresh: async (credential, signal) => {
		signal.throwIfAborted();
		if (credential.expires <= Date.now()) throw new Error("Devin credentials expired. Run /login again.");
		return credential;
	},
	toAuth: async (credential) => ({ apiKey: credential.access }),
};

export function tokenCredential(token: string): OAuthCredential {
	let expires = Date.now() + YEAR_MS;
	try {
		const payload: unknown = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
		if (isRecord(payload) && typeof payload.exp === "number" && Number.isFinite(payload.exp))
			expires = payload.exp * 1000;
	} catch {}
	return { type: "oauth", access: token, refresh: token, expires };
}

export async function loginBrowser(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();
	const params = new URLSearchParams({
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		prompt: "select_account",
	});
	const code = await browserCode(interaction, state, () => {
		interaction.notify({
			type: "auth_url",
			url: `https://app.devin.ai/auth/cli/continue?${params}`,
			instructions: "Sign in to Devin in your browser.",
		});
	});
	const response = await fetch("https://api.devin.ai/auth/cli/token", {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ code, code_verifier: verifier }),
		signal: interaction.signal,
	});
	if (!response.ok) throw new Error(`Devin token exchange failed (${response.status})`);
	const body: unknown = await response.json();
	if (!isRecord(body) || typeof body.token !== "string" || !body.token.trim()) {
		throw new Error("Devin token exchange returned no token");
	}
	return tokenCredential(body.token);
}

export function devinCliCredentialPaths(
	homedir = os.homedir(),
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string[] {
	const win = platform === "win32";
	const p = win ? path.win32 : path.posix;
	const dataDirs = [
		win ? env.APPDATA : undefined,
		env.XDG_DATA_HOME,
		p.join(homedir, ".local", "share"),
		win ? undefined : p.join(homedir, "Library", "Application Support"),
	];
	return [
		...new Set(dataDirs.filter((dir): dir is string => !!dir).map((dir) => p.join(dir, "devin", "credentials.toml"))),
	];
}

export async function readDevinCliCredentials(candidates: readonly string[]): Promise<string> {
	for (const file of candidates) {
		let text: string;
		try {
			text = await fs.readFile(file, "utf8");
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") continue;
			throw new Error(`Cannot read Devin CLI credentials at ${file}`);
		}
		return parseCredentials(text);
	}
	throw new Error("No Devin CLI credentials found. Run `devin auth login`, then retry.");
}

export function parseCredentials(text: string): string {
	const values: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		if (line.startsWith("[")) break;
		const match = /^([\w-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(line);
		if (!match) {
			if (/^(windsurf_api_key|api_server_url)\s*=/.test(line)) throw new Error("Invalid Devin CLI credential string");
			continue;
		}
		if (Object.hasOwn(values, match[1])) throw new Error("Duplicate Devin CLI credential field");
		try {
			values[match[1]] = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2].slice(1, -1);
		} catch {
			throw new Error("Invalid Devin CLI credential string");
		}
	}
	const key = values.windsurf_api_key?.trim();
	if (!key) throw new Error("Devin CLI credentials have no windsurf_api_key. Run `devin auth login`, then retry.");
	if (values.api_server_url) {
		let host: string;
		try {
			host = new URL(values.api_server_url).host;
		} catch {
			throw new Error("Invalid Devin CLI API server URL");
		}
		if (!["server.codeium.com", "server.enterprise.windsurf.com"].includes(host)) {
			throw new Error("Devin CLI credentials point at an unsupported API server");
		}
	}
	return key;
}
