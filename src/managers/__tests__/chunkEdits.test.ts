import { describe, it, expect, beforeAll } from "vitest";
import * as THREE from "three";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { SchematicObject } from "../SchematicObject";

// Block edits remeshing their chunk, on the real schematic library (the package's module is mocked for every test:
// src/test/setup.ts) with the mesher stood in for: what each chunk is meshed with is what the tests look at.
let Nucleation: any;
beforeAll(async () => {
	const root = resolve(process.cwd(), "node_modules/nucleation");
	Nucleation = await import(pathToFileURL(resolve(root, "nucleation-original.js")).href);
	Nucleation.initSync({ module: readFileSync(resolve(root, "nucleation_bg.wasm")) });
});

/** A schematic of `blocks` built in chunks of 16, whose chunk rebuilds are recorded. */
function setup(blocks: Array<[number, number, number, string]>) {
	const wrapper = new Nucleation.SchematicWrapper();
	for (const [x, y, z, block] of blocks) wrapper.set_block(x, y, z, block);
	const meshed: any[] = [];
	const renderer: any = { options: {}, invalidate() {} };
	const so = Object.create(SchematicObject.prototype) as any;
	Object.assign(so, {
		fadedMaterials: new Map(),
		baseMaterials: new WeakMap(),
		id: "s",
		name: "s",
		visible: true,
		disposed: false,
		unbuilt: false,
		opacity: 1,
		meshes: [],
		chunkMeshes: new Map(),
		chunkDimensions: { chunkWidth: 16, chunkHeight: 16, chunkLength: 16 },
		group: new THREE.Group(),
		renderingBounds: {
			enabled: false,
			min: new THREE.Vector3(0, 0, 0),
			max: new THREE.Vector3(64, 64, 64),
		},
		cellFilter: { range: null, hidden: null },
		wantedFilter: null,
		cellGrid: null,
		cellGridBox: null,
		builds: Promise.resolve(),
		schematicRenderer: renderer,
		schematicWrapper: wrapper,
		worldMeshBuilder: {
			precomputePaletteGeometries: async () => {},
			getChunkMesh: async (chunk: any) => {
				meshed.push(chunk);
				return [];
			},
		},
	});
	const index = (block: string) =>
		wrapper.get_all_palettes().default.findIndex((b: { name: string }) => b.name === block);
	return { so, meshed, index };
}

/** An apron's blocks as [x, y, z, paletteIndex] each. */
const blocksOf = (apron: Int32Array | undefined) => {
	const out: number[][] = [];
	for (let i = 0; apron && i < apron.length; i += 4) out.push(Array.from(apron.subarray(i, i + 4)));
	return out;
};

describe("a chunk remeshed after an edit", () => {
	it("is meshed with its neighbours' blocks against its faces, as in a full build", async () => {
		const { so, meshed, index } = setup([
			[15, 0, 0, "minecraft:stone"], // chunk 0,0,0, against chunk 1,0,0
			[14, 0, 0, "minecraft:stone"], // chunk 0,0,0, a block in from the seam
			[16, 0, 0, "minecraft:water"], // chunk 1,0,0
			[20, 16, 3, "minecraft:glass"], // chunk 1,1,0, against chunk 1,0,0
		]);
		await so.rebuildChunk(1, 0, 0);
		expect(meshed).toHaveLength(1);
		const stone = index("minecraft:stone"),
			glass = index("minecraft:glass");
		expect(blocksOf(meshed[0].apronBlocks)).toEqual([
			[15, 0, 0, stone],
			[20, 16, 3, glass],
		]);
	});

	it("leaves out the neighbours' blocks outside the rendering bounds", async () => {
		const { so, meshed, index } = setup([
			[15, 0, 0, "minecraft:stone"],
			[15, 9, 0, "minecraft:stone"],
			[16, 0, 0, "minecraft:water"],
		]);
		so.renderingBounds.enabled = true;
		so.renderingBounds.max.set(64, 8, 64);
		await so.rebuildChunk(1, 0, 0);
		expect(blocksOf(meshed[0].apronBlocks)).toEqual([[15, 0, 0, index("minecraft:stone")]]);
	});
});
