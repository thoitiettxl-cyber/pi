import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
	assertCeiling,
	assertHeldOut,
	assertPhase0,
	canAdmit,
	childToolArgs,
	constraintPreamble,
	editAllowed,
	modelCandidates,
	parseModelRef,
	parseModelConfig,
	resolveOutputRelative,
	shouldSkipDraft,
	shouldTryNextModel,
	type FlightView,
	type Phase0Input,
} from "./subagent-policy.ts";

const phase = (overrides: Partial<Phase0Input> = {}): Phase0Input => ({
	role: "research",
	outcome: "aligned extension",
	metric: "machine checks",
	floor: "6",
	target: "9",
	outputPath: "research.md",
	...overrides,
});

test("general task-only input is accepted", () => {
	assert.doesNotThrow(() => assertPhase0({ role: "general" }));
});

test("research without floor is refused before spawn", () => {
	assert.throws(() => assertPhase0(phase({ floor: "  " })), /floor/);
});

test("research without outputPath is refused", () => {
	assert.throws(() => assertPhase0(phase({ outputPath: undefined })), /outputPath/);
});

test("implement without allowFiles is refused", () => {
	assert.throws(
		() =>
			assertPhase0({
				role: "implement",
				outcome: "o",
				metric: "m",
				floor: "1",
				target: "2",
			}),
		/allowFiles/,
	);
});

test("review without artifactPath is refused", () => {
	assert.throws(
		() =>
			assertPhase0({
				role: "review",
				outcome: "o",
				metric: "m",
				floor: "1",
				target: "2",
				outputPath: "review.md",
			}),
		/artifactPath/,
	);
});

test("unknown role is refused", () => {
	assert.throws(() => assertPhase0({ role: "writer" }), /role/);
});

test("draft implement is a skip, not a spawn", () => {
	assert.equal(shouldSkipDraft("implement", "draft"), true);
	assert.equal(shouldSkipDraft("implement", "finished"), false);
	assert.equal(shouldSkipDraft("research", "draft"), false);
});

test("exclusive admission waits until nothing is in flight", () => {
	const shared: FlightView[] = [{ kind: "shared" }];
	assert.equal(canAdmit([], "exclusive"), true);
	assert.equal(canAdmit(shared, "exclusive"), false);
	assert.equal(canAdmit([{ kind: "exclusive" }], "shared"), false);
});

test("shared admission stops at 3 and does not overlap an exclusive child", () => {
	const three: FlightView[] = [{ kind: "shared" }, { kind: "shared" }, { kind: "shared" }];
	assert.equal(canAdmit(three, "shared"), false);
	assert.equal(canAdmit(three.slice(0, 2), "shared"), true);
});

test("ceiling refuses the next invocation without incrementing past it", () => {
	assert.doesNotThrow(() => assertCeiling(2, 3));
	assert.throws(() => assertCeiling(3, 3), /ceiling/);
	assert.doesNotThrow(() => assertCeiling(99, undefined));
});

test("heldOut refuses a cwd inside the parent directory", () => {
	assert.throws(() => assertHeldOut("/repo", "/repo/pkg", true), /heldOut/);
	assert.doesNotThrow(() => assertHeldOut("/repo", "/tmp/held-out", true));
	assert.doesNotThrow(() => assertHeldOut("/repo", "/repo/pkg", false));
});

test("outputPath rejects absolute paths and parent segments", () => {
	assert.throws(() => resolveOutputRelative("/out", "/etc/passwd"), /relative/);
	assert.throws(() => resolveOutputRelative("/out", "../secret.md"), /\.\./);
	assert.equal(resolveOutputRelative("/out", "notes/a.md"), path.resolve("/out", "notes/a.md"));
});

test("research tools are read-only and implement does not replace the default tool list", () => {
	const research = childToolArgs("research");
	assert.equal(research[research.indexOf("--tools") + 1], "read,grep,find,ls");
	assert.ok(research.includes("--no-extensions"));
	assert.ok(research.includes("--no-mcp"));
	assert.equal(research.includes("--approve"), false);
	assert.equal(childToolArgs("general").length, 0);
	const implement = childToolArgs("implement");
	assert.equal(implement.includes("--tools"), false);
	assert.match(implement[implement.indexOf("--exclude-tools") + 1], /subagent/);
	assert.match(implement[implement.indexOf("--exclude-tools") + 1], /mcp__\*/);
});

test("edit allowlist is an exact canonical match", () => {
	assert.equal(editAllowed("/repo/a.ts", ["/repo/a.ts"]), true);
	assert.equal(editAllowed("/repo/a.ts", ["/repo/b.ts"]), false);
	assert.equal(editAllowed("/repo/a.ts.bak", ["/repo/a.ts"]), false);
});

