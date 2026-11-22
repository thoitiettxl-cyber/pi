// Ported from oh-my-pi (MIT)
import type { Tool } from "@earendil-works/pi-ai";
import { upgradeJsonSchemaTo202012 } from "./schema/draft.ts";
import { normalizeSchemaForGoogle } from "./schema/normalize.ts";

export { normalizeSchemaForGoogle };

export function toolWireSchema(tool: Tool): object {
	return upgradeJsonSchemaTo202012(JSON.parse(JSON.stringify(tool.parameters))) as object;
}
