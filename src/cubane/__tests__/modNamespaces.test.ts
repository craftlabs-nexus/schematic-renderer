import { describe, it, expect } from "vitest";
import { AssetLoader, atlasLookupVariations } from "../AssetLoader";
import { SignRenderer } from "../SignRenderer";

// A mod's block is drawn from the mod's assets, never from the game's asset of the same name.
describe("mod namespaces", () => {
	it("looks a texture up in the atlas in its own namespace only", () => {
		expect(atlasLookupVariations("item/iron_bars")).toContain("block/iron_bars");
		const modded = atlasLookupVariations("mymod:item/iron_bars");
		expect(modded).toContain("mymod:block/iron_bars");
		expect(modded.every((v) => v.startsWith("mymod:"))).toBe(true);

		const loader = new AssetLoader(false) as any;
		loader.textureUVMap.set("block/iron_bars", { u: 0, v: 0, width: 0.1, height: 0.1 });
		const hit = (path: string) =>
			atlasLookupVariations(path).some((v) => loader.getTextureUV(v) !== null);
		expect(hit("item/iron_bars")).toBe(true);
		expect(hit("mymod:item/iron_bars")).toBe(false); // drawn from its own texture instead
	});

	it("draws a mod's sign from the mod's textures, and leaves it to the mod's model without them", async () => {
		const asked: string[] = [];
		const assets = {
			getTexturePixels: async (path: string) => {
				asked.push(path);
				return null;
			},
		};
		const signs = new SignRenderer(assets as unknown as AssetLoader) as any;
		const fir = signs.detectSign("biomesoplenty:fir_wall_sign", { facing: "north" });
		expect(fir).toMatchObject({ namespace: "biomesoplenty", wood: "fir", isWall: true });
		expect(signs.detectSign("biomesoplenty:fir_wall_hanging_sign", {})?.wood).toBe("fir");
		expect(signs.detectSign("minecraft:oak_sign", {})?.wood).toBe("oak");

		expect(
			await signs.buildSignMesh("biomesoplenty:fir_wall_sign", { facing: "north" }, {})
		).toBeNull();
		expect(asked).toEqual(["biomesoplenty:block/fir_sign", "biomesoplenty:entity/signs/fir"]);
	});
});
