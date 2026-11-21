// Ported from pi (MIT), packages/ai/src/api/transform-messages.ts.
import type { Api, AssistantMessage, ImageContent, Message, Model, TextContent, ToolCall } from "@earendil-works/pi-ai";

function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;
	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) result.push({ type: "text", text: placeholder });
			previousWasPlaceholder = true;
			continue;
		}
		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}
	return result;
}

function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	if (model.input.includes("image")) return messages;
	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, "(image omitted: model does not support images)"),
			};
		}
		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, "(tool image omitted: model does not support images)"),
			};
		}
		return msg;
	});
}

/** Normalize replayed provider content and pair tool calls with their results. */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	const toolCallIdMap = new Map<string, string>();
	const normalizedMessages = messages.map((msg) => (msg.content == null ? { ...msg, content: [] } : msg));
	const imageAwareMessages = downgradeUnsupportedImages(normalizedMessages, model);
	const transformed = imageAwareMessages.map((msg) => {
		if (msg.role === "system" || msg.role === "user") return msg;
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			return normalizedId && normalizedId !== msg.toolCallId ? { ...msg, toolCallId: normalizedId } : msg;
		}
		if (msg.role === "assistant") {
			const isSameModel = msg.provider === model.provider && msg.api === model.api && msg.model === model.id;
			const content = msg.content.flatMap((block) => {
				if (block.type === "thinking") {
					if (!isSameModel) return [];
					if (block.redacted || block.thinkingSignature) return block;
					return block.thinking?.trim() ? block : [];
				}
				if (block.type === "text") return isSameModel ? block : { type: "text" as const, text: block.text };
				if (block.type === "toolCall") {
					let toolCall = block;
					if (!isSameModel && block.thoughtSignature) {
						toolCall = { ...block };
						delete toolCall.thoughtSignature;
					}
					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(block.id, model, msg);
						if (normalizedId !== block.id) {
							toolCallIdMap.set(block.id, normalizedId);
							toolCall = { ...toolCall, id: normalizedId };
						}
					}
					return toolCall;
				}
				return block;
			});
			return { ...msg, content };
		}
		return msg;
	});

	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	const heldSystemMessages: Message[] = [];
	const closePendingToolCalls = () => {
		for (const call of pendingToolCalls) {
			if (!existingToolResultIds.has(call.id)) {
				result.push({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: "No result provided" }],
					isError: true,
					timestamp: Date.now(),
				});
			}
		}
		pendingToolCalls = [];
		existingToolResultIds = new Set();
		result.push(...heldSystemMessages);
		heldSystemMessages.length = 0;
	};
	for (const msg of transformed) {
		if (msg.role === "assistant") {
			closePendingToolCalls();
			if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
			pendingToolCalls = msg.content.filter((block): block is ToolCall => block.type === "toolCall");
			result.push(msg);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else if (msg.role === "system") {
			if (pendingToolCalls.length > 0) heldSystemMessages.push(msg);
			else result.push(msg);
		} else {
			closePendingToolCalls();
			result.push(msg);
		}
	}
	closePendingToolCalls();
	return result;
}
