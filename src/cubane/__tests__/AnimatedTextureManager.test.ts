import { describe, it, expect } from "vitest";
import { AnimatedTextureManager } from "../AnimatedTextureManager";
import { AssetLoader } from "../AssetLoader";

describe("AnimatedTextureManager.isAnimated", () => {
	const files: Record<string, string> = {
		"textures/block/water_still.png.mcmeta": JSON.stringify({ animation: { frametime: 2 } }),
		"textures/block/glass.png.mcmeta": JSON.stringify({ texture: { blur: false } }),
		"textures/scratched_glass/lime.png.mcmeta": JSON.stringify({
			fusion: { type: "connecting", layout: "pieced" },
		}),
		"textures/block/broken.png.mcmeta": "{ not json",
	};
	const loader = {
		getResourceString: async (path: string) => files[path],
	} as unknown as AssetLoader;
	const manager = new AnimatedTextureManager(loader);

	it("is true only for an mcmeta with an animation section", async () => {
		expect(await manager.isAnimated("textures/block/water_still")).toBe(true);
		expect(await manager.isAnimated("textures/block/glass")).toBe(false);
		expect(await manager.isAnimated("textures/scratched_glass/lime")).toBe(false);
		expect(await manager.isAnimated("textures/block/broken")).toBe(false);
		expect(await manager.isAnimated("textures/block/stone")).toBe(false);
	});
});
