import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("read --original preserves non-UTF8 bytes", () => {
	const dir = mkdtempSync(join(tmpdir(), "read-binary-"));
	const binary = join(dir, "obscura");
	writeFileSync(binary, '#!/usr/bin/env node\nprocess.stdout.write(Buffer.from([0, 128, 255, 13, 10]));\n', { mode: 0o700 });
	try {
		const result = spawnSync(process.execPath, ["skills/web-browser/scripts/read.js", "https://example.com", "--original"], { env: { ...process.env, OBSCURA_BIN: binary }, timeout: 5000 });
		assert.equal(result.status, 0, result.stderr.toString());
		assert.deepEqual(result.stdout, Buffer.from([0, 128, 255, 13, 10]));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("read respects disabled private-network environment values and explicit opt-in", () => {
	const dir = mkdtempSync(join(tmpdir(), "read-test-"));
	const binary = join(dir, "obscura");
	writeFileSync(binary, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o700 });
	try {
		for (const value of ["", "0", "false", "no", "off", "FALSE", undefined, "1"]) {
			for (const explicit of [false, true]) {
				const env = { ...process.env, OBSCURA_BIN: binary };
				delete env.OBSCURA_ALLOW_PRIVATE_NETWORK;
				if (value !== undefined) env.OBSCURA_ALLOW_PRIVATE_NETWORK = value;
				const result = spawnSync(process.execPath, ["skills/web-browser/scripts/read.js", "https://example.com", "--raw", ...(explicit ? ["--allow-private-network"] : [])], { env, encoding: "utf8", timeout: 5000 });
				assert.equal(result.status, 0, result.stderr);
				assert.equal(JSON.parse(result.stdout).includes("--allow-private-network"), explicit || value === "1", `value=${value}, explicit=${explicit}`);
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
