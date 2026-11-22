/**
 * Retry the xAI "at capacity" wording Pi does not recognise.
 *
 * pi-ai classifies transient provider errors by regex (dist/utils/retry.js).
 * Its capacity pattern is "model is at capacity", but xAI answers a saturated
 * model with "The model is currently at capacity due to high demand. ...",
 * so the turn fails on the first attempt instead of entering the agent retry
 * loop that `settings.retry` configures. Rewriting only that wording at
 * message_end keeps every other error untouched and needs no provider change.
 *
 * Remove this extension once the classifier matches the "currently" form.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CAPACITY = /model is currently at capacity/gi;

/** "currently at capacity" -> "at capacity", the form pi-ai already retries. */
export function normalizeCapacityMessage(message: string): string {
  return message.replace(CAPACITY, "model is at capacity");
}

export default function (pi: ExtensionAPI) {
  pi.on("message_end", async (event) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "error") return;
    const errorMessage = message.errorMessage;
    if (typeof errorMessage !== "string" || !CAPACITY.test(errorMessage)) return;
    CAPACITY.lastIndex = 0;
    return { message: { ...message, errorMessage: normalizeCapacityMessage(errorMessage) } };
  });
}
