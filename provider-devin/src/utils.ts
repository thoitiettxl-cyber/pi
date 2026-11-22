// Ported from oh-my-pi (MIT)
import { createHash } from "node:crypto";
import type { Api } from "@earendil-works/pi-ai";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sanitizeText(text: string): string {
	return text.toWellFormed().replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

export function deterministicUuid(seed: string): string {
	const hex = createHash("sha256").update(seed).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function normalizeToolCallId(id: string, maxLength = 40): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, maxLength);
}

export function isResponsesFamilyApi(api: Api): boolean {
	return api === "openai-responses" || api === "openai-codex-responses" || api === "azure-openai-responses";
}

export function responsesCallComponent(id: string): string {
	const pipe = id.indexOf("|");
	return pipe <= 0 ? id : id.slice(0, pipe);
}

export function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}
