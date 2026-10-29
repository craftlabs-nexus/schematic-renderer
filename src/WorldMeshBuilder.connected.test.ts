import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

// The same stand-ins as WorldMeshBuilder.test.ts, so the module loads without WASM, workers or a renderer.
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
import { MaterialRegistry } from "./MaterialRegistry";

// Blocks with connected textures (Fusion) have no palette geometry: every build path has to draw them per position
// (buildConnectedBlockMeshes). The chunked paths did; the instanced one and getChunkGeometries drew nothing.
function builder() {
	const wmb = Object.create(WorldMeshBuilder.prototype) as any;
	Object.assign(wmb, { palettes: new Map(), schematicPalettes: new WeakMap() });
	const calls: number[][][] = [];
	wmb.connectingPalette = new Set([1]); // palette index 1 connects (glass, say); 0 does not
	wmb.paletteCache = { isReady: true, palette: [], blockData: [] };
	wmb.buildConnectedBlockMeshes = async (blocks: Int32Array | number[][]) => {
		const list =
			blocks instanceof Int32Array
				? Array.from({ length: blocks.length / 4 }, (_, i) =>
						Array.from(blocks.slice(i * 4, i * 4 + 4))
					)
				: blocks;
		calls.push(list);
		return list
			.filter((b) => b[3] === 1)
			.map(() => new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()));
	};
	return { wmb, calls };
}

describe("connected-texture blocks outside the chunked paths", () => {
	it("are drawn by an instanced render, and replaced by the next one", async () => {
		const { wmb, calls } = builder();
		const group = new THREE.Group();
		const instanced: unknown[] = [];
		wmb.useInstancedRendering = true;
		wmb.instancedRenderer = {
			renderBlocksInstanced: (blocks: unknown[]) => instanced.push(...blocks),
		};
		const schematicObject = {
			group,
			renderingBounds: { enabled: false },
			schematicWrapper: {
				blocks_indices: () => [
					[0, 0, 0, 0],
					[1, 0, 0, 1],
					[2, 0, 0, 1],
				],
			},
		};
		await wmb.renderSchematicInstanced(schematicObject);
		expect(instanced).toHaveLength(3);
		expect(calls).toEqual([
			[
				[1, 0, 0, 1],
				[2, 0, 0, 1],
			],
		]);
		expect(group.children.filter((c) => c.userData.connectedBlocks)).toHaveLength(2);
		await wmb.renderSchematicInstanced(schematicObject);
		expect(group.children.filter((c) => c.userData.connectedBlocks)).toHaveLength(2);
	});

	it("come back from getChunkGeometries as connectedMeshes when the schematic is given", async () => {
		const { wmb } = builder();
		wmb.chunkSize = 16;
		wmb.useGPUCompute = true;
		wmb.computeMeshBuilder = {
			isReady: true,
			buildChunk: async () => ({ geometries: [], origin: [0, 0, 0] }),
		};
		const chunk = {
			blocks: new Int32Array([0, 0, 0, 0, 1, 0, 0, 1]),
			chunk_x: 0,
			chunk_y: 0,
			chunk_z: 0,
		};
		const withSchematic = await wmb.getChunkGeometries(chunk, undefined, {
			group: new THREE.Group(),
		});
		expect(withSchematic.connectedMeshes).toHaveLength(1);
		const without = await wmb.getChunkGeometries(chunk);
		expect(without.connectedMeshes).toEqual([]);
	});
});

