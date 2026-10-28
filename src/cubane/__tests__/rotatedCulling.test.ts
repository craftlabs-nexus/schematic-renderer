import { describe, it, expect } from "vitest";
import { Cubane } from "../Cubane";
import type { BlockModel, OptimizedFace } from "../types";

// Cubane.getBlockOptimizationData for a block whose blockstate turns its model: the culling faces
// are keyed by the world side they end up on, and their bounds are turned with them, so the mesh
// builder does not take an upside-down stair's slab (its top) for a full bottom.
// BlockMeshBuilder.createOptimizedFaceData is replaced by a stand-in that keys each face by its
// model cullface with its element's box, as the real one does, without textures.
function withPack(files: Record<string, unknown>) {
	const c = new Cubane({ autoRestore: false });
	const internals = c as unknown as {
		initialized: boolean;
		assetLoader: { getResourceString: (path: string) => Promise<string | undefined> };
		blockMeshBuilder: { createOptimizedFaceData: (model: BlockModel) => Promise<unknown> };
	};
	internals.initialized = true;
	internals.assetLoader.getResourceString = async (path) =>
		path in files ? JSON.stringify(files[path]) : undefined;
	internals.blockMeshBuilder.createOptimizedFaceData = async (model) => {
		const cullableFaces = new Map<string, OptimizedFace[]>();
		for (const el of model.elements ?? []) {
			for (const [dir, face] of Object.entries(el.faces ?? {})) {
				if (!face?.cullface) continue;
				const list = cullableFaces.get(face.cullface) ?? [];
				list.push({
					direction: dir,
					cullface: face.cullface,
					elementBounds: [el.from, el.to],
				} as unknown as OptimizedFace);
				cullableFaces.set(face.cullface, list);
			}
		}
		return { cullableFaces, nonCullableFaces: [], hasTransparency: false };
	};
	return c;
}

// vanilla's stairs model, trimmed to its two boxes: the slab below, the step on the east half above
const stairs: BlockModel = {
	textures: { all: "minecraft:block/stone_bricks" },
	elements: [
		{
			from: [0, 0, 0],
			to: [16, 8, 16],
			faces: {
				down: { texture: "#all", cullface: "down" },
				up: { texture: "#all" },
				north: { texture: "#all", cullface: "north" },
				south: { texture: "#all", cullface: "south" },
				west: { texture: "#all", cullface: "west" },
				east: { texture: "#all", cullface: "east" },
			},
		},
		{
			from: [8, 8, 0],
			to: [16, 16, 16],
			faces: {
				up: { texture: "#all", cullface: "up" },
				north: { texture: "#all", cullface: "north" },
				south: { texture: "#all", cullface: "south" },
				west: { texture: "#all" },
				east: { texture: "#all", cullface: "east" },
			},
		},
	],
} as BlockModel;

const pack = {
	"blockstates/minecraft:stone_brick_stairs.json": {
		variants: {
			"facing=east,half=bottom,shape=straight": { model: "minecraft:block/stone_brick_stairs" },
			"facing=east,half=top,shape=straight": {
				model: "minecraft:block/stone_brick_stairs",
				x: 180,
				uvlock: true,
			},
			"facing=south,half=bottom,shape=straight": {
				model: "minecraft:block/stone_brick_stairs",
				y: 90,
				uvlock: true,
			},
		},
	},
	"models/minecraft:block/stone_brick_stairs.json": stairs,
};

// the sides whose culling faces cover the whole side, as WorldMeshBuilder.computeFullSides reads them
function fullSides(faces: Map<string, OptimizedFace[]>): string[] {
	const axes: Record<string, [number, number]> = {
		up: [0, 2],
		down: [0, 2],
		north: [0, 1],
		south: [0, 1],
		west: [1, 2],
		east: [1, 2],
	};
	return [...faces]
		.filter(([dir, list]) =>
			list.some(({ elementBounds: [lo, hi] }) => axes[dir].every((a) => hi[a] - lo[a] > 15.9))
		)
		.map(([dir]) => dir)
		.sort();
}

describe("culling faces of a turned model", () => {
	it("a bottom-half stair is full below", async () => {
		const data = await withPack(pack).getBlockOptimizationData(
			"minecraft:stone_brick_stairs[facing=east,half=bottom,shape=straight]",
			"plains",
			false
		);
		expect(fullSides(data.cullableFaces)).toEqual(["down"]);
	});

	it("an upside-down stair is full above, not below", async () => {
		const data = await withPack(pack).getBlockOptimizationData(
			"minecraft:stone_brick_stairs[facing=east,half=top,shape=straight]",
			"plains",
			false
		);
		expect(fullSides(data.cullableFaces)).toEqual(["up"]);
		// the step's top lands below, on the east half only
		const [lo, hi] = data.cullableFaces.get("down")![0].elementBounds;
		expect([lo, hi]).toEqual([
			[8, 0, 0],
			[16, 8, 16],
		]);
	});

	it("a turned stair keeps its step's sides on the turned sides", async () => {
		const data = await withPack(pack).getBlockOptimizationData(
			"minecraft:stone_brick_stairs[facing=south,half=bottom,shape=straight]",
			"plains",
			false
		);
		// y=90 takes the model's east (the step's back) to the south, and its west (the slab's
		// alone, the step leaves it open) to the north
		expect(data.cullableFaces.get("south")!.length).toBe(2);
		expect(data.cullableFaces.get("north")!.length).toBe(1);
		expect(fullSides(data.cullableFaces)).toEqual(["down"]);
	});
});
