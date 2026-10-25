import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

vi.mock("nucleation", () => ({ default: vi.fn(), SchematicWrapper: class {} }));

import { SchematicObject } from "../SchematicObject";

// A schematic's opacity on a stand-in drawing water (its material at 0.8) and stone with materials it shares with
// another schematic, as the palette's are.
function setup() {
	const water = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8 });
	const stone = new THREE.MeshBasicMaterial();
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(), [stone, water]);
	const so = Object.create(SchematicObject.prototype) as any;
	Object.assign(so, {
		opacity: 1,
		visible: true,
		group: new THREE.Group(),
		fadedMaterials: new Map(),
		baseMaterials: new WeakMap(),
		schematicRenderer: { invalidate() {} },
		eventEmitter: { emit() {} },
	});
	so.group.add(mesh);
	return { so, mesh, water, stone };
}

describe("a schematic's opacity", () => {
	it("multiplies each material's own, with copies, and leaves the shared materials alone", () => {
		const { so, mesh, water, stone } = setup();
		so.opacity = 0.5;
		so.updateMeshMaterials("opacity");
		const [fadedStone, fadedWater] = mesh.material as THREE.Material[];
		expect([fadedStone.opacity, fadedWater.opacity]).toEqual([0.5, 0.4]);
		expect(fadedStone.transparent).toBe(true);
		expect([stone.opacity, water.opacity, stone.transparent]).toEqual([1, 0.8, false]);

		// a mesh added while faded is faded too
		const added = new THREE.Mesh(new THREE.BoxGeometry(), water);
		so.applyPropertiesToObjects([added]);
		expect((added.material as THREE.Material).opacity).toBeCloseTo(0.4);

		const dispose = vi.spyOn(fadedWater, "dispose");
		so.opacity = 1;
		so.updateMeshMaterials("opacity");
		expect(mesh.material).toEqual([stone, water]);
		expect(water.opacity).toBe(0.8);
		expect(dispose).toHaveBeenCalled();
	});
});

describe("a schematic rebuilt while faded", () => {
	it("keeps its regions faded", async () => {
		const { so, water } = setup();
		const region = new THREE.Mesh(new THREE.BoxGeometry(), water);
		region.name = "region_s_a";
		so.group.add(region);
		so.opacity = 0.5;
		so.updateMeshMaterials("opacity");
		Object.assign(so, {
			disposed: false,
			visible: false, // the old meshes go; nothing is built again
			meshes: [],
			chunkMeshes: new Map(),
			shownCaps: [],
			capsCache: new Map(),
			filterCall: 0,
			blocksVersion: 0,
			progressBuilds: 0,
			builds: Promise.resolve(),
			sceneManager: { schematicRenderer: { options: {} } },
		});
		so.schematicRenderer.options = {};
		await so.rebuildMesh();
		expect(so.group.children).toEqual([region]);
		expect((region.material as THREE.Material).opacity).toBeCloseTo(0.4);
	});
});
