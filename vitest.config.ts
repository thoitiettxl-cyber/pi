import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		server: {
			// Keep installed peers and symlinked workspace builds in Node's module loader.
			deps: { external: [/@earendil-works\//, /\/packages\/[^/]+\/dist\//] },
		},
	},
});
