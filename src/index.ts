import { envApiKeyAuth, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { credentialServerUrl, devinOAuth } from "./auth.ts";
import { fetchDevinModels } from "./discovery.ts";
import { type DevinModel, seedModels, toModel } from "./models.ts";
import { type DevinOptions, streamDevin } from "./stream.ts";

export function devinProvider(): Provider {
	let models: readonly DevinModel[] = seedModels;
	return {
		id: "devin",
		name: "Devin",
		auth: { apiKey: envApiKeyAuth("Devin API key", ["DEVIN_API_KEY"]), oauth: devinOAuth },
		getModels: () => models,
		refreshModels: async (context) => {
			if (context.stored) {
				const restored = context.stored.models.filter(
					(model) => model.provider === "devin" && model.api === "devin-agent",
				) as DevinModel[];
				if (
					restored.length &&
					!(await context.publish({
						update: () => {
							models = restored;
						},
					}))
				)
					return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			const credential = context.credential;
			const apiKey = credential?.type === "oauth" ? credential.access : (credential?.key ?? process.env.DEVIN_API_KEY);
			if (!apiKey) return;
			const baseUrl = (credential?.type === "oauth" ? credentialServerUrl(credential) : undefined) ?? context.baseUrl;
			const specs = await fetchDevinModels({ apiKey, baseUrl, signal: context.signal });
			if (context.signal.aborted) return;
			const refreshed = specs.map(toModel);
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now() },
				update: () => {
					models = refreshed;
				},
			});
		},
		// The registered API is Devin; Provider's generic stream signature also names other APIs.
		stream: (model, context, options) => streamDevin(model, context, options as DevinOptions),
		streamSimple: streamDevin,
	};
}

export default function extension(pi: ExtensionAPI): void {
	pi.registerProvider(devinProvider());
}
