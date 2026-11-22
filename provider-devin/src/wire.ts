// Ported from oh-my-pi (MIT)
/**
 * Devin (Codeium Cascade) wire constants shared by auth, catalog discovery and
 * chat streaming. Free of the protobuf runtime so auth can import it cheaply.
 */

/** Base host for Codeium/Windsurf's Cascade API (Connect protocol over HTTP/1.1). */
export const DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com";

const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";

/** `Metadata.os` vocabulary; `process.platform` is fixed for the process lifetime. */
const DEVIN_OS = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
const DEVIN_LOCALE = "en";

/**
 * Released Devin CLI request identity. The backend gates behavior on this
 * tuple: `ideType: "chisel"` is what unlocks router assignment (`AssignModel`)
 * and the CLI model surface. No local source reports the current CLI release,
 * so the version stays pinned; bump it with {@link DEVIN_CLI_USER_AGENT}.
 */
const DEVIN_CLI_METADATA = {
	ideName: "devin-cli",
	ideType: "chisel",
	ideVersion: "3000.12.57",
	extensionName: "chisel",
	extensionVersion: "3000.12.57",
	locale: DEVIN_LOCALE,
	os: DEVIN_OS,
} as const;

/** HTTP `User-Agent` of the released Devin CLI (a connect-go client), sent on chat requests. */
export const DEVIN_CLI_USER_AGENT = "connect-go/1.18.1 (go1.26.3)";

/**
 * Native discovery identity. The Devin CLI announces itself as the `chisel`
 * client on its dev channel for `GetCliModelConfigs`; that identity, not the
 * released chat identity, unlocks the full native config set.
 */
const DEVIN_DISCOVERY_METADATA = {
	ideName: "chisel",
	ideVersion: "0.0.0-dev",
	extensionName: "chisel",
	extensionVersion: "0.0.0-dev",
	locale: DEVIN_LOCALE,
	os: DEVIN_OS,
} as const;

/** Prefixes bare JWT-shaped session tokens; every other key, legacy `sk-ws-` ones included, goes out as stored. */
function encodeDevinCredential(apiKey: string | undefined): string {
	const key = apiKey?.trim();
	if (!key) return "";
	if (key.startsWith(DEVIN_SESSION_TOKEN_PREFIX)) return key;
	return key.split(".").length === 3 ? `${DEVIN_SESSION_TOKEN_PREFIX}${key}` : key;
}

/**
 * Fields for `Metadata` on released-CLI calls (`GetUserJwt`, `AssignModel`,
 * `GetChatMessage`).
 */
export function devinCliMetadata(apiKey: string | undefined, userJwt = "") {
	return {
		apiKey: encodeDevinCredential(apiKey),
		userJwt,
		...DEVIN_CLI_METADATA,
	};
}

/** Fields for `Metadata` on the dev-channel `GetCliModelConfigs` call. */
export function devinDiscoveryMetadata(apiKey: string | undefined) {
	return {
		apiKey: encodeDevinCredential(apiKey),
		...DEVIN_DISCOVERY_METADATA,
	};
}

/**
 * Validate a Devin API server URL and return it without a trailing slash. The
 * server receives the API key in every request body, so only plain HTTPS
 * origins with an optional path are accepted (no credentials, query or fragment,
 * which would also push the RPC path out of the pathname).
 */
export function parseDevinServerUrl(value: string, source: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${source} returned an invalid API server URL`);
	}
	if (url.protocol !== "https:") throw new Error(`${source} returned a non-HTTPS API server URL`);
	if (url.username || url.password || url.search || url.hash || value.includes("?") || value.includes("#")) {
		throw new Error(`${source} returned an API server URL with credentials, query or fragment`);
	}
	return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}
