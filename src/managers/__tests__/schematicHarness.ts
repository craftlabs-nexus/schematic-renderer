import * as THREE from "three";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { SchematicObject } from "../SchematicObject";

// A SchematicObject on the real schematic library (the package's module is mocked for every test: src/test/setup.ts)
// with the mesher stood in for, for tests of its builds: what each chunk is meshed with, what the build adds, what a
// filter does to it. Call loadNucleation() in a beforeAll first.

let Nucleation: any;

/** Loads the schematic library's WASM (once per test file). */
export async function loadNucleation(): Promise<void> {
	if (Nucleation) return;
	const root = resolve(process.cwd(), "node_modules/nucleation");
	Nucleation = await import(pathToFileURL(resolve(root, "nucleation-original.js")).href);
	Nucleation.initSync({ module: readFileSync(resolve(root, "nucleation_bg.wasm")) });
}

/**
 * A schematic of `blocks`, not built yet, built in `mode` (SchematicRendererOptions.meshBuildingMode) by a mesher that
 * meshes nothing: `meshed` records what getChunkMesh is asked, `capsAsked` the caps buildCaps is asked for. Its
 * worldMeshBuilder's methods can be replaced to return meshes.
 */
export function schematicFor(
	blocks: Array<[number, number, number, string]>,
	mode: "incremental" | "batched" | "immediate" = "batched"
) {
	const wrapper = new Nucleation.SchematicWrapper();
	for (const [x, y, z, block] of blocks) wrapper.set_block(x, y, z, block);
	const meshed: any[] = [];
	const capsAsked: number[][] = [];
	const renderer: any = {
		options: { meshBuildingMode: mode, callbacks: {} },
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
		built: false,
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
			processChunksBatched: async () => [],
			buildSignMeshes: async () => [],
			getPaletteStats: () => ({ paletteSize: 1, memoryEstimate: 0 }),
			buildCaps: async (pieces: Array<{ blocks: Int32Array }>) => {
				capsAsked.push(...pieces.map((p) => Array.from(p.blocks)));
				return [];
			},
			getChunkMesh: async (chunk: any) => {
				meshed.push(chunk);
				return [];
			},
		},
	});
	return { so, wrapper, meshed, capsAsked, renderer };
}

/** Builds the schematic as loading it does, and waits for the build. */
export async function build(so: any): Promise<void> {
	so.meshesReady = so.track(so.buildMeshes());
	await so.meshesReady;
}
