import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

vi.mock("nucleation", () => ({ default: vi.fn(), SchematicWrapper: class {} }));

import { SchematicObject } from "../SchematicObject";
import { sortByLayer } from "../../utils/layerRange";

// SchematicObject.setLayerRange on a stand-in: one merged mesh over layers 0-2 (material 0) of a schematic 10 layers
// high, a sign on layer 5, and a mesh builder that makes a one-triangle cap for any layer and direction.
function setup({ layered = true } = {}) {
	const { indices, groups, layerIndex } = sortByLayer(
		Uint32Array.from({ length: 9 }, (_, i) => i),
		[{ start: 0, count: 9, materialIndex: 0 }],
		[0, 0, 3, 1, 3, 3, 2, 6, 3]
	);
	const geometry = new THREE.BufferGeometry();
	geometry.setIndex(new THREE.BufferAttribute(indices, 1));
	for (const g of groups) geometry.addGroup(g.start, g.count, g.materialIndex);
	if (layered) geometry.userData.layerIndex = layerIndex;
	const mesh = new THREE.Mesh(geometry, [new THREE.MeshBasicMaterial()]);
	const sign = new THREE.Group();
	sign.userData.layerY = 5;
	sign.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));

	const capsBuilt: string[] = [];
	const so = Object.create(SchematicObject.prototype) as any;
	Object.assign(so, {
		visible: true,
		meshes: [mesh, sign],
		group: new THREE.Group(),
		blocksVersion: 0,
		layerRange: null,
		shownCaps: [],
		layerCaps: new Map(),
		layerRangeCall: 0,
		schematicWrapper: { get_bounding_box: () => ({ min: [0, 0, 0], max: [9, 9, 9] }) },
		worldMeshBuilder: {
			buildLayerCaps: async (_: unknown, y: number, direction: number) => {
				capsBuilt.push(`${y}:${direction}`);
				const cap = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
				cap.name = `cap ${y} ${direction}`;
				return [cap];
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
	return { so, mesh, sign, caps, capsBuilt };
}

describe("SchematicObject.setLayerRange", () => {
	it("draws the layers of the range, hides other layers' objects and caps the range's top and bottom", async () => {
		const { so, mesh, sign, caps } = setup();
		expect(await so.setLayerRange({ minY: 1, maxY: 2 })).toBe(true);
		expect(mesh.geometry.groups).toEqual([{ start: 3, count: 3, materialIndex: 0 }]);
		expect(sign.visible).toBe(false);
		expect(caps()).toEqual(["cap 1 1", "cap 1 -1"]);
		expect(so.getLayerRange()).toEqual({ minY: 1, maxY: 2 });
	});

	it("needs no cap at the schematic's top or bottom, and shows everything again for null", async () => {
		const { so, mesh, sign, caps } = setup();
		await so.setLayerRange({ minY: 0, maxY: 6 });
		expect(caps()).toEqual(["cap 5 1"]); // nothing under layer 0
		expect(sign.visible).toBe(true);
		await so.setLayerRange({ minY: 0, maxY: 10 }); // every layer: the same as null
		expect(so.getLayerRange()).toBeNull();
		expect(caps()).toEqual([]);
		expect(mesh.geometry.groups).toEqual([{ start: 0, count: 9, materialIndex: 0 }]);
	});

	it("builds a layer's caps once and keeps them for the next time", async () => {
		const { so, capsBuilt } = setup();
		await so.setLayerRange({ minY: 0, maxY: 3 });
		await so.setLayerRange({ minY: 0, maxY: 4 });
		await so.setLayerRange({ minY: 0, maxY: 3 });
		expect(capsBuilt).toEqual(["2:1", "3:1"]);
		so.blocksVersion++; // a block set: the caps are of the old blocks
		await so.setLayerRange({ minY: 0, maxY: 3 });
		expect(capsBuilt).toEqual(["2:1", "3:1", "2:1"]);
	});

	it("says it cannot when a mesh has no layer runs", async () => {
		const { so, mesh } = setup({ layered: false });
		expect(so.canShowLayerRange()).toBe(false);
		expect(await so.setLayerRange({ minY: 1, maxY: 2 })).toBe(false);
		expect(mesh.geometry.groups).toEqual([{ start: 0, count: 9, materialIndex: 0 }]);
	});
});
