/**
 * Devin Provider Extension
 *
 * Adds a `devin` provider that runs prompts as Devin sessions through the Devin API
 * (https://docs.devin.ai/api-reference/overview). Authentication is a Devin API key:
 * store it with `/login devin`, or set DEVIN_API_KEY.
 *
 * The first prompt of a conversation creates a Devin session; later prompts are sent to that
 * session as messages. The session ID is kept in the assistant message's `responseId`, so a
 * resumed or forked pi session keeps talking to the same Devin session. Devin works in its own
 * environment, so pi's tools are not offered to it.
 *
 * Usage:
 *   pi -e ./packages/coding-agent/examples/extensions/custom-provider-devin
 *   # Then /login devin (or set DEVIN_API_KEY) and /model devin/devin
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	createProvider,
	envApiKeyAuth,
	type Message,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEVIN_PROVIDER_ID = "devin";
export const DEVIN_API = "devin-sessions";
export const DEVIN_BASE_URL = "https://api.devin.ai/v1";

const POLL_INTERVAL_MS = 5_000;
const TURN_END_STATUSES = new Set(["blocked", "finished", "expired"]);
const STOPPED_STATUSES = new Set(["finished", "expired"]);

interface DevinSessionMessage {
	type: string;
	message: string;
}

interface CreatedDevinSession {
	session_id: string;
	url: string;
}

interface DevinSession {
	session_id: string;
	status_enum?: string | null;
	messages?: DevinSessionMessage[];
}

/** Creates the `devin` provider. `pollIntervalMs` exists for tests. */
export function devinProvider(pollIntervalMs = POLL_INTERVAL_MS): Provider {
	const stream = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) =>
		streamDevin(model, context, options, pollIntervalMs);
	return createProvider({
		id: DEVIN_PROVIDER_ID,
		name: "Devin",
		baseUrl: DEVIN_BASE_URL,
		auth: { apiKey: envApiKeyAuth("Devin API key", ["DEVIN_API_KEY"]) },
		models: [
			{
				id: "devin",
				name: "Devin",
				api: DEVIN_API,
				provider: DEVIN_PROVIDER_ID,
				baseUrl: DEVIN_BASE_URL,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 32_000,
			},
		],
		api: { stream, streamSimple: stream },
	});
}

/** Sends the new user prompts to Devin and streams Devin's replies as one assistant message. */
export function streamDevin(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	pollIntervalMs: number,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	(async () => {
		const signal = options?.signal;
		try {
			const apiKey = options?.apiKey;
			if (!apiKey) throw new Error("No Devin API key. Run /login devin or set DEVIN_API_KEY");
			const api = devinClient(model.baseUrl, apiKey, signal);

			const { sessionId: previousSessionId, prompts } = pendingPrompts(context.messages, model.provider);
			if (prompts.length === 0) throw new Error("No user prompt to send to Devin");
			const prompt = prompts.join("\n\n");

			let sessionId: string;
			let sessionUrl: string | undefined;
			let seen = 0;
			if (previousSessionId) {
				sessionId = previousSessionId;
				seen = devinReplies(await api.getSession(sessionId)).length;
				await api.sendMessage(sessionId, prompt);
			} else {
				const created = await api.createSession(prompt);
				sessionId = created.session_id;
				sessionUrl = created.url;
			}
			output.responseId = sessionId;
			stream.push({ type: "start", partial: output });

			let session = await api.getSession(sessionId);
			let replies = devinReplies(session);
			while (!isTurnOver(session, replies.length > seen)) {
				await sleep(pollIntervalMs, signal);
				session = await api.getSession(sessionId);
				replies = devinReplies(session);
			}

			const text = [...replies.slice(seen), ...(sessionUrl ? [`Devin session: ${sessionUrl}`] : [])].join("\n\n");
			output.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			output.content[0] = { type: "text", text };
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
			stream.push({ type: "done", reason: "stop", message: output });
		} catch (error) {
			output.stopReason = signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
		}
		stream.end();
	})();

	return stream;
}

/**
 * Finds the Devin session of the conversation (the `responseId` of the last Devin reply) and the
 * user prompts written after that reply, which are the ones Devin has not seen yet.
 */
export function pendingPrompts(messages: Message[], provider: string): { sessionId?: string; prompts: string[] } {
	const prompts: string[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant" && message.provider === provider && message.responseId) {
			return { sessionId: message.responseId, prompts: prompts.reverse() };
		}
		if (message.role !== "user") continue;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		if (text.trim()) prompts.push(text);
	}
	return { prompts: prompts.reverse() };
}

function devinReplies(session: DevinSession): string[] {
	return (session.messages ?? []).filter((m) => m.type === "devin_message").map((m) => m.message);
}

/** Devin's turn is over once it waits for the user after replying, or the session has stopped. */
function isTurnOver(session: DevinSession, hasNewReply: boolean): boolean {
	const status = session.status_enum ?? "";
	return STOPPED_STATUSES.has(status) || (hasNewReply && TURN_END_STATUSES.has(status));
}

function devinClient(baseUrl: string, apiKey: string, signal: AbortSignal | undefined) {
	const request = async <T>(method: "GET" | "POST", path: string, body?: object): Promise<T> => {
		const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
			method,
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
			signal,
		});
		if (!response.ok) {
			throw new Error(`Devin API ${method} ${path} failed: ${response.status} ${await response.text()}`);
		}
		return (await response.json()) as T;
	};
	return {
		createSession: (prompt: string) => request<CreatedDevinSession>("POST", "/sessions", { prompt }),
		getSession: (sessionId: string) => request<DevinSession>("GET", `/sessions/${encodeURIComponent(sessionId)}`),
		sendMessage: (sessionId: string, message: string) =>
			request<unknown>("POST", `/sessions/${encodeURIComponent(sessionId)}/message`, { message }),
	};
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		signal?.throwIfAborted();
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(devinProvider());
}
