import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

vi.mock("nucleation", () => ({ default: vi.fn(), SchematicWrapper: class {} }));

import { SchematicObject } from "../SchematicObject";
import { sortByLayer } from "../../utils/layerRange";

// SchematicObject's cell filter on a stand-in: a schematic 3 × 3 × 1 (x, y, z) with a column of three blocks at x 0
// (group 0) and one block at (1, 0, 0) in cell group 7. Its merged mesh has a run for each; a sign hangs on (1, 0, 0);
// the mesh builder records the pieces it is asked to cap and makes a cap for each call.
function setup({ indexed = true } = {}) {
	// [layer, group, start, count]: (x 0, y 0), (1, 0) in group 7, (0, 1), (0, 2): material 0, three indices each
	const sorted = sortByLayer(
		Uint32Array.from({ length: 12 }, (_, i) => i),
		[{ start: 0, count: 12, materialIndex: 0 }],
		[0, 0, 0, 3, 0, 7, 3, 3, 1, 0, 6, 3, 2, 0, 9, 3]
	);
	const geometry = new THREE.BufferGeometry();
	geometry.setIndex(new THREE.BufferAttribute(sorted.indices, 1));
	for (const g of sorted.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
	if (indexed) geometry.userData.layerIndex = sorted.layerIndex;
	const mesh = new THREE.Mesh(geometry, [new THREE.MeshBasicMaterial()]);
	const sign = new THREE.Group();
	Object.assign(sign.userData, { layerY: 0, cellGroup: 7 });
	sign.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));

	const box = { min: [0, 0, 0], max: [2, 2, 0] };
	// Sponge order over the box: (y * 1 + z) * 3 + x; palette index + 1 (stone is palette 4)
	const grid = new Uint16Array(9);
	const groups = new Uint16Array(9);
	for (const [x, y] of [
		[0, 0],
		[1, 0],
		[0, 1],
		[0, 2],
	])
		grid[y * 3 + x] = 5;
	groups[1] = 7;

	const asked: Array<{ blocks: number[]; apron: number[]; cellGroups: number[] }> = [];
	const so = Object.create(SchematicObject.prototype) as any;
	Object.assign(so, {
		fadedMaterials: new Map(),
		baseMaterials: new WeakMap(),
		visible: true,
		meshes: [mesh, sign],
		group: new THREE.Group(),
		blocksVersion: 0,
		cellFilter: { range: null, hidden: null },
		shownCaps: [],
		capsCache: new Map(),
		filterCall: 0,
		cellGroupData: groups,
		cellGroupBox: box,
		groupCells: null,
		cellGrid: grid,
		cellGridBox: box,
		shownBoxCache: null,
		schematicWrapper: { get_bounding_box: () => box },
		worldMeshBuilder: {
			canBuildCaps: () => true,
			buildCaps: async (pieces: any[]) => {
				for (const p of pieces)
					asked.push({
						blocks: Array.from(p.blocks),
						apron: Array.from(p.apron),
						cellGroups: Array.from(p.cellGroups),
					});
				const cap = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
				cap.name = `cap ${asked.length}`;
				return pieces.length ? [cap] : [];
			},
		},
		schematicRenderer: { renderManager: { render() {} } },
		eventEmitter: { emit() {} },
		applyPropertiesToObjects() {},
	});
	so.group.add(mesh, sign);
	const caps = () =>
		so.group.children
			.filter((c: THREE.Object3D) => c.userData.layerCap)
			.map((c: THREE.Object3D) => c.name);
	return { so, mesh, sign, caps, asked };
}

describe("SchematicObject.setLayerRange and setHiddenGroups", () => {
	it("draws the layers of a range and caps the cells under the layers left out", async () => {
		const { so, mesh, sign, caps, asked } = setup();
		expect(await so.setLayerRange({ minY: 0, maxY: 2 })).toBe(true);
		expect(mesh.geometry.groups).toEqual([{ start: 0, count: 9, materialIndex: 0 }]);
		expect(sign.visible).toBe(true);
		// (0, 1) is shown under the hidden (0, 2): its top face is a cap
		expect(asked).toEqual([{ blocks: [0, 1, 0, 4], apron: [0, 2, 0, 4], cellGroups: [0] }]);
		expect(caps()).toEqual(["cap 1"]);
	});

	it("hides a cell group's runs and objects, and caps its neighbours", async () => {
		const { so, mesh, sign, asked } = setup();
		expect(await so.setHiddenGroups([7])).toBe(true);
		expect(mesh.geometry.groups).toEqual([
			{ start: 0, count: 3, materialIndex: 0 },
			{ start: 6, count: 6, materialIndex: 0 },
		]);
		expect(sign.visible).toBe(false);
		// (0, 0) beside the hidden (1, 0): the face toward it
		expect(asked).toEqual([{ blocks: [0, 0, 0, 4], apron: [1, 0, 0, 4], cellGroups: [0] }]);
		expect(so.getHiddenGroups()).toEqual([7]);
	});

	it("keeps one filter's caps for the next time, until the blocks change", async () => {
		const { so, asked } = setup();
		await so.setLayerRange({ minY: 0, maxY: 2 });
		await so.setLayerRange({ minY: 0, maxY: 1 });
		await so.setLayerRange({ minY: 0, maxY: 2 });
		expect(asked).toHaveLength(2);
		so.blocksVersion++;
		await so.setLayerRange({ minY: 0, maxY: 2 });
		expect(asked).toHaveLength(3);
	});

	it("shows everything again, with no caps, for every layer and no hidden group", async () => {
		const { so, mesh, sign, caps } = setup();
		await so.setHiddenGroups([7]);
		await so.setLayerRange({ minY: 1, maxY: 2 });
		await so.setHiddenGroups(null);
		await so.setLayerRange({ minY: 0, maxY: 3 }); // every layer: the same as null
		expect(so.getLayerRange()).toBeNull();
		expect(caps()).toEqual([]);
		expect(sign.visible).toBe(true);
		expect(mesh.geometry.groups).toEqual([{ start: 0, count: 12, materialIndex: 0 }]);
	});

	it("frames the cells shown", async () => {
		const { so } = setup();
		await so.setHiddenGroups([7]);
		await so.setLayerRange({ minY: 0, maxY: 2 });
		const box = so.getTightWorldBox();
		expect([box.min.toArray(), box.max.toArray()]).toEqual([
			[-0.5, -0.5, -0.5],
			[0.5, 1.5, 0.5],
		]);
		expect(so.isCellShown(0, 1, 0)).toBe(true);
		expect(so.isCellShown(1, 0, 0)).toBe(false);
		expect(so.isCellShown(0, 2, 0)).toBe(false);
	});

	it("says it cannot when a mesh has no runs", async () => {
		const { so, mesh } = setup({ indexed: false });
		expect(so.canShowLayerRange()).toBe(false);
		expect(await so.setHiddenGroups([7])).toBe(false);
		expect(mesh.geometry.groups).toEqual([{ start: 0, count: 12, materialIndex: 0 }]);
	});
});
