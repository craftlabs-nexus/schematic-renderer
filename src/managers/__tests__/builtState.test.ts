import { describe, it, expect, beforeAll, vi } from "vitest";
import * as THREE from "three";
import { loadNucleation, schematicFor, build } from "./schematicHarness";

// What a schematic knows of its own build: whether it is built (an empty one is), the objects it drew (getMeshes,
// canShowLayerRange) after chunk rebuilds, and a filter only when its meshes can show one.
beforeAll(loadNucleation);

const tagged = (layerY: number) => {
	const object = new THREE.Group();
	object.userData.layerY = layerY;
	return object;
};

describe("a schematic built empty and then edited", () => {
	it("shows a layer range on the blocks it was given", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { so, meshed, capsAsked } = schematicFor([]);
		await build(so);
		// an edit: two blocks in one chunk, meshed as an object tagged with its layer each (a block entity, say)
		const at5 = tagged(5);
		const at6 = tagged(6);
		so.worldMeshBuilder.getChunkMesh = async (chunk: any) => {
			meshed.push(chunk);
			return [at5, at6];
		};
		await so.setBlocks([
			[[5, 5, 5], "minecraft:stone"],
			[[5, 6, 5], "minecraft:stone"],
		]);
		expect(so.group.children).toEqual([at5, at6]);

		expect(await so.setLayerRange({ minY: 0, maxY: 6 })).toBe(true);
		// the range was kept and reported, but nothing was hidden, no caps were made and the framing took every block
		expect(at6.visible).toBe(false);
		expect(at5.visible).toBe(true);
		expect(capsAsked.length).toBeGreaterThan(0);
		so.group.position.set(0, 0, 0);
		expect(so.getTightWorldBox().max.y).toBe(5.5); // the top of the y 5 cell (6.5 with every block)
	});
});

describe("a chunk rebuilt after a build", () => {
	it("is in the build's list of objects in place of the one it replaced", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { so } = schematicFor([[5, 5, 5, "minecraft:stone"]], "incremental");
		const first = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
		so.worldMeshBuilder.getChunkMesh = async () => [first];
		await build(so);
		expect(so.meshes).toEqual([first]);

		const second = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
		so.worldMeshBuilder.getChunkMesh = async () => [second];
		await so.setBlock([5, 6, 5], "minecraft:stone");
		expect(so.group.children).toEqual([second]);
		// the replaced mesh stayed in the list, disposed, and its replacement was missing
		expect(so.meshes).toEqual([second]);
	});
});

describe("a layer range given at load, on a build that cannot show one", () => {
	it("is dropped rather than half applied", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { so } = schematicFor([
			[5, 5, 5, "minecraft:stone"],
			[5, 6, 5, "minecraft:stone"],
		]);
		so.cellFilter = { range: { minY: 5, maxY: 6 }, hidden: null }; // as loadSchematic's layerRange sets it
		// a batch mesh without layer runs (greedy meshing, say), and an object tagged with its layer
		const plain = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
		const sign = tagged(6);
		so.worldMeshBuilder.processChunksBatched = async () => [plain, sign];
		await build(so);
		expect(so.canShowLayerRange()).toBe(false);
		// every layer of the mesh drew, while the framing, picking and the tagged objects followed the range
		expect(so.getLayerRange()).toBeNull();
		expect(sign.visible).toBe(true);
		so.group.position.set(0, 0, 0);
		expect(so.getTightWorldBox().max.y).toBe(6.5); // every block (5.5 when the range was half applied)
		expect(warn).toHaveBeenCalled();
	});
});

describe("an instanced build", () => {
	it("returns only the meshes it added, not the group's other objects", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { so } = schematicFor([[0, 0, 0, "minecraft:stone"]]);
		const region = new THREE.Group(); // a region's highlight, the bounds helper, a later build's mesh
		so.group.add(region);
		const instanced = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
		Object.assign(so.worldMeshBuilder, {
			enableInstancedRendering() {},
			renderSchematicInstanced: async () => void so.group.add(instanced),
		});
		const { meshes } = await so.buildSchematicMeshesInstanced(so);
		// every child of the group came back, and a build stopped meanwhile disposed them all
		expect(meshes).toEqual([instanced]);
	});
});

describe("a layer range with an end left out", () => {
	it("takes the missing end for the schematic's", () => {
		const { so } = schematicFor([
			[0, 0, 0, "minecraft:stone"],
			[0, 9, 0, "minecraft:stone"],
		]);
		// a JavaScript caller's range: its missing minY was NaN, and the range hid every cell
		expect(so.layerRangeOf({ maxY: 5 })).toEqual({ minY: 0, maxY: 5 });
		// as an end left open by Infinity, which worked: the top of the schematic's box
		expect(so.layerRangeOf({ minY: 3, maxY: undefined })).toEqual(
			so.layerRangeOf({ minY: 3, maxY: Infinity })
		);
		expect(so.layerRangeOf({ minY: -Infinity, maxY: NaN })).toBeNull();
	});
});

describe("a batched build with a mesher that takes no batch", () => {
	it("builds incrementally instead of waiting for good", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { so, meshed } = schematicFor([[0, 0, 0, "minecraft:stone"]], "batched");
		const batched = vi.fn(async () => []);
		Object.assign(so.worldMeshBuilder, {
			canBuildBatched: () => false, // the JavaScript mesher
			processChunksBatched: batched,
		});
		await build(so);
		expect(batched).not.toHaveBeenCalled();
		expect(meshed).toHaveLength(1);
		expect(warn).toHaveBeenCalled();
	});
});

describe("whether a cell is drawn", () => {
	it("leaves out a block the rendering bounds cut off, as the camera's near plane needs", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { so } = schematicFor(
			[
				[1, 0, 0, "minecraft:stone"],
				[20, 0, 0, "minecraft:stone"],
			],
			"incremental"
		);
		so.renderingBounds = {
			enabled: true,
			min: new THREE.Vector3(0, 0, 0),
			max: new THREE.Vector3(16, 16, 16),
		};
		// before the build, read from the schematic
		expect(so.isCellDrawn(1, 0, 0)).toBe(true);
		expect(so.isCellDrawn(20, 0, 0)).toBe(false);
		await build(so);
		// after it, from the cell grid
		expect(so.isCellDrawn(1, 0, 0)).toBe(true);
		expect(so.isCellDrawn(20, 0, 0)).toBe(false);
		expect(so.isCellDrawn(2, 0, 0)).toBe(false); // air
	});
});
