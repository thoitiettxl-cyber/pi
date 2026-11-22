import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { existsSync } from "node:fs";
import { appendFile, lstat, mkdir, open, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	DefaultPackageManager,
	getAgentDir,
	isToolCallEventType,
	SettingsManager,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
export const ROLES = ["general", "research", "review", "implement"] as const;
export type Role = (typeof ROLES)[number];
export const MAX_SHARED = 3;
export const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

const RESEARCH_EXCLUDE = "edit,write,bash,powershell,subagent,codemode,tool_search,mcp__*";
const IMPLEMENT_EXCLUDE = "subagent,codemode,tool_search,mcp__*,powershell";

export type FlightKind = "exclusive" | "shared";

export interface FlightView {
	kind: FlightKind;
}

export interface Phase0Input {
	role: string;
	outcome?: string;
	metric?: string;
	floor?: string;
	target?: string;
	outputPath?: string;
	allowFiles?: readonly string[];
	artifactPath?: string;
	ceiling?: number;
	heldOut?: boolean;
	researchStatus?: string;
}

export interface PreambleInput {
	role: Role;
	invocation: number;
	outcome: string;
	metric: string;
	floor: string;
	target: string;
	outputPath?: string;
	artifactPath?: string;
	artifactSha256?: string;
	allowFiles?: readonly string[];
}

function filled(value: string | undefined): boolean {
	return Boolean(value?.trim());
}

export function normalizeRole(role: string): Role {
	const trimmed = role.trim();
	if (trimmed === "general" || trimmed === "research" || trimmed === "review" || trimmed === "implement") {
		return trimmed;
	}
	throw new Error(`Unknown subagent role: ${role}. Use general, research, review, or implement.`);
}

export function assertPhase0(input: Phase0Input): Role {
	const role = normalizeRole(input.role);
	if (role === "general") return role;
	const missing = (["outcome", "metric", "floor", "target"] as const).filter((key) => !filled(input[key]));
	if (missing.length > 0) {
		throw new Error(`subagent role ${role} requires ${missing.join(", ")} before spawn.`);
	}
	if ((role === "research" || role === "review") && !filled(input.outputPath)) {
		throw new Error(`subagent role ${role} requires outputPath before spawn.`);
	}
	if (role === "implement" && !input.allowFiles?.some((file) => file.trim())) {
		throw new Error("subagent role implement requires allowFiles before spawn.");
	}
	if (role === "review" && !filled(input.artifactPath)) {
		throw new Error("subagent role review requires artifactPath before spawn.");
	}
	if (input.ceiling !== undefined && (!Number.isInteger(input.ceiling) || input.ceiling < 1)) {
		throw new Error("subagent ceiling must be a positive integer.");
	}
	return role;
}

export function shouldSkipDraft(role: Role, researchStatus: string | undefined): boolean {
	return role === "implement" && researchStatus === "draft";
}

export function flightKind(role: Role): FlightKind {
	return role === "research" || role === "review" ? "shared" : "exclusive";
}

export function canAdmit(flights: readonly FlightView[], kind: FlightKind, maxShared = MAX_SHARED): boolean {
	if (kind === "exclusive") return flights.length === 0;
	if (flights.some((flight) => flight.kind === "exclusive")) return false;
	return flights.filter((flight) => flight.kind === "shared").length < maxShared;
}

export function assertCeiling(count: number, ceiling: number | undefined): void {
	if (ceiling === undefined) return;
	if (!Number.isInteger(ceiling) || ceiling < 1) {
		throw new Error("subagent ceiling must be a positive integer.");
	}
	if (count + 1 > ceiling) {
		throw new Error(`Spend ceiling ${ceiling} exceeded; refused invocation ${count + 1}.`);
	}
}

export function isSameOrDescendant(base: string, candidate: string): boolean {
	const relative = path.relative(base, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function assertHeldOut(parentCwd: string, childCwd: string, heldOut: boolean | undefined): void {
	if (!heldOut) return;
	if (isSameOrDescendant(path.resolve(parentCwd), path.resolve(childCwd))) {
		throw new Error("heldOut requires a cwd outside the parent working directory.");
	}
}

export function resolveOutputRelative(outputRoot: string, requested: string): string {
	const trimmed = requested.trim();
	if (!trimmed) throw new Error("outputPath must not be empty.");
	if (path.isAbsolute(trimmed)) {
		throw new Error("outputPath must be relative to the subagent outputs directory.");
	}
	if (trimmed.split(/[\\/]/).some((part) => part === "..")) {
		throw new Error("outputPath must not contain ..");
	}
	const full = path.resolve(outputRoot, trimmed);
	if (!isSameOrDescendant(path.resolve(outputRoot), full)) {
		throw new Error("outputPath escapes the subagent outputs directory.");
	}
	return full;
}

export async function resolveOutputFile(outputRoot: string, requested: string): Promise<string> {
	await mkdir(outputRoot, { recursive: true, mode: 0o700 });
	const lexical = resolveOutputRelative(outputRoot, requested);
	const rootReal = await realpath(outputRoot);
	const relative = path.relative(path.resolve(outputRoot), lexical);
	const parts = relative.split(path.sep);
	const fileName = parts.pop();
	if (!fileName || fileName === "." || fileName === "..") {
		throw new Error("outputPath must name a file.");
	}
	let cursor = rootReal;
	for (const part of parts) {
		cursor = path.join(cursor, part);
		try {
			const info = await lstat(cursor);
			if (info.isSymbolicLink()) throw new Error("outputPath parent escapes the subagent outputs directory.");
			if (!info.isDirectory()) throw new Error("outputPath parent is not a directory.");
		} catch (error) {
			if (error instanceof Error && /escapes|not a directory/.test(error.message)) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await mkdir(cursor, { mode: 0o700 });
		}
	}
	const parentReal = await realpath(cursor);
	if (!isSameOrDescendant(rootReal, parentReal)) {
		throw new Error("outputPath parent escapes the subagent outputs directory.");
	}
	return path.join(parentReal, fileName);
}

export function childToolArgs(role: Role): string[] {
	if (role === "general") return [];
	if (role === "research" || role === "review") {
		return [
			"--no-extensions",
			"--no-mcp",
			"--no-context-files",
			"--no-skills",
			"--tools",
			READ_ONLY_TOOL_NAMES.join(","),
			"--exclude-tools",
			RESEARCH_EXCLUDE,
		];
	}
	return ["--no-extensions", "--no-mcp", "--exclude-tools", IMPLEMENT_EXCLUDE];
}

export function editAllowed(canonical: string, allowCanonical: readonly string[]): boolean {
	return allowCanonical.includes(canonical);
}

export async function canonicalEditPath(filePath: string, cwd: string): Promise<string> {
	const absolute = path.resolve(cwd, filePath);
	try {
		return await realpath(absolute);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") throw error;
		const parent = await realpath(path.dirname(absolute));
		return path.join(parent, path.basename(absolute));
	}
}

export function constraintPreamble(input: PreambleInput): string {
	const lines = [
		"# Subagent constraints",
		"",
		`Role: ${input.role}`,
		`Invocation: ${input.invocation}`,
		`Outcome: ${input.outcome}`,
		`Metric: ${input.metric}`,
		`Floor: ${input.floor}`,
		`Target: ${input.target}`,
	];
	if (input.role === "research" || input.role === "review") {
		lines.push(
			`Output file (parent writes this; you cannot edit): ${input.outputPath ?? ""}`,
			"Tools: read, grep, find, ls only. edit, write, bash, powershell, and subagent are not available.",
			"Do not edit the repo. Return the report as your final text.",
		);
	}
	if (input.role === "implement") {
		lines.push(
			`allowFiles: ${(input.allowFiles ?? []).join(", ")}`,
			"edit and write outside allowFiles are blocked.",
			"Residual [NEEDS-MEASUREMENT]: bash is not path-restricted.",
		);
	}
	if (input.artifactPath) {
		lines.push(`Artifact: ${input.artifactPath}`, `Artifact-SHA256: ${input.artifactSha256 ?? ""}`);
	}
	lines.push("");
	return lines.join("\n");
}

export const ROLE_MODELS_FILE = "subagent-models.json";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelRef {
	provider: string;
	model: string;
}

export interface RoleModelConfig {
	models: ModelRef[];
	thinking?: ThinkingLevel;
}

export type RoleModels = Partial<Record<Role, RoleModelConfig>>;

export interface SubagentModelConfig {
	roles: RoleModels;
	/** Tried after the parent model, so a child still starts when the parent's account is unusable. */
	fallback: ModelRef[];
}

export interface ModelCandidate extends ModelRef {
	source: "explicit" | "role" | "parent" | "fallback";
}

/** Split "provider/model"; a bare id takes the fallback provider. */
export function parseModelRef(value: string, fallbackProvider: string | undefined): ModelRef | undefined {
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");
	if (slash > 0) return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
	if (!trimmed || !fallbackProvider) return undefined;
	return { provider: fallbackProvider, model: trimmed };
}

/** Validate the role model file (trust boundary: user-edited JSON). */
export function parseModelConfig(raw: unknown): SubagentModelConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`${ROLE_MODELS_FILE} must be an object keyed by role.`);
	}
	const result: RoleModels = {};
	let fallback: ModelRef[] = [];
	for (const [key, value] of Object.entries(raw)) {
		if (key === "fallback") {
			fallback = parseModelList(value, "fallback");
			continue;
		}
		const role = normalizeRole(key);
		const entry = Array.isArray(value) || typeof value === "string" ? { models: value } : value;
		if (!entry || typeof entry !== "object") throw new Error(`${ROLE_MODELS_FILE}: ${role} must be a list or object.`);
		const { models, thinking } = entry as { models?: unknown; thinking?: unknown };
		const refs = parseModelList(models, `${role}.models`);
		if (thinking !== undefined && !THINKING_LEVELS.includes(thinking as ThinkingLevel)) {
			throw new Error(`${ROLE_MODELS_FILE}: ${role}.thinking must be one of ${THINKING_LEVELS.join(", ")}.`);
		}
		result[role] = { models: refs, thinking: thinking as ThinkingLevel | undefined };
	}
	return { roles: result, fallback };
}

