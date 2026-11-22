import { lstat, mkdir, realpath } from "node:fs/promises";
import * as path from "node:path";

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
