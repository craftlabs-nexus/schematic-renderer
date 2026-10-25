import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
	applyLayerRange,
	inLayerRange,
	layerIndexOf,
	layerIndexOfPieces,
	shownBy,
	sortByLayer,
} from "../layerRange";

// Two chunks' meshes merged in a batch (each laid out by material, layer and cell group, as the WASM mesher does):
// chunk A at indices 0-11, chunk B at 12-23. Every index holds its own position, so the reordering can be read back.
const indices = Uint32Array.from({ length: 24 }, (_, i) => i);
const groups = [
	{ start: 0, count: 6, materialIndex: 0 },
	{ start: 6, count: 6, materialIndex: 1 },
	{ start: 12, count: 6, materialIndex: 0 },
	{ start: 18, count: 6, materialIndex: 1 },
];
// [layer, group, start, count]: A has material 0 on layer 1 (cell group 0) and layer 2 (group 5), material 1 on
// layer 1; B has material 0 on layer 0 and material 1 on layer 2 (group 5)
const runs = [1, 0, 0, 3, 2, 5, 3, 3, 1, 0, 6, 6, 0, 0, 12, 6, 2, 5, 18, 6];

function geometryOf(sorted: ReturnType<typeof sortByLayer>) {
	const geometry = new THREE.BufferGeometry();
	geometry.setIndex(new THREE.BufferAttribute(sorted.indices, 1));
	for (const g of sorted.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
	return geometry;
}

describe("what a filter shows of a merged mesh", () => {
	it("orders each material's indices by layer and cell group across the chunks, one group per material", () => {
		const sorted = sortByLayer(indices, groups, runs);
		expect(Array.from(sorted.indices)).toEqual([
			...[12, 13, 14, 15, 16, 17], // material 0, layer 0 (B)
			...[0, 1, 2], // layer 1 (A)
			...[3, 4, 5], // layer 2, group 5 (A)
			...[6, 7, 8, 9, 10, 11], // material 1, layer 1 (A)
			...[18, 19, 20, 21, 22, 23], // layer 2, group 5 (B)
		]);
		expect(sorted.groups).toEqual([
			{ start: 0, count: 12, materialIndex: 0 },
			{ start: 12, count: 12, materialIndex: 1 },
		]);
		expect([sorted.layerIndex.min, sorted.layerIndex.max]).toEqual([0, 2]);
	});

	it("points the groups at the layers of a range, and back at all of them", () => {
		const sorted = sortByLayer(indices, groups, runs);
		const geometry = geometryOf(sorted);
		applyLayerRange(geometry, sorted.layerIndex, { minY: 1, maxY: 2 }); // layer 1 only
		expect(geometry.groups).toEqual([
			{ start: 6, count: 3, materialIndex: 0 },
			{ start: 12, count: 6, materialIndex: 1 },
		]);
		applyLayerRange(geometry, sorted.layerIndex, { minY: 5, maxY: 9 }); // nothing there
		expect(geometry.groups).toEqual([]);
		applyLayerRange(geometry, sorted.layerIndex, null);
		expect(geometry.groups).toEqual(sorted.groups);
	});

	it("leaves the hidden cell groups out, joining what is left where it touches", () => {
		const sorted = sortByLayer(indices, groups, runs);
		const geometry = geometryOf(sorted);
		applyLayerRange(geometry, sorted.layerIndex, { range: null, hidden: new Set([5]) });
		expect(geometry.groups).toEqual([
			{ start: 0, count: 9, materialIndex: 0 }, // layers 0 and 1 touch: one range
			{ start: 12, count: 6, materialIndex: 1 },
		]);
		applyLayerRange(geometry, sorted.layerIndex, {
			range: { minY: 2, maxY: 3 },
			hidden: new Set([0]),
		});
		expect(geometry.groups).toEqual([
			{ start: 9, count: 3, materialIndex: 0 },
			{ start: 18, count: 6, materialIndex: 1 },
		]);
	});

	it("reads the index of one chunk's mesh as it is, and refuses runs that do not fit its groups", () => {
		const chunk = [
			{ start: 0, count: 6, materialIndex: 0 },
			{ start: 6, count: 6, materialIndex: 1 },
		];
		const index = layerIndexOf(chunk, [1, 0, 0, 3, 1, 4, 3, 3, 1, 0, 6, 6]);
		expect(index?.groups.map((g) => [Array.from(g.layers), Array.from(g.cellGroups)])).toEqual([
			[
				[1, 1],
				[0, 4],
			],
			[[1], [0]],
		]);
		expect(layerIndexOf(chunk, [2, 0, 0, 3, 1, 0, 3, 3, 1, 0, 6, 6])).toBeNull(); // layers out of order
		expect(layerIndexOf(chunk, [1, 0, 0, 3])).toBeNull(); // runs short of the groups
	});

	it("indexes pieces placed one after another", () => {
		const index = layerIndexOfPieces([
			{ materialIndex: 0, layer: 3, group: 0, start: 0, count: 6 },
			{ materialIndex: 0, layer: 3, group: 0, start: 6, count: 6 }, // the same run: joined
			{ materialIndex: 0, layer: 4, group: 2, start: 12, count: 6 },
			{ materialIndex: 1, layer: 3, group: 0, start: 18, count: 3 },
		]);
		expect(index.groups.map((g) => [g.materialIndex, Array.from(g.starts), g.end])).toEqual([
			[0, [0, 12], 18],
			[1, [18], 21],
		]);
	});

	it("says whether a cell shows", () => {
		expect(inLayerRange(3, null)).toBe(true);
		expect(inLayerRange(3, { minY: 0, maxY: 3 })).toBe(false);
		expect(shownBy(2, 7, { range: { minY: 0, maxY: 3 }, hidden: new Set([7]) })).toBe(false);
		expect(shownBy(2, 6, { range: { minY: 0, maxY: 3 }, hidden: new Set([7]) })).toBe(true);
	});
});
