// Ported from oh-my-pi (MIT)
/**
 * Protobuf decoding helpers for Devin's unary Connect RPCs, shared by
 * discovery and chat.
 */

import { gunzipSync } from "node:zlib";
import { fromBinary, type MessageCodec, type ProtoMessage } from "./protobuf.ts";

const MAX_UNARY_INFLATED_BYTES = 16 * 1024 * 1024;

/**
 * Read a unary response body, failing once it exceeds 16 MiB. Fetch inflates
 * HTTP-level gzip before this sees the bytes, so the cap applies after inflation.
 */
export async function readDevinUnaryBody(response: Response): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return Buffer.concat(chunks);
			size += value.byteLength;
			if (size > MAX_UNARY_INFLATED_BYTES) {
				await reader.cancel().catch(() => {});
				throw new Error(`Devin response exceeds ${MAX_UNARY_INFLATED_BYTES}-byte cap`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Decode a unary Devin Connect response. Edges variously return bare protobuf
 * or a gzipped protobuf body; Node's `fetch` normally decompresses first, so the
 * direct decode is attempted before the gzip fallback. Returns `null` when
 * neither representation decodes against `schema`.
 */
export function decodeDevinUnaryMessage<TMessage extends ProtoMessage>(
	schema: MessageCodec<TMessage>,
	payload: Uint8Array,
): TMessage | null {
	try {
		return fromBinary(schema, payload);
	} catch {
		try {
			return fromBinary(schema, gunzipSync(payload, { maxOutputLength: MAX_UNARY_INFLATED_BYTES }));
		} catch {
			return null;
		}
	}
}
