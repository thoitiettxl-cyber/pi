// Ported from oh-my-pi (MIT)
import { type Effort, type ModelSpec, THINKING_EFFORTS } from "./models.ts";
import { variantFamilies } from "./variant-families.ts";

export interface EffortVariantFamily {
	id: string;
	name: string;
	members: readonly string[];
	defaultMember?: string;
	routing: Readonly<Partial<Record<Effort | "off", string>>>;
	thinking?: ModelSpec<"devin-agent">["thinking"];
}

export function collapseVariants(
	specs: ModelSpec<"devin-agent">[],
	options?: { table: { families: readonly EffortVariantFamily[] } },
): ModelSpec<"devin-agent">[] {
	const reviewed: readonly (EffortVariantFamily & { mode?: string; efforts?: readonly Effort[] })[] = variantFamilies;
	const families: readonly EffortVariantFamily[] =
		options?.table.families ??
		reviewed.map((family) => ({
			...family,
			thinking: family.efforts
				? { mode: family.mode ?? "effort", efforts: family.efforts, requiresEffort: true }
				: undefined,
		}));
	const result = new Map(specs.map((spec) => [spec.id, spec]));
	for (const family of families) {
		if (result.get(family.id)?.thinking?.effortRouting) continue;
		const members = family.members
			.map((id) => result.get(id))
			.filter((spec): spec is ModelSpec<"devin-agent"> => spec !== undefined);
		if (members.length === 0) continue;
		const primary = members.find((spec) => spec.id === family.defaultMember) ?? members[0];
		const routing: Partial<Record<Effort | "off", string>> = {};
		for (const level of ["off", ...THINKING_EFFORTS] as const) {
			const target = family.routing[level];
			if (target && result.has(target)) routing[level] = target;
		}
		const efforts = THINKING_EFFORTS.filter((level) => routing[level] !== undefined);
		for (const member of members) result.delete(member.id);
		const defaultLevel = efforts.find((level) => routing[level] === primary.id) ?? efforts[0];
		result.set(family.id, {
			...members[0],
			id: family.id,
			name: family.name,
			reasoning: members.some((spec) => spec.reasoning) || efforts.length > 0,
			input: members.some((spec) => spec.input.includes("image")) ? ["text", "image"] : ["text"],
			contextWindow: Math.max(...members.map((spec) => spec.contextWindow)),
			maxTokens: Math.max(...members.map((spec) => spec.maxTokens)),
			requestModelId: primary.requestModelId ?? primary.id,
			isProviderDefault: members.some((spec) => spec.isProviderDefault),
			thinking: efforts.length
				? { ...family.thinking, mode: family.thinking?.mode ?? "effort", efforts, effortRouting: routing, defaultLevel }
				: undefined,
		});
	}
	return [...result.values()];
}
