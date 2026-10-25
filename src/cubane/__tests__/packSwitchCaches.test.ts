import { describe, it, expect } from "vitest";
import { AssetLoader } from "../AssetLoader";
import { SignRenderer } from "../SignRenderer";

// What is read from the packs has to be read again when the packs change: a cache that outlives a pack switch draws
// with the old pack (a pieced glass sheet baked from a vanilla texture, the old pack's sign boards and font).
describe("caches read from the packs, after a pack switch", () => {
	it("AssetLoader asks for a texture's connecting metadata again", async () => {
		const loader = new AssetLoader(false) as any;
		let mcmeta: string | undefined = JSON.stringify({
			fusion: { type: "connecting", layout: "pieced" },
		});
		loader.getResourceString = async () => mcmeta;
		expect((await loader.getConnectingTexture("block/glass"))?.layout).toBe("pieced");

		// the next pack has a plain glass texture
		mcmeta = undefined;
		loader.packManager = { getEnabledPacks: () => [] };
		loader.buildTextureAtlas = async () => undefined;
		await loader.rebuildFromPackManager();
		expect(await loader.getConnectingTexture("block/glass")).toBeNull();
	});

	it("SignRenderer reads the sign textures and the font again", async () => {
		const reads: string[] = [];
		let has = false;
		const assets = {
			getTexturePixels: async (path: string) => {
				reads.push(path);
				return has ? ({ width: 1, height: 1, data: new Uint8ClampedArray(4) } as ImageData) : null;
			},
		};
		const signs = new SignRenderer(assets as unknown as AssetLoader) as any;
		const oak = { isHanging: false, wood: "oak" };
		expect(await signs.getBasePixels(oak)).toBeNull(); // before the pack is loaded
		has = true;
		expect(await signs.getBasePixels(oak)).toBeNull(); // remembered
		signs.clearCaches();
		expect(await signs.getBasePixels(oak)).not.toBeNull();

		has = false;
		await signs.ensureFont();
		const fontReads = reads.filter((p) => p === "font/ascii").length;
		signs.clearCaches();
		await signs.ensureFont();
		expect(reads.filter((p) => p === "font/ascii").length).toBe(fontReads + 1);
	});
});
