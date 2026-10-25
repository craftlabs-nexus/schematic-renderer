import { describe, it, expect, vi } from "vitest";

vi.mock("nucleation", () => ({ default: vi.fn(), SchematicWrapper: class {} }));

import { SchematicObject } from "../SchematicObject";

describe("SchematicObject.getAllBlocks", () => {
	it("gives each block's state key as a block string, its properties sorted", () => {
		const so = Object.create(SchematicObject.prototype) as any;
		Object.assign(so, {
			_cachedDimensions: [1, 1, 1],
			chunkDimensions: { chunkWidth: 16, chunkHeight: 16, chunkLength: 16 },
			schematicWrapper: {
				get_block: () => "minecraft:oak_stairs",
				get_block_with_properties: () => ({ properties: { half: "top", facing: "east" } }),
			},
		});
		expect(so.getAllBlocks().map((b: { stateKey: string }) => b.stateKey)).toEqual([
			"minecraft:oak_stairs[facing=east,half=top]",
		]);
	});
});
