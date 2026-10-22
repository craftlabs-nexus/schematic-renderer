import { describe, it, expect } from "vitest";
import { AssetLoader } from "../AssetLoader";
import { BlockModel } from "../types";

describe("AssetLoader.resolveTexture", () => {
	const loader = new AssetLoader(false);

	it("follows string references and strips the minecraft namespace", () => {
		const model: BlockModel = { textures: { all: "minecraft:block/stone", side: "#all" } };
		expect(loader.resolveTexture("#side", model)).toBe("block/stone");
		expect(loader.resolveTexture("minecraft:block/dirt", model)).toBe("block/dirt");
	});

	it("takes the sprite of a 26.x texture object", () => {
		// models/block/glass.json since 26.x
		const model: BlockModel = {
			textures: { all: { sprite: "minecraft:block/glass", force_translucent: true } },
		};
		expect(loader.resolveTexture("#all", model)).toBe("block/glass");
		expect(loader.resolveTexture({ sprite: "block/glass_pane_top" }, model)).toBe(
			"block/glass_pane_top"
		);
	});

	it("follows a reference chain through texture objects", () => {
		const model: BlockModel = {
			textures: { pane: { sprite: "minecraft:block/glass" }, side: "#pane", particle: "#side" },
		};
		expect(loader.resolveTexture("#particle", model)).toBe("block/glass");
	});

	it("falls back to the missing texture for dangling references", () => {
		expect(loader.resolveTexture("#nope", { textures: { all: "block/stone" } })).toBe(
			"block/missing_texture"
		);
		expect(loader.resolveTexture("#missing", {})).toBe("block/missing_texture");
	});
});
