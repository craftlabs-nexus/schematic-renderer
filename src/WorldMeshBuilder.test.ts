import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

// Mock problematic imports BEFORE they are used/imported by other modules
vi.mock("./wasm/minecraft_schematic_utils_bg.wasm", () => ({
	default: "mock-utils-wasm",
}));
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

// Mock dependencies
vi.mock("./SchematicRenderer");
vi.mock("./cubane", () => {
	return {
		Cubane: class MockCubane {
			getBlockMesh = vi
				.fn()
				.mockResolvedValue(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
			getBlockOptimizationData = vi.fn().mockResolvedValue({
				cullableFaces: new Map(),
				nonCullableFaces: [],
				hasTransparency: false,
			});
		},
	};
});
vi.mock("./managers/SchematicObject");
vi.mock("./MaterialRegistry");
vi.mock("./InstancedBlockRenderer");

// The chunk size a builder meshes in. (The tests here checked constants and Math.floor, not the builder: they could
// not fail.)
describe("WorldMeshBuilder chunk size", () => {
	it("takes a size from 1 to 64, and refuses one outside", async () => {
		const { WorldMeshBuilder } = await import("./WorldMeshBuilder");
		const wmb = Object.create(WorldMeshBuilder.prototype) as any;
		for (const size of [1, 16, 64]) {
			wmb.setChunkSize(size);
			expect(wmb.getChunkSize()).toBe(size);
		}
		for (const size of [0, -16, 65]) expect(() => wmb.setChunkSize(size)).toThrow();
		expect(wmb.getChunkSize()).toBe(64); // a refused size leaves the last one
	});
});

describe("buildSignMeshes", () => {
	// the signs' NBT does not say how it keeps their text: the schematic's data version does
	it("hands each sign the schematic's data version with its NBT", async () => {
		const { WorldMeshBuilder } = await import("./WorldMeshBuilder");
		const nbts: any[] = [];
		const wmb = Object.create(WorldMeshBuilder.prototype) as any;
		wmb.cubane = {
			getBlockMesh: async (_block: string, _biome: string, _cache: boolean, nbt: any) => {
				nbts.push(nbt);
				return new THREE.Group();
			},
		};
		const schematic = (dataVersion: number | undefined) => ({
			getBlockEntitiesMap: () =>
				new Map([["0,0,0", { position: [0, 0, 0], nbt: { front_text: { messages: ["[1]"] } } }]]),
			schematicWrapper: {
				getSourceDataVersion: () => dataVersion,
				get_block_with_properties: () => ({
					name: () => "minecraft:oak_sign",
					properties: () => ({}),
				}),
			},
			cellGroupAt: () => 0,
		});
		await wmb.buildSignMeshes(schematic(4325));
		await wmb.buildSignMeshes(schematic(undefined));
		expect(nbts).toEqual([
			{ DataVersion: 4325, front_text: { messages: ["[1]"] } },
			{ front_text: { messages: ["[1]"] } },
		]);
	});
});

describe("the block strings a schematic's blocks are meshed by", () => {
	// sorted by key as Cubane's own (formatBlockString), so one state is one entry of Cubane's caches
	it("list a state's properties by key, from the palette and for a sign alike", async () => {
		const { WorldMeshBuilder } = await import("./WorldMeshBuilder");
		const wmb = Object.create(WorldMeshBuilder.prototype) as any;
		expect(
			wmb.createBlockStringFromPaletteEntry({
				name: "oak_stairs",
				properties: { shape: "straight", facing: "east", half: "top" },
			})
		).toBe("minecraft:oak_stairs[facing=east,half=top,shape=straight]");
		const blocks: string[] = [];
		wmb.cubane = {
			getBlockMesh: async (block: string) => {
				blocks.push(block);
				return new THREE.Group();
			},
		};
		await wmb.buildSignMeshes({
			getBlockEntitiesMap: () => new Map([["0,0,0", { position: [0, 0, 0], nbt: {} }]]),
			schematicWrapper: {
				get_block_with_properties: () => ({
					name: () => "minecraft:oak_sign",
					properties: () => ({ waterlogged: "false", rotation: "4" }),
				}),
			},
			cellGroupAt: () => 0,
		});
		expect(blocks).toEqual(["minecraft:oak_sign[rotation=4,waterlogged=false]"]);
	});
});
