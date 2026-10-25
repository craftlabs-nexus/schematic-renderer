import { describe, it, expect, beforeAll, vi } from "vitest";
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
		chunkRebuilds: new Map(),
		buildGeneration: 0,
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

describe("a chunk remeshed as the schematic is removed", () => {
	it("lets go of what came back, and adds nothing to the removed schematic", async () => {
		const { so } = setup([[5, 5, 5, "minecraft:stone"]]);
		Object.assign(so, { shownCaps: [], capsCache: new Map(), ownsWrapper: false });
		const made = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
		const dispose = vi.spyOn(made.geometry, "dispose");
		so.worldMeshBuilder.getChunkMesh = async () => {
			so.dispose();
			return [made];
		};
		await so.rebuildChunk(0, 0, 0);
		expect(dispose).toHaveBeenCalled();
		expect(so.group.children).toEqual([]);
		expect(so.chunkMeshes.size).toBe(0);
	});
});

describe("two rebuilds of one chunk in flight at once", () => {
	it("leave the chunk drawn once, by the later", async () => {
		const { so } = setup([[5, 5, 5, "minecraft:stone"]]);
		const answers: Array<() => void> = [];
		const made: THREE.Mesh[] = [];
		so.worldMeshBuilder.getChunkMesh = () =>
			new Promise((res) => {
				const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
				made.push(mesh);
				answers.push(() => res([mesh]));
			});
		// the second asked for while the first is meshed (an edit on each side of a seam remeshes both chunks)
		const first = so.rebuildChunk(0, 0, 0);
		await vi.waitFor(() => expect(answers).toHaveLength(1));
		const second = so.rebuildChunk(0, 0, 0);
		await vi.waitFor(() => expect(answers).toHaveLength(2));
		const disposeFirst = vi.spyOn(made[0].geometry, "dispose");
		answers[1]();
		answers[0]();
		await Promise.all([first, second]);
		expect(so.group.children).toEqual([made[1]]);
		expect(so.chunkMeshes.get("0,0,0")).toEqual([made[1]]);
		expect(disposeFirst).toHaveBeenCalled();
	});
});

describe("a chunk remeshed while a filter shows", () => {
	it("adds its objects of the cells the filter hides hidden, before the caps of the edit are built", async () => {
		const { so } = setup([[5, 5, 5, "minecraft:stone"]]);
		so.cellFilter = { range: { minY: 0, maxY: 4 }, hidden: null };
		const above = new THREE.Group(); // a block entity's objects at y 5
		above.userData.layerY = 5;
		const below = new THREE.Group();
		below.userData.layerY = 2;
		so.worldMeshBuilder.getChunkMesh = async () => [above, below];
		const shownWhenAdded = new Map<THREE.Object3D, boolean>();
		const add = so.group.add.bind(so.group);
		so.group.add = (obj: THREE.Object3D) => {
			shownWhenAdded.set(obj, obj.visible);
			return add(obj);
		};
		so.setCellFilter = async () => true; // the caps of the edit: not looked at here
		await so.rebuildChunk(0, 0, 0);
		expect([shownWhenAdded.get(above), shownWhenAdded.get(below)]).toEqual([false, true]);
	});
});

describe("an edit of a block", () => {
	const chunksOf = (meshed: any[]) =>
		meshed.map((c) => `${c.chunk_x},${c.chunk_y},${c.chunk_z}`).sort();

	it("outside the schematic's box as it was made remeshes its chunk, the rendering bounds being off", async () => {
		const { so, meshed } = setup([[5, 5, 5, "minecraft:stone"]]);
		await so.setBlock([70, 5, 5], "minecraft:stone");
		await so.setBlock([-3, 5, 5], "minecraft:stone");
		expect(chunksOf(meshed)).toEqual(["-1,0,0", "4,0,0"]);
	});

	it("inside its chunk remeshes only that chunk", async () => {
		const { so, meshed } = setup([[5, 5, 5, "minecraft:stone"]]);
		await so.setBlock([5, 6, 5], "minecraft:stone");
		expect(chunksOf(meshed)).toEqual(["0,0,0"]);
	});

	it("on a face of its chunk remeshes the neighbour across it, which no longer culls against it", async () => {
		const { so, meshed } = setup([
			[15, 3, 4, "minecraft:stone"],
			[16, 3, 4, "minecraft:stone"],
		]);
		await so.setBlock([15, 3, 4], "minecraft:air");
		expect(chunksOf(meshed)).toEqual(["0,0,0", "1,0,0"]);
		const neighbour = meshed.find((c) => c.chunk_x === 1);
		expect(blocksOf(neighbour.apronBlocks)).toEqual([]);
	});

	it("on an edge or corner remeshes the neighbour across each face it is on, in a batch of edits too", async () => {
		const { so, meshed } = setup([[0, 0, 0, "minecraft:stone"]]);
		await so.setBlocks([
			[[16, 31, 47], "minecraft:stone"],
			[[20, 20, 40], "minecraft:stone"],
		]);
		expect(chunksOf(meshed)).toEqual(["0,1,2", "1,1,2", "1,1,3", "1,2,2"]);
	});
});