function parseModelList(value: unknown, label: string): ModelRef[] {
	const list = typeof value === "string" ? [value] : value;
	if (!Array.isArray(list) || list.length === 0 || list.some((item) => typeof item !== "string")) {
		throw new Error(`${ROLE_MODELS_FILE}: ${label} must be a non-empty list of "provider/model" strings.`);
	}
	return list.map((item: string) => {
		const ref = parseModelRef(item, undefined);
		if (!ref) throw new Error(`${ROLE_MODELS_FILE}: ${label} model "${item}" must be "provider/model".`);
		return ref;
	});
}

const DEVIN_READER = "devin/adaptive";
const DEVIN_FALLBACKS = ["devin/adaptive", "devin/swe-1-6"];
const MAX_GENERATED_FALLBACKS = 4;

/**
 * Defaults written when the model file is missing: research and review read with Devin's router,
 * and the fallback list holds the user's scoped models (settings enabledModels) plus Devin's
 * general models, limited to models that are in the catalog with auth.
 */
export function defaultModelFile(available: readonly string[], enabledModels: readonly string[] | undefined): Record<string, string[]> {
	const usable = new Set(available);
	const file: Record<string, string[]> = {};
	if (usable.has(DEVIN_READER)) {
		file.research = [DEVIN_READER];
		file.review = [DEVIN_READER];
	}
	// enabledModels entries may carry a ":thinking" suffix or be globs; only exact ids are kept.
	const scoped = (enabledModels ?? []).map((entry) => entry.trim().replace(/:[a-z]+$/, ""));
	const fallback = [...new Set([...scoped, ...DEVIN_FALLBACKS])].filter((id) => usable.has(id));
	if (fallback.length > 0) file.fallback = fallback.slice(0, MAX_GENERATED_FALLBACKS);
	return file;
}

