// Ported from oh-my-pi (MIT)
import type { Api, Model, ModelCost, ModelThinkingLevel, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
export type { ModelCost };
export type FetchImpl = typeof fetch;
export const Effort = {
	Minimal: "minimal",
	Low: "low",
	Medium: "medium",
	High: "high",
	XHigh: "xhigh",
	Max: "max",
} as const;
export type Effort = (typeof Effort)[keyof typeof Effort];
export const THINKING_EFFORTS: readonly Effort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export interface DevinCompat {
	modelRouter?: boolean;
	supportsParallelToolCalls?: boolean;
}
export interface DevinState extends DevinCompat {
	supportsTools?: boolean;
	requestModelId?: string;
	effortRouting?: Partial<Record<ModelThinkingLevel, string>>;
	defaultLevel?: ThinkingLevel;
	isProviderDefault?: boolean;
}
export type DevinModel = Model<Api> & { devin?: DevinState };

export interface ModelSpec<TApi extends string> {
	id: string;
	name: string;
	api: TApi;
	provider: string;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	supportsTools?: boolean;
	cost: ModelCost;
	contextWindow: number;
	maxTokens: number;
	compat?: DevinCompat;
	requestModelId?: string;
	isProviderDefault?: boolean;
	description?: string;
	isNew?: boolean;
	isBeta?: boolean;
	isRecommended?: boolean;
	thinking?: {
		mode: string;
		efforts: readonly ThinkingLevel[];
		effortRouting?: Partial<Record<ModelThinkingLevel, string>>;
		defaultLevel?: ThinkingLevel;
		requiresEffort?: boolean;
	};
}

export const seedModels: DevinModel[] = [
	{
		id: "swe-1-6",
		name: "SWE-1.6",
		api: "devin-agent",
		provider: "devin",
		baseUrl: "https://server.codeium.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 128000,
		devin: { supportsParallelToolCalls: true, isProviderDefault: true },
	},
];

export function toModel(spec: ModelSpec<"devin-agent">): DevinModel {
	const {
		compat,
		thinking,
		requestModelId,
		isProviderDefault,
		supportsTools,
		description: _description,
		isNew: _new,
		isBeta: _beta,
		isRecommended: _recommended,
		...model
	} = spec;
	let thinkingLevelMap: ThinkingLevelMap | undefined;
	if (thinking?.effortRouting) {
		thinkingLevelMap = {};
		for (const level of ["off", ...THINKING_EFFORTS] as const) {
			thinkingLevelMap[level] = thinking.effortRouting[level] ? level : null;
		}
	}
	return {
		...model,
		thinkingLevelMap,
		devin: {
			...compat,
			supportsTools,
			requestModelId,
			effortRouting: thinking?.effortRouting,
			defaultLevel: thinking?.defaultLevel,
			isProviderDefault,
		},
	};
}
