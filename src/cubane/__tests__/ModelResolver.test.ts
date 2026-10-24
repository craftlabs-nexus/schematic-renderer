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

// mcwwindows blockstates/stone_brick_gothic.json, abridged: every case written as an AND of one condition
const gothicWindow: BlockStateDefinition = {
	multipart: [
		{
			when: { AND: [{ facing: "east|west", part: "bottom" }] },
			apply: { model: "mcwwindows:block/gothic/lower" },
		},
		{
			when: { AND: [{ facing: "north|south", part: "bottom" }] },
			apply: { model: "mcwwindows:block/gothic/lower", y: 90 },
		},
		{
			when: { AND: [{ facing: "north|south", part: "top" }] },
			apply: { model: "mcwwindows:block/gothic/top", y: 90 },
		},
		// nested: an OR of an AND and a plain condition, and an AND of two
		{
			when: { OR: [{ AND: [{ part: "top" }, { open: "true" }] }, { part: "base" }] },
			apply: { model: "mcwwindows:block/gothic/glass" },
		},
		{
			when: { AND: [{ part: "bottom" }, { open: "true" }] },
			apply: { model: "mcwwindows:block/gothic/hinge" },
		},
	],
};

describe("ModelResolver multipart AND conditions", () => {
	const loader = { getBlockState: async () => gothicWindow } as unknown as AssetLoader;
	const resolver = new ModelResolver(loader);
	const window = (properties: Record<string, string>): Block => ({
		namespace: "mcwwindows",
		name: "stone_brick_gothic",
		properties,
	});
	const resolved = async (properties: Record<string, string>) =>
		(await resolver.resolveBlockModel(window(properties))).map(
			(m) => `${m.model.replace("mcwwindows:block/gothic/", "")}${m.y ? `@${m.y}` : ""}`
		);

	it("applies an AND of one condition (Macaw's windows were drawn as nothing)", async () => {
		expect(await resolved({ facing: "south", open: "false", part: "bottom" })).toEqual([
			"lower@90",
		]);
		expect(await resolved({ facing: "west", open: "false", part: "bottom" })).toEqual(["lower"]);
		expect(await resolved({ facing: "north", open: "false", part: "top" })).toEqual(["top@90"]);
	});

	it("needs every condition of an AND, and any of an OR, nested either way", async () => {
		expect(await resolved({ facing: "south", open: "true", part: "bottom" })).toEqual([
			"lower@90",
			"hinge",
		]);
		expect(await resolved({ facing: "north", open: "true", part: "top" })).toEqual([
			"top@90",
			"glass",
		]);
		expect(await resolved({ facing: "east", open: "false", part: "base" })).toEqual(["glass"]);
		expect(await resolved({ facing: "east", open: "false", part: "middle" })).toEqual([]);
	});
});
