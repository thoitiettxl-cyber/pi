import type { ModelsPublication, RefreshModelsContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ClientModelConfigSchema,
	DefaultOverrideModelConfigSchema,
	DisplayOption,
	GetCliModelConfigsRequestSchema,
	GetCliModelConfigsResponseSchema,
	ModelFamilyMetadataEntrySchema,
	ModelFamilyMetadataSchema,
	ModelFamilyMetadataValueSchema,
	ModelFeaturesSchema,
	ModelInfoSchema,
} from "../src/devin-proto.ts";
import { fetchDevinModels, normalizeDevinModels } from "../src/discovery.ts";
import { devinProvider } from "../src/index.ts";
import { toModel } from "../src/models.ts";
import { create, fromBinary, toBinary } from "../src/protobuf.ts";

afterEach(() => vi.unstubAllGlobals());
function family(effort: string) {
	return create(ModelFamilyMetadataSchema, {
		modelFamilyLabel: "Claude Sonnet 4.5",
		entries: [
			create(ModelFamilyMetadataEntrySchema, {
				key: "Reasoning Effort",
				value: create(ModelFamilyMetadataValueSchema, { name: effort }),
			}),
		],
	});
}
const response = create(GetCliModelConfigsResponseSchema, {
	clientModelConfigs: [
		create(ClientModelConfigSchema, {
			modelUid: "claude-sonnet-4-5-low",
			label: "Claude Sonnet 4.5 Low",
			supportsImages: true,
			modelFamilyMetadata: family("Low"),
		}),
		create(ClientModelConfigSchema, {
			modelUid: "claude-sonnet-4-5-high",
			label: "Claude Sonnet 4.5 High",
			modelFamilyMetadata: family("High"),
		}),
		create(ClientModelConfigSchema, {
			modelUid: "adaptive",
			label: "Adaptive",
			modelInfo: create(ModelInfoSchema, { displayOption: DisplayOption.MODEL_ROUTER }),
		}),
		create(ClientModelConfigSchema, {
			modelUid: "hidden",
			modelInfo: create(ModelInfoSchema, { displayOption: DisplayOption.QUICK_REVIEW }),
		}),
		create(ClientModelConfigSchema, { modelUid: "disabled", disabled: true }),
		create(ClientModelConfigSchema, {
			modelUid: "swe-1-6",
			label: "SWE-1.6",
			supportsImages: true,
			modelInfo: create(ModelInfoSchema, {
				maxTokens: 200000,
				maxOutputTokens: 128000,
				modelFeatures: create(ModelFeaturesSchema, {
					supportsImages: true,
					supportsThinking: true,
					supportsToolCalls: true,
					supportsParallelToolCalls: true,
				}),
			}),
		}),
	],
	defaultOverrideModelConfig: create(DefaultOverrideModelConfigSchema, { modelUid: "claude-sonnet-4-5-high" }),
});

describe("Devin model discovery", () => {
	it("filters hidden models, collapses effort lanes, preserves account default and router", () => {
		const models = normalizeDevinModels(response, undefined).map(toModel);
		expect(models.map((model) => model.id)).toEqual(["adaptive", "claude-sonnet-4-5", "swe-1-6"]);
		expect(models.find((model) => model.id === "adaptive")?.devin?.modelRouter).toBe(true);
		const claude = models.find((model) => model.id === "claude-sonnet-4-5")!;
		expect(claude.devin).toMatchObject({
			isProviderDefault: true,
			defaultLevel: "high",
			requestModelId: "claude-sonnet-4-5-high",
			effortRouting: { high: "claude-sonnet-4-5-high", low: "claude-sonnet-4-5-low" },
		});
		expect(claude.thinkingLevelMap).toMatchObject({ high: "high", low: "low", off: null });
		expect(models.find((model) => model.id === "swe-1-6")).toMatchObject({
			input: ["text"],
			contextWindow: 200000,
			maxTokens: 128000,
		});
	});

	it("sends the native discovery identity and display slots in a real protobuf request", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
			const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
			expect(fromBinary(GetCliModelConfigsRequestSchema, body).metadata).toMatchObject({
				apiKey: "key",
				ideName: "chisel",
				ideVersion: "0.0.0-dev",
				supportedModelDisplays: [3, 4, 6, 7, 8],
			});
			return new Response(toBinary(GetCliModelConfigsResponseSchema, response));
		});
		expect(await fetchDevinModels({ apiKey: "key", fetch })).toHaveLength(3);
	});

	it("returns null on empty, malformed and HTTP-error discovery responses", async () => {
		for (const reply of [
			new Response(new Uint8Array()),
			new Response(new Uint8Array([255])),
			new Response("", { status: 500 }),
		]) {
			expect(await fetchDevinModels({ fetch: async () => reply })).toBeNull();
		}
		expect(normalizeDevinModels(create(GetCliModelConfigsResponseSchema), undefined)).toEqual([]);
	});

	it("publishes and restores catalogs transactionally, retains prior models on failure", async () => {
		vi.stubGlobal("fetch", async () => new Response(toBinary(GetCliModelConfigsResponseSchema, response)));
		const provider = devinProvider();
		let publication: ModelsPublication | undefined;
		const refresh: RefreshModelsContext = {
			credential: { type: "api_key", key: "key" },
			allowNetwork: true,
			signal: new AbortController().signal,
			publish: async (value) => {
				publication = value;
				value.update?.();
				return true;
			},
		};
		await provider.refreshModels?.(refresh);
		expect(publication?.persist?.models).toHaveLength(3);
		const before = provider.getModels();
		vi.stubGlobal("fetch", async () => new Response("", { status: 500 }));
		await provider.refreshModels?.(refresh);
		expect(provider.getModels()).toBe(before);
		const restored = devinProvider();
		await restored.refreshModels?.({ ...refresh, allowNetwork: false, stored: publication?.persist ?? undefined });
		expect(restored.getModels()).toEqual(before);
	});

	it("exposes a synchronous seed before auth and ignores superseded publications", async () => {
		vi.stubGlobal("fetch", async () => new Response(toBinary(GetCliModelConfigsResponseSchema, response)));
		const provider = devinProvider();
		expect(provider.getModels().map((model) => model.id)).toEqual(["swe-1-6"]);
		await provider.refreshModels?.({
			credential: { type: "api_key", key: "key" },
			allowNetwork: true,
			signal: new AbortController().signal,
			publish: async () => false,
		});
		expect(provider.getModels().map((model) => model.id)).toEqual(["swe-1-6"]);
	});
});
