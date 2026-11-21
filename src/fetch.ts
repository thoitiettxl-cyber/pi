// Fetch for Devin RPCs: no redirects (credentials ride in every body) and bounded retries.

/** Options for {@link fetchDevin}. */
export interface DevinFetchOptions {
	signal?: AbortSignal;
	/** Retries after network failures and 408/409/429/5xx responses (default 0). */
	maxRetries?: number;
	/** Longest server-requested retry delay to honor; longer ones return the response (default 60000, 0 = no cap). */
	maxRetryDelayMs?: number;
	/** Called before every attempt. */
	onAttempt?: () => void;
	/** Called before sleeping between attempts. */
	onRetryWait?: () => void;
}

const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const MAX_BACKOFF_MS = 8_000;

/** POST a Devin RPC with `redirect: "error"`, retrying transient failures up to `maxRetries` times. */
export async function fetchDevin(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	options: DevinFetchOptions,
): Promise<Response> {
	const maxRetries = options.maxRetries ?? 0;
	for (let attempt = 0; ; attempt++) {
		options.onAttempt?.();
		let response: Response;
		try {
			response = await fetchImpl(url, { ...init, redirect: "error", signal: options.signal });
		} catch (error) {
			if (options.signal?.aborted || attempt >= maxRetries) throw error;
			options.onRetryWait?.();
			await abortableSleep(backoffMs(attempt), options.signal);
			continue;
		}
		if (attempt >= maxRetries || !isRetryableStatus(response.status)) return response;
		const delayMs = serverRetryDelayMs(response.headers) ?? backoffMs(attempt);
		const maxDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
		if (maxDelayMs > 0 && delayMs > maxDelayMs) return response;
		await response.body?.cancel().catch(() => {});
		options.onRetryWait?.();
		await abortableSleep(delayMs, options.signal);
	}
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

function serverRetryDelayMs(headers: Headers): number | undefined {
	const ms = Number.parseFloat(headers.get("retry-after-ms") ?? "");
	if (Number.isFinite(ms) && ms >= 0) return ms;
	const retryAfter = headers.get("retry-after");
	if (!retryAfter) return undefined;
	const seconds = Number.parseFloat(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const date = Date.parse(retryAfter);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function backoffMs(attempt: number): number {
	return Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS) * (1 - Math.random() * 0.25);
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
