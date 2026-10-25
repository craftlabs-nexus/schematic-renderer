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

// Blocks with connected textures (Fusion) have no palette geometry: every build path has to draw them per position
// (buildConnectedBlockMeshes). The chunked paths did; the instanced one and getChunkGeometries drew nothing.
function builder() {
	const wmb = Object.create(WorldMeshBuilder.prototype) as any;
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
