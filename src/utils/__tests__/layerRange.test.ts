import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { applyLayerRange, inLayerRange, layerIndexOf, sortByLayer } from "../layerRange";

// Two chunks' meshes merged in a batch (each laid out by material, then layer, as the WASM mesher does): chunk A at
// indices 0-11, chunk B at 12-23. Every index holds its own position, so the reordering can be read back.
const indices = Uint32Array.from({ length: 24 }, (_, i) => i);
const groups = [
	{ start: 0, count: 6, materialIndex: 0 },
	{ start: 6, count: 6, materialIndex: 1 },
	{ start: 12, count: 6, materialIndex: 0 },
	{ start: 18, count: 6, materialIndex: 1 },
];
// [layer, start, count]: A has material 0 on layers 1 and 2 and material 1 on layer 1; B material 0 on layer 0 and
// material 1 on layer 2
const runs = [1, 0, 3, 2, 3, 3, 1, 6, 6, 0, 12, 6, 2, 18, 6];

describe("layer ranges of a merged mesh", () => {
	it("orders each material's indices by layer across the chunks, one group per material", () => {
		const sorted = sortByLayer(indices, groups, runs);
		expect(Array.from(sorted.indices)).toEqual([
			...[12, 13, 14, 15, 16, 17], // material 0, layer 0 (B)
			...[0, 1, 2], // layer 1 (A)
			...[3, 4, 5], // layer 2 (A)
			...[6, 7, 8, 9, 10, 11], // material 1, layer 1 (A)
			...[18, 19, 20, 21, 22, 23], // layer 2 (B)
		]);
		expect(sorted.groups).toEqual([
			{ start: 0, count: 12, materialIndex: 0 },
			{ start: 12, count: 12, materialIndex: 1 },
		]);
		expect(sorted.layerIndex.min).toBe(0);
		expect(sorted.layerIndex.max).toBe(2);
	});

	it("points the groups at the layers of a range, and back at all of them", () => {
		const { indices: idx, groups: g, layerIndex } = sortByLayer(indices, groups, runs);
		const geometry = new THREE.BufferGeometry();
		geometry.setIndex(new THREE.BufferAttribute(idx, 1));
		for (const group of g) geometry.addGroup(group.start, group.count, group.materialIndex);

		applyLayerRange(geometry, layerIndex, { minY: 1, maxY: 2 }); // layer 1 only
		expect(geometry.groups).toEqual([
			{ start: 6, count: 3, materialIndex: 0 },
			{ start: 12, count: 6, materialIndex: 1 },
		]);
		applyLayerRange(geometry, layerIndex, { minY: 2, maxY: 10 });
		expect(geometry.groups).toEqual([
			{ start: 9, count: 3, materialIndex: 0 },
			{ start: 18, count: 6, materialIndex: 1 },
		]);
		applyLayerRange(geometry, layerIndex, { minY: 5, maxY: 9 }); // nothing there
		expect(geometry.groups).toEqual([]);
		applyLayerRange(geometry, layerIndex, null);
		expect(geometry.groups).toEqual(g);
	});

	it("reads the layer index of one chunk's mesh as it is, and refuses runs that do not fit its groups", () => {
		const chunk = [
			{ start: 0, count: 6, materialIndex: 0 },
			{ start: 6, count: 6, materialIndex: 1 },
		];
		const index = layerIndexOf(chunk, [1, 0, 3, 2, 3, 3, 1, 6, 6]);
		expect(index?.groups.map((g) => Array.from(g.layers))).toEqual([[1, 2], [1]]);
		expect(index?.groups[0].starts[1]).toBe(3);
		expect(layerIndexOf(chunk, [2, 0, 3, 1, 3, 3, 1, 6, 6])).toBeNull(); // layers out of order
		expect(layerIndexOf(chunk, [1, 0, 3])).toBeNull(); // runs short of the groups
	});

	it("says whether a layer is in a range", () => {
		expect(inLayerRange(3, null)).toBe(true);
		expect(inLayerRange(3, { minY: 0, maxY: 3 })).toBe(false);
		expect(inLayerRange(2, { minY: 0, maxY: 3 })).toBe(true);
	});
});
