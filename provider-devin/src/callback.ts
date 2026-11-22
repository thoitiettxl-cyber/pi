// Ported from oh-my-pi (MIT)
import { createServer } from "node:http";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";

export function callbackCode(input: string, state: string): string {
	const value = input.trim();
	if (!value) throw new Error("Missing Devin authorization code");
	if (/^https?:\/\//.test(value)) {
		const url = new URL(value);
		if (url.searchParams.get("state") !== state) throw new Error("Devin OAuth state mismatch");
		if (url.searchParams.has("error")) throw new Error("Devin authorization was rejected");
		const code = url.searchParams.get("code");
		if (!code) throw new Error("Missing Devin authorization code");
		return code;
	}
	const [code, pastedState] = value.split("#");
	if (pastedState && pastedState !== state) throw new Error("Devin OAuth state mismatch");
	if (!code) throw new Error("Missing Devin authorization code");
	return code;
}

export async function browserCode(
	interaction: ProviderAuthInteraction,
	state: string,
	announce: () => void,
): Promise<string> {
	interaction.signal.throwIfAborted();
	const callback = Promise.withResolvers<string>();
	void callback.promise.catch(() => {});
	let claimed = false;
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1:59653");
		if (request.method !== "GET" || url.pathname !== "/callback") {
			response.writeHead(404).end("Not found");
			return;
		}
		if (url.searchParams.get("state") !== state) {
			response.writeHead(400).end("State mismatch");
			return;
		}
		if (claimed) {
			response.writeHead(409).end("Already handled");
			return;
		}
		try {
			const code = callbackCode(url.href, state);
			claimed = true;
			response
				.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" })
				.end("Return to pi to finish signing in.");
			callback.resolve(code);
		} catch (error) {
			response.writeHead(400).end("Authorization failed");
			callback.reject(error);
		}
	});
	const bound = Promise.withResolvers<void>();
	server.once("error", bound.reject);
	server.listen(59653, "127.0.0.1", () => bound.resolve());
	let listening = true;
	try {
		await bound.promise;
	} catch {
		listening = false;
		server.close();
	}
	const controller = new AbortController();
	const abort = () => callback.reject(new Error("Devin login cancelled"));
	interaction.signal.addEventListener("abort", abort, { once: true });
	if (interaction.signal.aborted) abort();
	const timer = setTimeout(() => callback.reject(new Error("Devin login timed out")), 5 * 60 * 1000);
	timer.unref();
	try {
		if (!listening)
			interaction.notify({
				type: "info",
				message: "Loopback callback unavailable. Paste the callback URL or code instead.",
			});
		announce();
		const manual = interaction
			.prompt({
				type: "manual_code",
				message: "Paste the Devin callback URL or authorization code (or finish in your browser):",
				signal: controller.signal,
			})
			.then((input) => callbackCode(input, state));
		return await Promise.race([callback.promise, manual]);
	} finally {
		clearTimeout(timer);
		controller.abort();
		interaction.signal.removeEventListener("abort", abort);
		server.close();
		server.closeAllConnections();
	}
}
