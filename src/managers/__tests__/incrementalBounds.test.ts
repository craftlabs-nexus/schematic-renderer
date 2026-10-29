import { describe, it, expect, beforeAll, vi } from "vitest";
import * as THREE from "three";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { SchematicObject } from "../SchematicObject";

// An incremental build with rendering bounds, on the real schematic library, with the mesher stood in for: what each
// chunk is meshed with is what the test looks at. A chunk's apron (its neighbours, for culling the faces on its seams)
// was made from all the blocks while the chunk itself was cut to the bounds: a face beside a neighbour the bounds cut
// off was culled against a block that is not drawn, and the cut showed a hole.
let Nucleation: any;
beforeAll(async () => {
	const root = resolve(process.cwd(), "node_modules/nucleation");
	Nucleation = await import(pathToFileURL(resolve(root, "nucleation-original.js")).href);
	Nucleation.initSync({ module: readFileSync(resolve(root, "nucleation_bg.wasm")) });
});

function setup(blocks: Array<[number, number, number, string]>) {
	const wrapper = new Nucleation.SchematicWrapper();
	for (const [x, y, z, block] of blocks) wrapper.set_block(x, y, z, block);
	const meshed: any[] = [];
	const renderer: any = {
		options: { meshBuildingMode: "incremental", callbacks: {} },
		renderManager: { render() {} },
		invalidate() {},
	};
	const so = Object.create(SchematicObject.prototype) as any;
	Object.assign(so, {
		fadedMaterials: new Map(),
		baseMaterials: new WeakMap(),
		id: "s",
		name: "s",
		visible: true,
		disposed: false,
		unbuilt: false,
		ownsWrapper: true,
		chunkRebuilds: new Map(),
		buildGeneration: 0,
		opacity: 1,
		meshes: [],
		chunkMeshes: new Map(),
		chunkDimensions: { chunkWidth: 16, chunkHeight: 16, chunkLength: 16 },
		group: new THREE.Group(),
		position: new THREE.Vector3(),
		rotation: new THREE.Euler(),
		scale: new THREE.Vector3(1, 1, 1),
		renderingBounds: {
			enabled: false,
			min: new THREE.Vector3(0, 0, 0),
			max: new THREE.Vector3(64, 64, 64),
		},
		cellFilter: { range: null, hidden: null },
		wantedFilter: null,
		shownCaps: [],
		capsCache: new Map(),
		capsPending: new Map(),
		filterCall: 0,
		replacedChunks: new Set(),
		cellGrid: null,
		cellGridBox: null,
		gridVersion: 0,
		blocksVersion: 0,
		blockEntitiesMap: null,
		_propertyWatcherTimer: null,
		builds: Promise.resolve(),
		progressBuilds: 0,
		schematicRenderer: renderer,
		sceneManager: { schematicRenderer: renderer },
		eventEmitter: { emit() {} },
		schematicWrapper: wrapper,
		worldMeshBuilder: {
			precomputePaletteGeometries: async () => {},
			getPaletteSize: () => 8,
			airPaletteIndices: () => new Set<number>(),
			canBuildCaps: () => true,
			buildSignMeshes: async () => [],
			getPaletteStats: () => ({ paletteSize: 1, memoryEstimate: 0 }),
			buildCaps: async () => [],
			getChunkMesh: async (chunk: any) => {
				meshed.push(chunk);
				return [];
			},
		},
	});
	return { so, wrapper, meshed };
}

describe("an incremental build with rendering bounds", () => {
	it("culls a chunk's seam only against neighbours the bounds keep", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		// stone either side of the seam between chunks 0 and 1; the bounds end at x 16, so the second is not drawn
		const { so, meshed } = setup([
			[15, 0, 0, "minecraft:stone"],
			[16, 0, 0, "minecraft:stone"],
		]);
		so.renderingBounds = {
			enabled: true,
			min: new THREE.Vector3(0, 0, 0),
			max: new THREE.Vector3(16, 16, 16),
		};
		await so.buildSchematicMeshesIncremental(so, so.chunkDimensions);
		const chunk0 = meshed.find((c) => c.chunk_x === 0);
		expect(chunk0).toBeDefined();
		// the stone at x 16 lay in chunk 0's apron and hid the face of the stone at x 15
		expect(Array.from(chunk0.apronBlocks ?? [])).toEqual([]);
	});

	it("still culls against a neighbour the bounds keep", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { so, meshed, wrapper } = setup([
			[15, 0, 0, "minecraft:stone"],
			[16, 0, 0, "minecraft:stone"],
		]);
		so.renderingBounds = {
			enabled: true,
			min: new THREE.Vector3(0, 0, 0),
			max: new THREE.Vector3(17, 16, 16),
		};
		await so.buildSchematicMeshesIncremental(so, so.chunkDimensions);
		const chunk0 = meshed.find((c) => c.chunk_x === 0);
		const stone = wrapper
			.get_all_palettes()
			.default.findIndex((b: any) => b.name === "minecraft:stone");
		expect(Array.from(chunk0.apronBlocks ?? [])).toEqual([16, 0, 0, stone]);
	});
});
