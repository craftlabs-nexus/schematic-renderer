import { describe, it, expect } from "vitest";
import { ModelResolver } from "../ModelResolver";
import { AssetLoader } from "../AssetLoader";
import { Block, BlockStateDefinition } from "../types";

// vanilla blockstates/redstone_wire.json, abridged: `side|up` values and an OR of AND conditions
const redstoneWire: BlockStateDefinition = {
	multipart: [
		{
			apply: { model: "minecraft:block/redstone_dust_dot" },
			when: {
				OR: [
					{ east: "none", north: "none", south: "none", west: "none" },
					{ east: "side|up", north: "side|up" },
				],
			},
		},
		{ apply: { model: "minecraft:block/redstone_dust_side0" }, when: { north: "side|up" } },
		{ apply: { model: "minecraft:block/redstone_dust_up" }, when: { north: "up" } },
	],
};

describe("ModelResolver multipart conditions", () => {
	const loader = { getBlockState: async () => redstoneWire } as unknown as AssetLoader;
	const resolver = new ModelResolver(loader);
	const wire = (sides: Partial<Record<"north" | "east" | "south" | "west", string>>): Block => ({
		namespace: "minecraft",
		name: "redstone_wire",
		properties: { north: "none", east: "none", south: "none", west: "none", power: "7", ...sides },
	});
	const modelsOf = async (block: Block) =>
		(await resolver.resolveBlockModel(block)).map((m) => m.model.replace("minecraft:", ""));

	it("matches either value of an a|b condition", async () => {
		expect(await modelsOf(wire({ north: "side" }))).toEqual(["block/redstone_dust_side0"]);
		expect(await modelsOf(wire({ north: "up" }))).toEqual([
			"block/redstone_dust_side0",
			"block/redstone_dust_up",
		]);
	});

	it("applies an OR of AND conditions", async () => {
		expect(await modelsOf(wire({}))).toEqual(["block/redstone_dust_dot"]);
		expect(await modelsOf(wire({ north: "side", east: "up" }))).toEqual([
			"block/redstone_dust_dot",
			"block/redstone_dust_side0",
		]);
		expect(await modelsOf(wire({ east: "side" }))).toEqual([]);
	});
});