describe("merging connected-texture meshes", () => {
	it("takes one registry reference per material a merged mesh holds, and keeps the layer index", () => {
		// a registry that shares materials by name and counts references
		const shared = new Map<string, THREE.Material>();
		const refs = new Map<THREE.Material, number>();
		vi.mocked(MaterialRegistry.getMaterial).mockImplementation((source) => {
			let material = shared.get(source.name);
			if (!material) shared.set(source.name, (material = source.clone()));
			refs.set(material, (refs.get(material) ?? 0) + 1);
			return material;
		});
		vi.mocked(MaterialRegistry.peekMaterial).mockImplementation((source) =>
			shared.get(source.name)
		);

		const glass = Object.assign(new THREE.MeshBasicMaterial(), { name: "glass" });
		const glassAgain = Object.assign(new THREE.MeshBasicMaterial(), { name: "glass" }); // another block's
		const block = (material: THREE.Material, y: number) => {
			const object = new THREE.Group();
			object.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
			object.position.set(0, y, 0);
			return object;
		};
		const built = [
			...[0, 1, 2, 3].map((y) => ({
				object: block(y === 2 ? glassAgain : glass, y),
				category: "transparent",
				layer: y,
				group: 0,
			})),
			{ object: block(glass, 4), category: "water", layer: 4, group: 0 },
		];
		const wmb = Object.create(WorldMeshBuilder.prototype) as any;
		Object.assign(wmb, { palettes: new Map(), schematicPalettes: new WeakMap() });
		const out: THREE.Mesh[] = wmb.mergeConnectedMeshes(built);

		expect(out.map((m) => m.name).sort()).toEqual(["connected_transparent", "connected_water"]);
		const material = shared.get("glass") as THREE.Material;
		for (const mesh of out) {
			expect(mesh.material).toHaveLength(1);
			expect((mesh.material as THREE.Material[])[0]).toBe(material);
		}
		expect(refs.get(material)).toBe(2); // one per merged mesh, released when each is disposed

		const transparent = out.find((m) => m.name === "connected_transparent") as THREE.Mesh;
		expect(transparent.geometry.userData.layerIndex.groups).toHaveLength(1);
		expect(transparent.geometry.groups).toHaveLength(1);
		expect(transparent.geometry.index?.count).toBe(4 * 36); // four boxes, layers 0 to 3
	});
});

describe("connected-texture blocks made again for a cell filter", () => {
	it("see the cells the filter hides as air, and read the rest from the schematic", async () => {
		const wmb = Object.create(WorldMeshBuilder.prototype) as any;
		Object.assign(wmb, { palettes: new Map(), schematicPalettes: new WeakMap() });
		wmb.connectingPalette = new Set([1]);
		wmb.paletteCache = {
			isReady: true,
			palette: [{ name: "minecraft:stone" }, { name: "minecraft:glass" }],
			blockData: [],
		};
		const seen: unknown[] = [];
		wmb.cubane = {
			getConnectedBlockMesh: async (_block: string, _biome: string, neighborAt: any) => {
				seen.push(neighborAt(0, 1, 0), neighborAt(1, 0, 0));
				return null;
			},
		};
		const read = vi.fn(() => ({ name: () => "minecraft:glass", properties: () => ({}) }));
		const schematicObject = {
			schematicWrapper: { get_block_with_properties: read },
			cellGroupAt: () => 0,
		};
		const hiddenAt = (x: number, y: number, z: number) => x === 0 && y === 1 && z === 0;
		await wmb.buildConnectedMeshes([[0, 0, 0, 1]], schematicObject, hiddenAt);
		expect(seen).toEqual([null, { name: "minecraft:glass", properties: {} }]);
		expect(read).toHaveBeenCalledTimes(1); // the hidden cell is not read
	});
});

describe("a connected-texture mesh of several materials", () => {
	it("is kept with its own geometry, not the cached block's", () => {
		const wmb = Object.create(WorldMeshBuilder.prototype) as any;
		Object.assign(wmb, { palettes: new Map(), schematicPalettes: new WeakMap() });
		// a block from Cubane's cache: a mesh of two materials, its geometry the cache's
		const cachedGeometry = new THREE.BoxGeometry();
		const block = new THREE.Group();
		block.add(
			new THREE.Mesh(cachedGeometry, [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()])
		);
		const [kept] = wmb.mergeConnectedMeshes([
			{ object: block, category: "solid", layer: 0, group: 0 },
		]);
		// disposing it disposed the cached block's geometry under the cache
		expect((kept as THREE.Mesh).geometry).not.toBe(cachedGeometry);
	});
});