/** Ordered models to try: an explicit override alone, else the role list, the parent model, then the fallback list. */
export function modelCandidates(
	explicit: ModelRef | undefined,
	roleConfig: RoleModelConfig | undefined,
	parent: ModelRef | undefined,
	fallback: readonly ModelRef[] = [],
): ModelCandidate[] {
	if (explicit) return [{ ...explicit, source: "explicit" }];
	const all: ModelCandidate[] = [
		...(roleConfig?.models ?? []).map((ref) => ({ ...ref, source: "role" as const })),
		...(parent ? [{ ...parent, source: "parent" as const }] : []),
		...fallback.map((ref) => ({ ...ref, source: "fallback" as const })),
	];
	const seen = new Set<string>();
	return all.filter((candidate) => {
		const key = `${candidate.provider}/${candidate.model}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

const UNAVAILABLE_PATTERN =
	/\b(401|402|403|404)\b|unauthori[sz]ed|unauthenticated|forbidden|permission denied|expired|billing|payment|quota|insufficient|credit|subscription|no api key|api key|not found|not available|unavailable model|unsupported model|invalid model|does not exist|access denied/i;

/** A child that failed before running any tool, with an auth/plan/model error, may retry on the next model. */
export function shouldTryNextModel(result: { status: string; error?: string; toolResults?: number }): boolean {
	if (result.status !== "failed" || (result.toolResults ?? 0) > 0) return false;
	return UNAVAILABLE_PATTERN.test(result.error ?? "");
}

/** True when an extension file registers a model provider, so children must load it to reach that provider. */
export function registersProvider(source: string): boolean {
	return /\.register(Native)?Provider\s*\(/.test(source);
}

const ATTACH_FLAG = "attach-subagent";
const CHILD_ENV = "PI_TMUX_SUBAGENT_CHILD";
const RESULT_ENV = "PI_TMUX_SUBAGENT_RESULT";
const ROLE_ENV = "PI_TMUX_SUBAGENT_ROLE";
const ALLOW_ENV = "PI_TMUX_SUBAGENT_ALLOW_FILES";
const RUNS_DIR = "tmux-subagents";
const OUTPUTS_DIR = "outputs";
const LEDGER_FILE = "ledger.jsonl";
const POLL_INTERVAL_MS = 500;
const PANE_DEAD_POLLS = 4;
const PANE_PREVIEW_LINES = 18;
const RESEARCH_STATUSES = ["draft", "finished"] as const;
const IMPLEMENT_RESIDUAL = "bash is not path-restricted; allowFiles blocks edit and write only.";
const EXTENSION_PATH = fileURLToPath(import.meta.url);

type RunStatus = "queued" | "running" | "completed" | "failed";

interface ChildResult {
	version: 1;
	status: "completed" | "failed";
	output: string;
	error?: string;
	stopReason?: string;
	sessionFile?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	toolResults?: number;
	finishedAt: number;
}

interface RunDetails {
	status: RunStatus;
	task: string;
	cwd: string;
	tmuxSession: string;
	attachCommand: string;
	captureCommand: string;
	killCommand: string;
	provider: string;
	model: string;
	thinking: string;
	role?: Role;
	invocation?: number;
	outputFile?: string;
	residual?: string;
	fallbacks?: string[];
	pane?: string;
	output?: string;
	sessionFile?: string;
	startedAt?: number;
	finishedAt?: number;
}

interface Flight {
	id: string;
	kind: FlightKind;
	invocation: number;
	tmuxSession?: string;
}

interface RunSpec {
	task: string;
	cwd: string;
	attachmentId: string;
	tmuxSession: string;
	tmuxTarget: string;
	attachCommand: string;
	captureCommand: string;
	killCommand: string;
	provider: string;
	model: string;
	thinking: string;
	trusted: boolean;
}

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function tmuxSocketPath(): string {
	return path.join(getAgentDir(), "tmux-subagents.sock");
}

function tmuxSessionName(sessionId: string): string {
	return `pi-agent-${sessionId}`;
}

function currentTmuxSocket(): string | undefined {
	const socket = process.env.TMUX?.split(",", 1)[0]?.trim();
	return socket || undefined;
}

function attachFlagValue(argv: string[]): string | undefined {
	const flag = `--${ATTACH_FLAG}`;
	for (let index = 2; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--") break;
		if (argument === flag) {
			const value = argv[index + 1];
			return !value || value.startsWith("--") ? "" : value;
		}
		if (argument.startsWith(`${flag}=`)) return argument.slice(flag.length + 1);
	}
	return undefined;
}

function tmuxCommandPrefix(): string {
	return `tmux -S ${shellQuote(tmuxSocketPath())}`;
}

function tmuxArgs(...args: string[]): string[] {
	return ["-S", tmuxSocketPath(), ...args];
}

function updateTmuxCommands(spec: RunSpec): void {
	const tmux = tmuxCommandPrefix();
	spec.attachCommand = `pi --${ATTACH_FLAG} ${shellQuote(spec.attachmentId)}`;
	spec.captureCommand = `${tmux} capture-pane -p -J -t ${shellQuote(spec.tmuxTarget)}`;
	spec.killCommand = `${tmux} kill-session -t ${shellQuote(spec.tmuxSession)}`;
}

function attachToSubagentAndExit(rawTarget: string): never {
	const target = rawTarget.trim();
	if (!target) {
		console.error(`Error: --${ATTACH_FLAG} requires the session id printed by the subagent tool.`);
		process.exit(2);
	}

	let socket = tmuxSocketPath();
	let session: string;
	if (target.startsWith("v1.")) {
		// Keep attachment working for sessions started before session-id targets.
		try {
			const legacy = JSON.parse(Buffer.from(target.slice(3), "base64url").toString("utf8")) as {
				s?: unknown;
				p?: unknown;
			};
			if (typeof legacy.s !== "string" || !legacy.s || typeof legacy.p !== "string" || !legacy.p) {
				throw new Error("missing tmux session or socket");
			}
			session = legacy.s;
			socket = legacy.p;
		} catch (error) {
			console.error(`Error: invalid legacy subagent target: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(2);
		}
	} else {
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(target)) {
			console.error(`Error: invalid subagent session id: ${target}`);
			process.exit(2);
		}
		session = tmuxSessionName(target);
	}

	const sameServer = currentTmuxSocket() === socket;
	const args = ["-S", socket, sameServer ? "switch-client" : "attach-session", "-t", session];
	const env = { ...process.env };
	if (!sameServer) {
		delete env.TMUX;
		delete env.TMUX_PANE;
	}
	const result = spawnSync("tmux", args, { stdio: "inherit", env });
	if (result.error) console.error(`Failed to run tmux: ${result.error.message}`);
	process.exit(result.status ?? 1);
}

function getPiInvocationParts(): string[] {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return [process.execPath, currentScript];
	}

	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return [process.execPath];
	}

	return ["pi"];
}

function textFromAssistant(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			return Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string");
		})
		.map((part) => part.text)
		.join("\n");
}

function findLastAssistant(ctx: ExtensionContext): Record<string, unknown> | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const message = entry.message as unknown as Record<string, unknown>;
		if (message.role === "assistant") return message;
	}
	return undefined;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporaryPath, filePath);
}