test("research preamble states the output path and that the child cannot edit", () => {
	const text = constraintPreamble({
		role: "research",
		invocation: 2,
		outcome: "aligned",
		metric: "checks",
		floor: "6",
		target: "9",
		outputPath: "/root/.pi/agent/tmux-subagents/outputs/research.md",
	});
	assert.match(text, /Invocation: 2/);
	assert.match(text, /cannot edit/);
	assert.match(text, /research\.md/);
});

test("symlink output parent is rejected without creating the outside directory", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "subagent-out-"));
	const outside = await mkdtemp(path.join(tmpdir(), "subagent-esc-"));
	await symlink(outside, path.join(root, "link"));
	const { resolveOutputFile } = await import("./subagent-policy.ts");
	await assert.rejects(() => resolveOutputFile(root, "link/new-dir/escaped.md"), /escapes/);
	await assert.rejects(stat(path.join(outside, "new-dir")));
});

test("new file under an allowlisted missing path is not allowed until the parent exists in the list", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "subagent-allow-"));
	const file = path.join(root, "keep.ts");
	await writeFile(file, "x");
	const { canonicalEditPath } = await import("./subagent-policy.ts");
	const canonical = await canonicalEditPath(file, root);
	assert.equal(editAllowed(canonical, [canonical]), true);
	await mkdir(path.join(root, "sub"));
	const created = await canonicalEditPath(path.join(root, "sub", "new.ts"), root);
	assert.equal(editAllowed(created, [canonical]), false);
});

test("parseModelConfig accepts lists, strings, objects and extensions and rejects bad entries", () => {
	assert.deepEqual(
		parseModelConfig({
			extensions: ["~/.pi/agent/git/github.com/thoitiettxl-cyber/pi/src/index.ts"],
			research: ["devin/swe-1-6", "devin/adaptive"],
			review: "devin/adaptive",
			implement: { models: ["devin/fusion-x-high-sidekick-y"], thinking: "high" },
		}),
		{
			roles: {
				research: { models: [{ provider: "devin", model: "swe-1-6" }, { provider: "devin", model: "adaptive" }], thinking: undefined },
				review: { models: [{ provider: "devin", model: "adaptive" }], thinking: undefined },
				implement: { models: [{ provider: "devin", model: "fusion-x-high-sidekick-y" }], thinking: "high" },
			},
			extensions: ["~/.pi/agent/git/github.com/thoitiettxl-cyber/pi/src/index.ts"],
		},
	);
	assert.throws(() => parseModelConfig([]), /object keyed by role/);
	assert.throws(() => parseModelConfig({ planner: ["devin/a"] }), /Unknown subagent role/);
	assert.throws(() => parseModelConfig({ research: [] }), /non-empty list/);
	assert.throws(() => parseModelConfig({ research: ["adaptive"] }), /provider\/model/);
	assert.throws(() => parseModelConfig({ research: { models: ["devin/a"], thinking: "huge" } }), /thinking must be/);
	assert.throws(() => parseModelConfig({ extensions: "a.ts" }), /extensions must be/);
});

test("modelCandidates: explicit wins alone, else role list then parent, deduplicated", () => {
	const parent = { provider: "devin", model: "adaptive" };
	const roleConfig = { models: [{ provider: "devin", model: "swe-1-6" }, { provider: "devin", model: "adaptive" }] };
	assert.deepEqual(modelCandidates({ provider: "openai", model: "gpt" }, roleConfig, parent), [
		{ provider: "openai", model: "gpt", source: "explicit" },
	]);
	assert.deepEqual(modelCandidates(undefined, roleConfig, parent), [
		{ provider: "devin", model: "swe-1-6", source: "role" },
		{ provider: "devin", model: "adaptive", source: "role" },
	]);
	assert.deepEqual(modelCandidates(undefined, undefined, parent), [{ ...parent, source: "parent" }]);
	assert.deepEqual(modelCandidates(undefined, undefined, undefined), []);
});

test("parseModelRef splits provider/model and uses the fallback provider for bare ids", () => {
	assert.deepEqual(parseModelRef("devin/swe-1-6", undefined), { provider: "devin", model: "swe-1-6" });
	assert.deepEqual(parseModelRef("adaptive", "devin"), { provider: "devin", model: "adaptive" });
	assert.equal(parseModelRef("adaptive", undefined), undefined);
});

test("shouldTryNextModel only for auth, plan or model errors before any tool ran", () => {
	assert.equal(shouldTryNextModel({ status: "failed", error: "401 Unauthorized" }), true);
	assert.equal(shouldTryNextModel({ status: "failed", error: "Subscription expired", toolResults: 0 }), true);
	assert.equal(shouldTryNextModel({ status: "failed", error: "model not found: x" }), true);
	assert.equal(shouldTryNextModel({ status: "failed", error: "401 Unauthorized", toolResults: 2 }), false);
	assert.equal(shouldTryNextModel({ status: "failed", error: "Subagent session shut down before the task settled." }), false);
	assert.equal(shouldTryNextModel({ status: "completed", error: "401" }), false);
});
