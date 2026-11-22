import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/unified-edit.ts";

test("REPLACE preserves blank context instead of editing a noncontiguous match", async () => {
	let edit!: { execute: (id: string, params: { text: string }, signal: undefined, update: undefined, ctx: { cwd: string }) => Promise<unknown> };
	extension({ registerTool(tool: typeof edit) { edit = tool; } } as unknown as ExtensionAPI);
	const cwd = await mkdtemp(join(tmpdir(), "row-edit-"));
	try {
		const file = join(cwd, "a.txt");
		const script = "[a.txt]\n@REPLACE\n anchor\n \n-old\n+new";
		await writeFile(file, "anchor\nold\n");
		await assert.rejects(edit.execute("1", { text: script }, undefined, undefined, { cwd }));
		assert.equal(await readFile(file, "utf8"), "anchor\nold\n");
		await writeFile(file, "anchor\n\nold\n");
		await edit.execute("2", { text: script }, undefined, undefined, { cwd });
		assert.equal(await readFile(file, "utf8"), "anchor\n\nnew\n");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
