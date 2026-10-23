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

// Only block/water, block/lava and their _level_N are liquids: a prefix match took block/lava_cauldron and
// block/water_cauldron_level1 for liquid models, so a lava cauldron drew as a cube of lava.
describe("AssetLoader.getModel and liquids", () => {
	const files: Record<string, unknown> = {
		"models/minecraft:block/lava_cauldron.json": {
			parent: "minecraft:block/template_cauldron_full",
			textures: { content: "minecraft:block/lava_still", side: "minecraft:block/cauldron_side" },
		},
		"models/minecraft:block/water_cauldron_level1.json": {
			parent: "minecraft:block/template_cauldron_level1",
			textures: { content: "minecraft:block/water_still" },
		},
		"models/minecraft:block/template_cauldron_full.json": {
			elements: [{ from: [0, 3, 0], to: [2, 16, 16], faces: { north: { texture: "#side" } } }],
		},
		"models/minecraft:block/template_cauldron_level1.json": {
			elements: [{ from: [0, 3, 0], to: [2, 16, 16], faces: { north: { texture: "#side" } } }],
		},
	};
	function loader() {
		const l = new AssetLoader(false) as any;
		l.getResourceString = async (path: string) => {
			const hit = files[path] ?? files[path.replace("models/", "models/minecraft:")];
			return hit ? JSON.stringify(hit) : undefined;
		};
		return l as AssetLoader;
	}

	it("loads a cauldron's own model, not a liquid cube", async () => {
		for (const path of ["minecraft:block/lava_cauldron", "minecraft:block/water_cauldron_level1"]) {
			const model = await loader().getModel(path);
			expect(model.elements?.[0]?.from).toEqual([0, 3, 0]);
			expect(model.textures?.north).toBeUndefined(); // the liquid cube's flow texture
		}
	});

	it("still makes water, lava and their levels liquid models", async () => {
		const lava = await loader().getModel("minecraft:block/lava");
		expect(lava.textures?.top).toBe("block/lava_still");
		const water = await loader().getModel("minecraft:block/water_level_3");
		expect(water.elements?.[0]?.to).toEqual([16, 10, 16]);
	});
});
