import { createHash } from "node:crypto";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	devinCliCredentialPaths,
	devinOAuth,
	loginBrowser,
	parseCredentials,
	readDevinCliCredentials,
	tokenCredential,
} from "../src/auth.ts";
import { callbackCode } from "../src/callback.ts";
import { devinCliMetadata } from "../src/wire.ts";

afterEach(() => vi.unstubAllGlobals());
describe("Devin authentication", () => {
	it("exchanges a loopback authorization code with PKCE and exact OAuth parameters", async () => {
		const realFetch = fetch;
		const controller = new AbortController();
		let challenge = "";
		const callbackDone = Promise.withResolvers<void>();
		const interaction: ProviderAuthInteraction = {
			signal: controller.signal,
			prompt: () => new Promise(() => {}),
			notify: (event) => {
				if (event.type !== "auth_url") return;
				const url = new URL(event.url);
				expect(url.origin + url.pathname).toBe("https://app.devin.ai/auth/cli/continue");
				expect(url.searchParams.get("response_type")).toBe("code");
				expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:59653/callback");
				expect(url.searchParams.get("prompt")).toBe("select_account");
				expect(url.searchParams.get("code_challenge_method")).toBe("S256");
				challenge = url.searchParams.get("code_challenge")!;
				void (async () => {
					const invalid = await realFetch("http://127.0.0.1:59653/callback?code=bad&state=wrong");
					expect(invalid.status).toBe(400);
					const valid = await realFetch(
						`http://127.0.0.1:59653/callback?code=authorization&state=${url.searchParams.get("state")}`,
					);
					expect(valid.status).toBe(200);
				})().then(callbackDone.resolve, callbackDone.reject);
			},
		};
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async (url, init) => {
				expect(url).toBe("https://api.devin.ai/auth/cli/token");
				expect(init?.headers).toEqual({ "Content-Type": "application/json", Accept: "application/json" });
				expect(init?.method).toBe("POST");
				const body = JSON.parse(String(init?.body));
				expect(body.code).toBe("authorization");
				expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(challenge);
				return Response.json({ token: "session-token" });
			}),
		);
		expect(await loginBrowser(interaction)).toMatchObject({
			type: "oauth",
			access: "session-token",
			refresh: "session-token",
		});
		await callbackDone.promise;
	});

	it("supports manual callbacks and rejects state mismatches and missing codes", () => {
		expect(callbackCode("code", "state")).toBe("code");
		expect(callbackCode("code#state", "state")).toBe("code");
		expect(callbackCode("http://127.0.0.1:59653/callback?code=x&state=state", "state")).toBe("x");
		expect(() => callbackCode("https://example.com/?code=x&state=wrong", "state")).toThrow("state mismatch");
		expect(() => callbackCode("", "state")).toThrow("Missing");
		expect(() => callbackCode("#state", "state")).toThrow("Missing");
	});

	it("handles token exchange failure and empty token without exposing response bodies", async () => {
		const interaction: ProviderAuthInteraction = {
			signal: new AbortController().signal,
			notify: () => {},
			prompt: async () => "manual",
		};
		vi.stubGlobal("fetch", async () => new Response("secret", { status: 401 }));
		await expect(loginBrowser(interaction)).rejects.toThrow("Devin token exchange failed (401)");
		vi.stubGlobal("fetch", async () => Response.json({}));
		await expect(loginBrowser(interaction)).rejects.toThrow("returned no token");
	});

	it("uses JWT expiry or a one-year fallback and never refreshes expired tokens", async () => {
		const token = `a.${Buffer.from(JSON.stringify({ exp: 123 })).toString("base64url")}.c`;
		const expired = tokenCredential(token);
		expect(expired.expires).toBe(123000);
		const valid = tokenCredential("opaque");
		expect(valid.expires - Date.now()).toBeGreaterThan(364 * 86400000);
		expect(await devinOAuth.refresh(valid, new AbortController().signal)).toBe(valid);
		await expect(devinOAuth.refresh(expired, new AbortController().signal)).rejects.toThrow("/login");
	});

	it("parses simple TOML strings and validates optional host", async () => {
		expect(
			parseCredentials('# comment\nwindsurf_api_key = "key" # inline\napi_server_url = "https://server.codeium.com"'),
		).toBe("key");
		expect(parseCredentials("windsurf_api_key = 'key'")).toBe("key");
		expect(() => parseCredentials("")).toThrow("no windsurf_api_key");
		expect(() => parseCredentials('windsurf_api_key = "key"\napi_server_url = "https://evil.invalid"')).toThrow(
			"unsupported",
		);
		expect(() => parseCredentials('windsurf_api_key = "unterminated')).toThrow("Invalid");
		expect(() => parseCredentials('windsurf_api_key = "key"\nwindsurf_api_key = "other"')).toThrow("Duplicate");
		await expect(readDevinCliCredentials(["/nonexistent/devin/credentials.toml"])).rejects.toThrow(
			"No Devin CLI credentials",
		);
		expect(devinCliCredentialPaths("/home/test", { XDG_DATA_HOME: "/data" }, "linux")).toEqual([
			"/data/devin/credentials.toml",
			"/home/test/.local/share/devin/credentials.toml",
			"/home/test/Library/Application Support/devin/credentials.toml",
		]);
	});

	it("encodes session tokens but leaves API keys and already-prefixed tokens alone", () => {
		expect(devinCliMetadata("a.b.c").apiKey).toBe("devin-session-token$a.b.c");
		expect(devinCliMetadata("devin-session-token$a.b.c").apiKey).toBe("devin-session-token$a.b.c");
		expect(devinCliMetadata("api-key").apiKey).toBe("api-key");
	});
});
