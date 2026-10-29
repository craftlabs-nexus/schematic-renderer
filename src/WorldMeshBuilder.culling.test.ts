import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

// The same stand-ins as WorldMeshBuilder.palette.test.ts, so the module loads without WASM, workers or a renderer.
vi.mock("./wasm/minecraft_schematic_utils_bg.wasm", () => ({ default: "mock-utils-wasm" }));
vi.mock("nucleation", () => ({
	default: vi.fn().mockResolvedValue(undefined),
	SchematicWrapper: class {},
}));
vi.mock("./workers/MeshBuilder.worker?worker&inline", () => ({
	default: class MockWorker {
		postMessage() {}
		terminate() {}
		onmessage = null;
	},
}));
vi.mock("./SchematicRenderer");
vi.mock("./cubane", () => ({ Cubane: class {} }));
vi.mock("./managers/SchematicObject");
vi.mock("./MaterialRegistry");
vi.mock("./InstancedBlockRenderer");

import { WorldMeshBuilder } from "./WorldMeshBuilder";
import { SOLID_CULL_KEY, FLUID_NONE, FLUID_WATER, FLUID_LAVA } from "./workers/faceCulling";

// What a block tells its neighbours about hiding their faces (WorldMeshBuilder.computeCulling), from the faces
// Cubane.getBlockOptimizationData gives: each side's culling faces, their box and their material's alpha class.
const SIDES = ["west", "east", "down", "up", "north", "south"] as const;
const material = (alphaClass: string) => {
	const m = new THREE.MeshBasicMaterial();
	m.userData.alphaClass = alphaClass;
	return m;
};
const FULL: [number[], number[]] = [
	[0, 0, 0],
	[16, 16, 16],
];
// a full cube in one alpha class, or a model's faces by side
const cube = (alphaClass: string) =>
	new Map(SIDES.map((s) => [s, [{ material: material(alphaClass), elementBounds: FULL }]]));

function builder(models: Record<string, Map<string, unknown[]>>) {
	const wmb = Object.create(WorldMeshBuilder.prototype) as any;
	wmb.cubane = {
		getBlockOptimizationData: async (block: string) => ({
			isCube: false,
			cullableFaces: models[block.replace(/\[.*$/, "")] ?? new Map(),
		}),
	};
	return wmb;
}

describe("a block's culling", () => {
	const models = {
		"minecraft:stone": cube("opaque"),
		"minecraft:glass": cube("cutout"),
		"minecraft:slime_block": cube("translucent"),
		"minecraft:oak_leaves": cube("cutout"),
		// a grass block: opaque dirt sides with a cutout overlay over them
		"minecraft:grass_block": new Map(
			SIDES.map((s) => [
				s,
				[
					{ material: material("opaque"), elementBounds: FULL },
					{ material: material("cutout"), elementBounds: FULL },
				],
			])
		),
		// a bottom slab: a full bottom, half-high sides
		"minecraft:stone_slab": new Map<string, unknown[]>([
			[
				"down",
				[
					{
						material: material("opaque"),
						elementBounds: [
							[0, 0, 0],
							[16, 8, 16],
						],
					},
				],
			],
			...(["west", "east", "north", "south"] as const).map(
				(s) =>
					[
						s,
						[
							{
								material: material("opaque"),
								elementBounds: [
									[0, 0, 0],
									[16, 8, 16],
								],
							},
						],
					] as [string, unknown[]]
			),
		]),
	};

	it("keys an opaque block as solid: its full sides hide anything", async () => {
		const wmb = builder(models);
		expect(await wmb.computeCulling("minecraft:stone")).toEqual({
			occlusionFlags: 63,
			cullKey: SOLID_CULL_KEY,
		});
		// the overlay does not make the grass block's sides see-through
		expect(await wmb.computeCulling("minecraft:grass_block")).toEqual({
			occlusionFlags: 63,
			cullKey: SOLID_CULL_KEY,
		});
		expect(await wmb.computeCulling("minecraft:stone_slab[type=bottom]")).toEqual({
			occlusionFlags: 1 << 2,
			cullKey: SOLID_CULL_KEY,
		});
	});

	it("keys a see-through block by its id: its sides hide the same block only", async () => {
		const wmb = builder(models);
		expect(await wmb.computeCulling("minecraft:glass")).toEqual({
			occlusionFlags: 63,
			cullKey: "minecraft:glass",
		});
		// slime's texture is translucent: it counted as solid, and stone beside it lost its face
		expect(await wmb.computeCulling("minecraft:slime_block")).toEqual({
			occlusionFlags: 63,
			cullKey: "minecraft:slime_block",
		});
	});

	it("lets leaves and fluids hide nothing by their shape", async () => {
		const wmb = builder(models);
		expect((await wmb.computeCulling("minecraft:oak_leaves[persistent=true]")).occlusionFlags).toBe(
			0
		);
		expect((await wmb.computeCulling("minecraft:water[level=0]")).occlusionFlags).toBe(0);
		expect((await wmb.computeCulling("minecraft:lava[level=0]")).occlusionFlags).toBe(0);
	});
});

describe("a block's render category and fluid", () => {
	const wmb = Object.create(WorldMeshBuilder.prototype) as any;

	it("takes only water and lava themselves for fluids, not blocks named after them", () => {
		expect(wmb.getBlockCategory("minecraft:water")).toBe("water");
		expect(wmb.getBlockCategory("minecraft:lava")).toBe("water");
		expect(wmb.getBlockCategory("minecraft:water_cauldron")).toBe("solid");
		expect(wmb.getBlockCategory("minecraft:lava_cauldron")).toBe("solid");
		expect(wmb.fluidOf("minecraft:water_cauldron")).toBe(FLUID_NONE);
		expect(wmb.fluidOf("minecraft:water")).toBe(FLUID_WATER);
		expect(wmb.fluidOf("minecraft:lava")).toBe(FLUID_LAVA);
	});

	it("reads a palette name without a namespace as the game's", () => {
		expect(wmb.getBlockCategory("water")).toBe("water");
		expect(wmb.fluidOf("water")).toBe(FLUID_WATER);
		expect(wmb.fluidOf("lava")).toBe(FLUID_LAVA);
		expect(wmb.getBlockCategory("stone")).toBe("solid");
	});

	it("gives a waterlogged block water to cull against water", () => {
		expect(wmb.fluidOf("minecraft:oak_slab", { type: "bottom", waterlogged: "true" })).toBe(
			FLUID_WATER
		);
		expect(wmb.fluidOf("minecraft:oak_slab", { type: "bottom", waterlogged: "false" })).toBe(
			FLUID_NONE
		);
		expect(wmb.fluidOf("minecraft:kelp")).toBe(FLUID_WATER);
	});

	it("takes glass, ice and leaves as words of the id", () => {
		for (const id of [
			"minecraft:glass",
			"minecraft:red_stained_glass",
			"minecraft:glass_pane",
			"minecraft:packed_ice",
			"minecraft:ice",
			"minecraft:oak_leaves",
			"wilderwild:baobab_leaves",
		])
			expect(wmb.getBlockCategory(id)).toBe("transparent");
		// "ice" inside a word is not ice
		for (const id of ["farmersdelight:rice_bag", "minecraft:spruce_slice", "mod:dice"])
			expect(wmb.getBlockCategory(id)).toBe("solid");
	});
});
