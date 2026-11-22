import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compactWithContinuity } from "./compaction.ts";

export default function extension(pi: ExtensionAPI): void {
	pi.on("session_before_compact", compactWithContinuity);
}
