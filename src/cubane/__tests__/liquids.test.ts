import { describe, it, expect } from "vitest";
import { isLiquidTexture, isWaterlogged, liquidOf, liquidTexture, namespacedId } from "../liquids";

// The game's liquids, read the same way by the model resolver, the mesh builder, the materials and the culling.
describe("liquids", () => {
	it("are the game's water and lava, flowing or not, with or without the namespace", () => {
		expect(liquidOf("minecraft:water")).toBe("water");
		expect(liquidOf("water")).toBe("water");
		expect(liquidOf("minecraft:flowing_lava")).toBe("lava");
		// a block named after a liquid, and a mod's block named like one, are not liquids
		expect(liquidOf("minecraft:water_cauldron")).toBeNull();
		expect(liquidOf("minecraft:lava_cauldron")).toBeNull();
		expect(liquidOf("create:water")).toBeNull();
	});

	it("hold water when waterlogged, or always for the plants and columns that do", () => {
		expect(isWaterlogged("minecraft:oak_slab", { waterlogged: "true" })).toBe(true);
		expect(isWaterlogged("minecraft:oak_slab", { waterlogged: "false" })).toBe(false);
		expect(isWaterlogged("kelp")).toBe(true);
		expect(isWaterlogged("minecraft:stone")).toBe(false);
	});

	it("draw still on top and on a source's sides, flowing only on a flowing liquid's", () => {
		expect(liquidTexture("water", "up", true)).toBe("block/water_still");
		expect(liquidTexture("water", "north", false)).toBe("block/water_still");
		expect(liquidTexture("lava", "north", true)).toBe("block/lava_flow");
	});

	it("tell the game's liquid textures from a mod's named like them", () => {
		expect(isLiquidTexture("block/water_still")).toBe(true);
		expect(isLiquidTexture("minecraft:block/lava_flow")).toBe(true);
		expect(isLiquidTexture("mymod:block/mywater_still")).toBe(false);
		expect(namespacedId("stone")).toBe("minecraft:stone");
		expect(namespacedId("create:cog")).toBe("create:cog");
	});
});