function registerChildReporter(pi: ExtensionAPI, resultPath: string): void {
	let reported = false;

	const report = async (ctx: ExtensionContext, fallbackError?: string): Promise<void> => {
		if (reported) return;
		reported = true;

		const assistant = findLastAssistant(ctx);
		const stopReason = typeof assistant?.stopReason === "string" ? assistant.stopReason : undefined;
		const assistantError = typeof assistant?.errorMessage === "string" ? assistant.errorMessage : undefined;
		const failed = !assistant || stopReason === "error" || stopReason === "aborted" || Boolean(fallbackError);
		const output = assistant ? textFromAssistant(assistant) : "";
		const result: ChildResult = {
			version: 1,
			status: failed ? "failed" : "completed",
			output,
			error: fallbackError ?? assistantError ?? (!assistant ? "Subagent exited without an assistant response." : undefined),
			stopReason,
			sessionFile: ctx.sessionManager.getSessionFile(),
			provider: typeof assistant?.provider === "string" ? assistant.provider : ctx.model?.provider,
			model: typeof assistant?.model === "string" ? assistant.model : ctx.model?.id,
			thinking: pi.getThinkingLevel(),
			toolResults: ctx.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "toolResult").length,
			finishedAt: Date.now(),
		};

		try {
			await writeJsonAtomic(resultPath, result);
		} catch (error) {
			console.error(`[tmux-subagent] Failed to write result: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	// agent_settled was added after older peer type declarations but is present
	// in the Pi runtime this extension targets.
	(
		pi.on as unknown as (
			event: "agent_settled",
			handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
		) => void
	)("agent_settled", async (_event, ctx) => {
		await report(ctx);
		ctx.shutdown();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!reported) await report(ctx, "Subagent session shut down before the task settled.");
	});
}

function parseAllowFiles(raw: string | undefined): string[] {
	if (!raw) return [];
	const parsed = JSON.parse(raw) as unknown;
	if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
		throw new Error(`${ALLOW_ENV} must be a JSON string array.`);
	}
	return parsed;
}

function registerChildGuard(pi: ExtensionAPI): void {
	const role = process.env[ROLE_ENV];
	if (role !== "research" && role !== "review" && role !== "implement") return;
	const allowRaw = role === "implement" ? parseAllowFiles(process.env[ALLOW_ENV]) : [];
	const readOnly = new Set<string>(READ_ONLY_TOOL_NAMES);

	pi.on("tool_call", async (event) => {
		if (role === "research" || role === "review") {
			if (!readOnly.has(event.toolName)) {
				return {
					block: true,
					reason: `Role ${role} cannot call ${event.toolName}.`,
					terminate: true,
				};
			}
			return;
		}
		const targetPath = isToolCallEventType("edit", event)
			? event.input.path
			: isToolCallEventType("write", event)
				? event.input.path
				: undefined;
		if (!targetPath) return;
		try {
			const target = await canonicalEditPath(targetPath, process.cwd());
			const allowed = await Promise.all(allowRaw.map((file) => canonicalEditPath(file, process.cwd())));
			if (!editAllowed(target, allowed)) {
				return { block: true, reason: `implement allowFiles does not include ${targetPath}.` };
			}
		} catch (error) {
			return {
				block: true,
				reason: `implement allowFiles check failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	});
}

function outputsRoot(): string {
	return path.join(getAgentDir(), RUNS_DIR, OUTPUTS_DIR);
}

function ledgerPath(): string {
	return path.join(getAgentDir(), RUNS_DIR, LEDGER_FILE);
}

async function appendLedger(record: Record<string, unknown>): Promise<void> {
	const file = ledgerPath();
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { encoding: "utf8", mode: 0o600 });
}

async function writeExclusive(filePath: string, content: string): Promise<void> {
	const handle = await open(
		filePath,
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		await handle.writeFile(content, "utf8");
	} finally {
		await handle.close();
	}
}

function trimPane(output: string): string {
	const lines = output.replace(/\r/g, "").split("\n");
	while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
	while (lines.length > 0 && !lines[lines.length - 1]?.trim()) lines.pop();
	return lines.slice(-PANE_PREVIEW_LINES).join("\n");
}

function formatDuration(startedAt: number | undefined, finishedAt = Date.now()): string | undefined {
	if (startedAt === undefined) return undefined;
	const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function detailsFor(spec: RunSpec, status: RunStatus, extra: Partial<RunDetails> = {}): RunDetails {
	return {
		status,
		task: spec.task,
		cwd: spec.cwd,
		tmuxSession: spec.tmuxSession,
		attachCommand: spec.attachCommand,
		captureCommand: spec.captureCommand,
		killCommand: spec.killCommand,
		provider: spec.provider,
		model: spec.model,
		thinking: spec.thinking,
		...extra,
	};
}

function partialText(details: RunDetails): string {
	const lines = [
		`Subagent ${details.status} in tmux session ${details.tmuxSession}.`,
		`Attach: ${details.attachCommand}`,
		`Capture: ${details.captureCommand}`,
	];
	if (details.pane) lines.push("", details.pane);
	return lines.join("\n");
}

function truncateToolText(text: string): string {
	const truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncated.truncated) return truncated.content;
	return `${truncated.content}\n\n[Output truncated. Full output is available in the child session file.]`;
}

function resultText(details: RunDetails): string {
	const duration = formatDuration(details.startedAt, details.finishedAt);
	const lines = [
		`Subagent ${details.status}${duration ? ` after ${duration}` : ""}.`,
		`Model: ${details.provider}/${details.model} (${details.thinking})`,
	];
	if (details.role) lines.push(`Role: ${details.role}`);
	for (const fallback of details.fallbacks ?? []) lines.push(`Model fallback: ${fallback}`);
	if (details.invocation !== undefined) lines.push(`Invocation: ${details.invocation}`);
	lines.push(
		`tmux: ${details.tmuxSession}`,
		`Attach: ${details.attachCommand}`,
		`Capture: ${details.captureCommand}`,
		`Clean up: ${details.killCommand}`,
	);
	if (details.outputFile) lines.push(`Output file: ${details.outputFile}`);
	if (details.residual) lines.push(`Residual: ${details.residual}`);
	if (details.sessionFile) lines.push(`Child session: ${details.sessionFile}`);
	if (details.output) lines.push("", details.output);
	return truncateToolText(lines.join("\n"));
}

async function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) throw new Error("Subagent aborted.");
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			reject(new Error("Subagent aborted."));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function validateCwd(cwd: string): Promise<void> {
	let info;
	try {
		info = await stat(cwd);
	} catch {
		throw new Error(`Subagent working directory does not exist: ${cwd}`);
	}
	if (!info.isDirectory()) throw new Error(`Subagent working directory is not a directory: ${cwd}`);
}

/** Read the model file, writing defaults from the usable models when it does not exist yet. */
async function loadModelConfig(ctx: ExtensionContext): Promise<{ config: SubagentModelConfig; created?: string }> {
	const file = path.join(getAgentDir(), ROLE_MODELS_FILE);
	let text: string;
	let created: string | undefined;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const available = ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`);
		const enabled = SettingsManager.create(ctx.cwd).getEnabledModels();
		text = `${JSON.stringify(defaultModelFile(available, enabled), null, 2)}\n`;
		await writeFile(file, text, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch((writeError: NodeJS.ErrnoException) => {
			if (writeError.code !== "EEXIST") throw writeError;
		});
		created = file;
	}
	try {
		return { config: parseModelConfig(JSON.parse(text)), created };
	} catch (error) {
		throw new Error(`Invalid ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

const OWN_PACKAGE_ROOT = path.dirname(path.dirname(EXTENSION_PATH));

/**
 * Extensions that register providers, from the same packages and settings the parent loaded.
 * Research, review and implement children start with --no-extensions; without these they
 * cannot reach a provider that comes from a package (for example Devin).
 */
async function providerExtensions(ctx: ExtensionContext): Promise<string[]> {
	const settingsManager = SettingsManager.create(ctx.cwd);
	const packages = new DefaultPackageManager({ cwd: ctx.cwd, agentDir: getAgentDir(), settingsManager, commandOutput: "capture" });
	const resolved = await packages.resolve(async () => "skip");
	const ownRoot = await realpath(OWN_PACKAGE_ROOT).catch(() => OWN_PACKAGE_ROOT);
	const found: string[] = [];
	for (const resource of resolved.extensions) {
		if (!resource.enabled || resource.path === EXTENSION_PATH) continue;
		const real = await realpath(resource.path).catch(() => resource.path);
		if (isSameOrDescendant(ownRoot, real)) continue;
		const source = await readFile(real, "utf8").catch(() => "");
		if (registersProvider(source)) found.push(real);
	}
	return found;
}

function resolveModel(
	ctx: ExtensionContext,
	providerOverride: string | undefined,
	modelOverride: string | undefined,
): { provider: string; model: string } {
	const explicitProvider = providerOverride?.trim();
	const explicitModel = modelOverride?.trim();
	let provider = explicitProvider || ctx.model?.provider || "";
	let model = explicitModel || ctx.model?.id || "";

	// A slash in an inherited id can be part of the id itself (for example,
	// OpenRouter's openai/gpt-* models). Only interpret an explicit model as
	// provider/model when no separate provider was supplied. If both are given
	// and the prefixes agree, accept the redundant canonical provider/model form.
	const slashIndex = explicitModel?.indexOf("/") ?? -1;
	if (explicitModel && slashIndex > 0) {
		const modelProvider = explicitModel.slice(0, slashIndex);
		if (!explicitProvider) {
			provider = modelProvider;
			model = explicitModel.slice(slashIndex + 1);
		} else if (explicitProvider === modelProvider) {
			model = explicitModel.slice(slashIndex + 1);
		}
	}

	if (!provider || !model) {
		throw new Error("No model is active. Pass both provider and model to the subagent tool.");
	}
	return { provider, model };
}

export default function subagentExtension(pi: ExtensionAPI): void {
	pi.registerFlag(ATTACH_FLAG, {
		description: "Attach using the child session id printed by the subagent tool",
		type: "string",
	});
	const attachTarget = attachFlagValue(process.argv);
	if (attachTarget !== undefined) attachToSubagentAndExit(attachTarget);

	if (process.env[CHILD_ENV] === "1") {
		const resultPath = process.env[RESULT_ENV];
		if (!resultPath) {
			console.error(`[tmux-subagent] ${RESULT_ENV} is required in child mode.`);
			return;
		}
		registerChildGuard(pi);
		registerChildReporter(pi, resultPath);
		return;
	}

	const flights = new Map<string, Flight>();
	let invocationCount = 0;
	let admitChain: Promise<void> = Promise.resolve();
	let capacityWaiters: Array<() => void> = [];

	const withAdmitLock = <T>(fn: () => T): Promise<T> => {
		const previous = admitChain;
		let release!: () => void;
		admitChain = new Promise<void>((resolve) => {
			release = resolve;
		});
		return previous.then(() => {
			try {
				return fn();
			} finally {
				release();
			}
		});
	};

	const notifyCapacity = (): void => {
		const waiters = capacityWaiters;
		capacityWaiters = [];
		for (const wake of waiters) wake();
	};

	const registerWaiter = (signal: AbortSignal | undefined): Promise<void> => {
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				capacityWaiters = capacityWaiters.filter((waiter) => waiter !== wake);
				reject(new Error("Subagent aborted while waiting for a slot."));
			};
			const wake = () => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			if (signal?.aborted) {
				reject(new Error("Subagent aborted while waiting for a slot."));
				return;
			}
			capacityWaiters.push(wake);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	};

	const admit = async (
		kind: FlightKind,
		ceiling: number | undefined,
		signal: AbortSignal | undefined,
		onWait: () => void,
	): Promise<Flight> => {
		const flight: Flight = { id: randomUUID(), kind, invocation: 0 };
		for (;;) {
			if (signal?.aborted) throw new Error("Subagent aborted while waiting for a slot.");
			const ticket = await withAdmitLock(() => {
				if (!canAdmit([...flights.values()], kind, MAX_SHARED)) {
					return { admitted: false as const, ready: registerWaiter(signal) };
				}
				assertCeiling(invocationCount, ceiling);
				invocationCount += 1;
				flight.invocation = invocationCount;
				flights.set(flight.id, flight);
				return { admitted: true as const };
			});
			if (ticket.admitted) return flight;
			onWait();
			await ticket.ready;
		}
	};

	const releaseFlight = async (id: string): Promise<void> => {
		await withAdmitLock(() => {
			flights.delete(id);
		});
		notifyCapacity();
	};

	const reap = async (session: string): Promise<boolean> => {
		await pi.exec("tmux", tmuxArgs("kill-session", "-t", session));
		const has = await pi.exec("tmux", tmuxArgs("has-session", "-t", session));
		return has.code !== 0;
	};

	pi.on("session_shutdown", async () => {
		const sessions = [...flights.values()]
			.map((flight) => flight.tmuxSession)
			.filter((session): session is string => Boolean(session));
		for (const session of sessions) {
			await pi.exec("tmux", tmuxArgs("kill-session", "-t", session));
		}
		await withAdmitLock(() => {
			flights.clear();
		});
		notifyCapacity();
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Run one delegated task in a separate interactive Pi process inside tmux. general (the default) and implement are exclusive. research and review share a cap of 3 and do not overlap an exclusive child. Pass role to require outcome, metric, floor, and target. The child inherits the current provider, model, and thinking level unless overridden. Live pane output and a copy/paste pi --attach-subagent command are shown while it runs. Output is capped at 50KB or 2000 lines; the complete child session is preserved on disk.",
		promptSnippet: "Run one delegated task in an observable, tmux-backed Pi session",
		promptGuidelines: [
			"Use subagent once per delegated task. Do not ask a subagent to call subagent.",
			"subagent role general is the default and accepts task alone. It stays exclusive, one child at a time.",
			"When subagent role is research, review, or implement, pass outcome, metric, floor, and target. research and review also require outputPath. implement also requires allowFiles. review also requires artifactPath.",
			"subagent research and review are read-only (read, grep, find, ls) and may run 3 at a time. The parent writes their output file; they cannot edit the repo.",
			"subagent implement is the one writer. It edits only allowFiles. Pass researchStatus draft to skip the spawn and record the reason.",
			"Pass subagent heldOut true only with a cwd outside the parent directory. Pass ceiling to refuse an invocation past that number. subagent records the invocation before spawn.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The complete task for the child Pi process" }),
			cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current project." })),
			provider: Type.Optional(Type.String({ description: "Provider override. Defaults to the current provider." })),
			model: Type.Optional(
				Type.String({ description: "Model id or provider/model override. Defaults to the current model." }),
			),
			thinking: Type.Optional(
				StringEnum(THINKING_LEVELS, {
					description: "Thinking level override. Defaults to the current thinking level.",
				}),
			),
			role: Type.Optional(
				StringEnum(ROLES, {
					description: "general (default), research, review, or implement. Omit for a task-only exclusive call.",
				}),
			),
			outcome: Type.Optional(Type.String({ description: "Required when role is research, review, or implement." })),
			metric: Type.Optional(Type.String({ description: "Required when role is research, review, or implement." })),
			floor: Type.Optional(
				Type.String({ description: "Required when role is research, review, or implement. Only the floor decides pass/fail." }),
			),
			target: Type.Optional(Type.String({ description: "Required when role is research, review, or implement." })),
			outputPath: Type.Optional(
				Type.String({
					description: "Relative path under the subagent outputs directory. Required for research and review.",
				}),
			),
			allowFiles: Type.Optional(
				Type.Array(Type.String(), { description: "Exact files implement may edit or write. Required for implement." }),
			),
			artifactPath: Type.Optional(
				Type.String({ description: "Existing file the review child must see. Required for review." }),
			),
			ceiling: Type.Optional(Type.Integer({ minimum: 1, description: "Refuse when the next invocation would exceed this count." })),
			heldOut: Type.Optional(Type.Boolean({ description: "Require cwd outside the parent directory." })),
			researchStatus: Type.Optional(
				StringEnum(RESEARCH_STATUSES, {
					description: "implement with draft skips the spawn and records the reason.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.task.trim()) throw new Error("Subagent task must not be empty.");
			const role = assertPhase0({
				role: params.role ?? "general",
				outcome: params.outcome,
				metric: params.metric,
				floor: params.floor,
				target: params.target,
				outputPath: params.outputPath,
				allowFiles: params.allowFiles,
				artifactPath: params.artifactPath,
				ceiling: params.ceiling,
				heldOut: params.heldOut,
				researchStatus: params.researchStatus,
			});
			const cwd = path.resolve(ctx.cwd, params.cwd?.trim() || ".");
			await validateCwd(cwd);
			assertHeldOut(path.resolve(ctx.cwd), cwd, params.heldOut);
			if (shouldSkipDraft(role, params.researchStatus)) {
				await appendLedger({ action: "skip-draft", role, reason: "researchStatus is draft" });
				const text =
					"Skipped implement spawn: researchStatus is draft. Recorded in the subagent ledger. No child was started.";
				return {
					content: [{ type: "text", text }],
					details: detailsFor(
						{
							task: params.task,
							cwd,
							attachmentId: "",
							tmuxSession: "(not started)",
							tmuxTarget: "",
							attachCommand: "",
							captureCommand: "",
							killCommand: "",
							provider: ctx.model?.provider ?? "",
							model: ctx.model?.id ?? "",
							thinking: params.thinking ?? "",
							trusted: false,
						},
						"completed",
						{ role },
					),
				};
			}

			const { config: modelConfig, created: createdModelFile } = await loadModelConfig(ctx);
			const roleConfig = modelConfig.roles[role];
			const childExtensions = role === "general" ? [] : await providerExtensions(ctx);
			const explicit =
				params.provider?.trim() || params.model?.trim() ? resolveModel(ctx, params.provider, params.model) : undefined;
			const parent: ModelRef | undefined = ctx.model ? { provider: ctx.model.provider, model: ctx.model.id } : undefined;
			const fallbacks: string[] = [];
			if (createdModelFile) fallbacks.push(`created ${createdModelFile} with defaults; edit it to change per-role models`);
			const candidates = modelCandidates(explicit, roleConfig, parent, modelConfig.fallback).filter((candidate) => {
				if (candidate.source === "explicit" || candidate.source === "parent") return true;
				const label = `${candidate.provider}/${candidate.model}`;
				const known = ctx.modelRegistry.find(candidate.provider, candidate.model);
				if (!known) {
					fallbacks.push(`${label} skipped: not in the model catalog`);
					return false;
				}
				if (!ctx.modelRegistry.hasConfiguredAuth(known)) {
					fallbacks.push(`${label} skipped: no login or API key for ${candidate.provider}`);
					return false;
				}
				return true;
			});
			if (candidates.length === 0) {
				throw new Error(
					["No usable model. Pass both provider and model to the subagent tool.", ...fallbacks].join("\n"),
				);
			}
			const thinkingFor = (candidate: ModelCandidate): string =>
				params.thinking ?? (candidate.source === "role" ? roleConfig?.thinking : undefined) ?? pi.getThinkingLevel();
			const newSpec = (candidate: ModelCandidate): RunSpec => {
				const childSessionId = randomUUID();
				const tmuxSession = tmuxSessionName(childSessionId);
				const spec: RunSpec = {
					task: params.task,
					cwd,
					attachmentId: childSessionId,
					tmuxSession,
					tmuxTarget: `${tmuxSession}:0.0`,
					attachCommand: "",
					captureCommand: "",
					killCommand: "",
					provider: candidate.provider,
					model: candidate.model,
					thinking: thinkingFor(candidate),
					trusted: isSameOrDescendant(path.resolve(ctx.cwd), cwd) && ctx.isProjectTrusted(),
				};
				updateTmuxCommands(spec);
				return spec;
			};

			let artifactSha256: string | undefined;
			if (role === "review") {
				const artifact = path.resolve(cwd, params.artifactPath ?? "");
				const info = await stat(artifact);
				if (!info.isFile()) throw new Error(`artifactPath is not a file: ${artifact}`);
				artifactSha256 = createHash("sha256").update(await readFile(artifact)).digest("hex");
			}

			let outputFile: string | undefined;
			if (role === "research" || role === "review") {
				outputFile = await resolveOutputFile(outputsRoot(), params.outputPath ?? "");
			}

			let spec = newSpec(candidates[0]);
			let flight: Flight;
			try {
				let announcedWait = false;
				flight = await admit(flightKind(role), params.ceiling, signal, () => {
					if (announcedWait) return;
					announcedWait = true;
					const details = detailsFor(spec, "queued", { role });
					onUpdate?.({ content: [{ type: "text", text: "Waiting for a subagent slot..." }], details });
				});
			} catch (error) {
				if (error instanceof Error && error.message.includes("Spend ceiling")) {
					await appendLedger({
						action: "refuse-ceiling",
						role,
						ceiling: params.ceiling,
						error: error.message,
					});
				}
				throw error;
			}

			let reapFailed: string | undefined;
			const runAttempt = async (
				attemptSpec: RunSpec,
			): Promise<{ childResult: ChildResult; finalPane: string; startedAt: number }> => {
				const { tmuxSession, tmuxTarget } = attemptSpec;
				const runDir = path.join(getAgentDir(), RUNS_DIR, ctx.sessionManager.getSessionId(), attemptSpec.attachmentId);
				const resultPath = path.join(runDir, "result.json");
				flight.tmuxSession = tmuxSession;
				let sessionStarted = false;
				try {
					await mkdir(runDir, { recursive: true, mode: 0o700 });
					const promptPath = path.join(runDir, "task.md");
					const sessionDir = path.join(runDir, "session");
					await mkdir(sessionDir, { recursive: true, mode: 0o700 });
					const preamble =
						role === "general"
							? ""
							: constraintPreamble({
									role,
									invocation: flight.invocation,
									outcome: params.outcome ?? "",
									metric: params.metric ?? "",
									floor: params.floor ?? "",
									target: params.target ?? "",
									outputPath: outputFile,
									artifactPath: role === "review" ? path.resolve(cwd, params.artifactPath ?? "") : undefined,
									artifactSha256,
									allowFiles: params.allowFiles,
								});
					await writeFile(promptPath, `${preamble}# Delegated task\n\n${params.task}\n`, {
						encoding: "utf8",
						mode: 0o600,
					});

					const allowAbsolute = (params.allowFiles ?? []).map((file) => path.resolve(cwd, file));
					const piArgs = [
						...getPiInvocationParts(),
						"--provider",
						attemptSpec.provider,
						"--model",
						attemptSpec.model,
						"--thinking",
						attemptSpec.thinking,
						"--session-dir",
						sessionDir,
						"--session-id",
						attemptSpec.attachmentId,
						"--name",
						tmuxSession,
						attemptSpec.trusted ? "--approve" : "--no-approve",
						...childToolArgs(role),
						...childExtensions.flatMap((entry) => ["--extension", entry]),
						"--extension",
						EXTENSION_PATH,
						`@${promptPath}`,
					];
					const childCommand = [
						"exec env",
						`${CHILD_ENV}=1`,
						`${RESULT_ENV}=${shellQuote(resultPath)}`,
						`${ROLE_ENV}=${shellQuote(role)}`,
						...(role === "implement" ? [`${ALLOW_ENV}=${shellQuote(JSON.stringify(allowAbsolute))}`] : []),
						piArgs.map(shellQuote).join(" "),
					].join(" ");

					const tmuxVersion = await pi.exec("tmux", ["-V"], { timeout: 5_000 });
					if (tmuxVersion.code !== 0) {
						throw new Error(`tmux is required for subagents: ${tmuxVersion.stderr.trim() || "tmux not found"}`);
					}

					const startedAt = Date.now();
					const created = await pi.exec("tmux", tmuxArgs("new-session", "-d", "-s", tmuxSession, "-n", "pi", "-c", cwd));
					if (created.code !== 0) {
						throw new Error(`Failed to create tmux session: ${created.stderr.trim() || created.stdout.trim()}`);
					}
					sessionStarted = true;

					const remain = await pi.exec(
						"tmux",
						tmuxArgs("set-window-option", "-t", `${tmuxSession}:0`, "remain-on-exit", "on"),
					);
					if (remain.code !== 0) throw new Error(remain.stderr.trim() || "Failed to set remain-on-exit.");

					const initialDetails = detailsFor(attemptSpec, "running", { startedAt, role, invocation: flight.invocation });
					onUpdate?.({ content: [{ type: "text", text: partialText(initialDetails) }], details: initialDetails });

					const sent = await pi.exec("tmux", tmuxArgs("send-keys", "-t", tmuxTarget, "-l", "--", childCommand));
					if (sent.code !== 0) throw new Error(sent.stderr.trim() || "Failed to start child Pi.");
					const entered = await pi.exec("tmux", tmuxArgs("send-keys", "-t", tmuxTarget, "Enter"));
					if (entered.code !== 0) throw new Error(entered.stderr.trim() || "Failed to submit child command.");

					let lastPane = "";
					let childResult: ChildResult | undefined;
					while (!childResult) {
						if (signal?.aborted) throw new Error("Subagent aborted.");
						try {
							childResult = JSON.parse(await readFile(resultPath, "utf8")) as ChildResult;
							break;
						} catch {
							// The result file is created atomically when the child settles.
						}

						const paneResult = await pi.exec("tmux", tmuxArgs("capture-pane", "-p", "-J", "-t", tmuxTarget), {
							timeout: 5_000,
						});
						if (paneResult.code === 0) {
							const pane = trimPane(paneResult.stdout);
							if (pane && pane !== lastPane) {
								lastPane = pane;
								const details = detailsFor(attemptSpec, "running", {
									pane,
									startedAt,
									role,
									invocation: flight.invocation,
								});
								onUpdate?.({ content: [{ type: "text", text: partialText(details) }], details });
							}
						}

						const dead = await pi.exec("tmux", tmuxArgs("display-message", "-p", "-t", tmuxTarget, "#{pane_dead}"));
						if (dead.code !== 0) {
							throw new Error(`Child tmux session unavailable: ${dead.stderr.trim() || dead.stdout.trim() || tmuxTarget}`);
						}
						if (dead.code === 0 && dead.stdout.trim() === "1") {
							let reported = false;
							for (let attempt = 0; attempt < PANE_DEAD_POLLS; attempt++) {
								await abortableDelay(POLL_INTERVAL_MS, signal);
								try {
									childResult = JSON.parse(await readFile(resultPath, "utf8")) as ChildResult;
									reported = true;
									break;
								} catch {
									// A late rename can land after pane_dead.
								}
							}
							if (!reported) {
								throw new Error(
									`Child Pi exited before reporting a result.\n\n${lastPane || "No pane output."}\n\nInspect: ${attemptSpec.captureCommand}`,
								);
							}
							break;
						}

						await abortableDelay(POLL_INTERVAL_MS, signal);
					}

					const finalPaneResult = await pi.exec("tmux", tmuxArgs("capture-pane", "-p", "-J", "-t", tmuxTarget), {
						timeout: 5_000,
					});
					const finalPane = finalPaneResult.code === 0 ? trimPane(finalPaneResult.stdout) : lastPane;
					if (!childResult) throw new Error("Subagent finished without a result.");
					return { childResult, finalPane, startedAt };
				} finally {
					if (sessionStarted && !(await reap(tmuxSession))) reapFailed = tmuxSession;
				}
			};

			let pendingError: unknown;
			let toolResult: { content: [{ type: "text"; text: string }]; details: RunDetails } | undefined;
			try {
				await appendLedger({ action: "spawn", invocation: flight.invocation, role, ceiling: params.ceiling });
				let attempt: { childResult: ChildResult; finalPane: string; startedAt: number } | undefined;
				for (let index = 0; index < candidates.length; index++) {
					if (index > 0) spec = newSpec(candidates[index]);
					attempt = await runAttempt(spec);
					if (reapFailed) break;
					const next = candidates[index + 1];
					if (!next || !shouldTryNextModel(attempt.childResult)) break;
					const reason = `${spec.provider}/${spec.model} failed: ${(attempt.childResult.error ?? "").split("\n", 1)[0]}`;
					fallbacks.push(reason);
					await appendLedger({
						action: "model-fallback",
						invocation: flight.invocation,
						role,
						from: `${spec.provider}/${spec.model}`,
						to: `${next.provider}/${next.model}`,
						error: attempt.childResult.error,
					});
				}
				if (!attempt) throw new Error("Subagent finished without a result.");
				const { childResult, finalPane, startedAt } = attempt;
				const status: RunStatus = childResult.status === "completed" ? "completed" : "failed";
				let rawOutput = childResult.output.trim();
				if (childResult.status === "failed" && childResult.error?.trim()) {
					rawOutput += `${rawOutput ? "\n\n" : ""}Error: ${childResult.error.trim()}`;
				}
				if (outputFile) {
					try {
						await writeExclusive(outputFile, `${rawOutput || "(no text output)"}\n`);
					} catch (error) {
						throw new Error(
							`Failed to write output file ${outputFile}: ${error instanceof Error ? error.message : String(error)}\n\n${rawOutput}`,
						);
					}
				}
				const output = truncateToolText(rawOutput || "(no text output)");
				const details = detailsFor(spec, status, {
					pane: finalPane,
					output,
					outputFile,
					residual: role === "implement" ? IMPLEMENT_RESIDUAL : undefined,
					role,
					invocation: flight.invocation,
					sessionFile: childResult.sessionFile,
					provider: childResult.provider ?? spec.provider,
					model: childResult.model ?? spec.model,
					thinking: childResult.thinking ?? spec.thinking,
					fallbacks: fallbacks.length > 0 ? fallbacks : undefined,
					startedAt,
					finishedAt: childResult.finishedAt,
				});

				if (childResult.status === "failed") throw new Error(resultText(details));
				toolResult = { content: [{ type: "text", text: resultText(details) }], details };
			} catch (error) {
				pendingError = error;
			} finally {
				if (reapFailed) {
					const message = pendingError instanceof Error ? pendingError.message : pendingError ? String(pendingError) : "";
					const reapError = `Failed to reap tmux session ${reapFailed}.`;
					pendingError = new Error(message ? `${message}\n${reapError}` : reapError);
				} else {
					await releaseFlight(flight.id);
				}
			}
			if (pendingError) throw pendingError;
			if (!toolResult) throw new Error("Subagent finished without a result.");
			return toolResult;
		},

		renderCall(args, theme) {
			const task = args.task?.trim() || "...";
			const firstLine = task.split("\n", 1)[0] ?? task;
			const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
			const role = args.role?.trim();
			let text = theme.fg("toolTitle", theme.bold("subagent "));
			if (role) text += theme.fg("accent", `${role} `);
			text += theme.fg("dim", preview);
			const overrides = [args.provider, args.model, args.thinking].filter(Boolean);
			if (overrides.length > 0) text += `\n  ${theme.fg("muted", overrides.join(" · "))}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as RunDetails | undefined;
			if (!details) {
				const content = result.content.find((part) => part.type === "text");
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}

			const running = isPartial || details.status === "queued" || details.status === "running";
			const icon = running
				? theme.fg("warning", details.status === "queued" ? "◦" : "●")
				: details.status === "completed"
					? theme.fg("success", "✓")
					: theme.fg("error", "✗");
			const duration = formatDuration(details.startedAt, details.finishedAt);
			let text = `${icon} ${theme.fg("toolTitle", theme.bold(details.tmuxSession))}`;
			text += theme.fg("muted", ` · ${details.status}${duration ? ` · ${duration}` : ""}`);
			text += `\n  ${theme.fg("accent", details.attachCommand)}`;
			text += `\n  ${theme.fg("dim", `${details.provider}/${details.model} (${details.thinking})`)}`;

			if (running && details.pane) {
				const paneLines = details.pane.split("\n");
				const visible = expanded ? paneLines : paneLines.slice(-8);
				text += `\n\n${visible.map((line) => theme.fg("dim", line)).join("\n")}`;
			} else if (!running && details.output) {
				const outputLines = details.output.split("\n");
				const visible = expanded ? outputLines : outputLines.slice(0, 8);
				text += `\n\n${visible.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
				if (!expanded && outputLines.length > visible.length) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				text += `\n\n  ${theme.fg("dim", `capture: ${details.captureCommand}`)}`;
				text += `\n  ${theme.fg("dim", `cleanup: ${details.killCommand}`)}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
