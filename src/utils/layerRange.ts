// Showing a range of a schematic's layers without meshing it again.
//
// The WASM mesher orders each mesh's triangles by material, then by layer (the y of the block they belong to), and
// reports the runs ([layer, start, count, ...] index ranges). A mesh whose index buffer is laid out that way draws a
// range of layers by drawing, for each material, the one index range those layers take: its groups are pointed at
// that range (geometry.groups, no upload; raycasting follows the groups too). What a mesh of those layers alone would
// have on top of that, the faces between the top layer and the one above it (and the bottom layer and the one below),
// are drawn by separate cap meshes (WASM build_caps; SchematicObject.setLayerRange).

import * as THREE from "three";

/** For each material group of a geometry, where each of its layers starts in the index buffer. */
export interface LayerIndex {
	groups: Array<{
		materialIndex: number;
		/** the group's layers, ascending */
		layers: Int32Array;
		/** the index each layer's triangles start at (the next layer's start is where they end) */
		starts: Uint32Array;
		/** the index the group ends at */
		end: number;
	}>;
	/** the lowest and highest layer of the geometry */
	min: number;
	max: number;
}

/** A schematic's layers to show: minY to maxY, maxY exclusive (as renderingBounds). */
export interface LayerRange {
	minY: number;
	maxY: number;
}

type Group = { start: number; count: number; materialIndex: number };

/**
 * Reorders a mesh's index buffer by material, then layer, across all the runs it was merged from (a batch of chunks,
 * each ordered so on its own), and returns the new indices, one group per material and the layer index. `runs` is
 * flat [layer, start, count, ...]; each run lies within one of `groups`.
 */
export function sortByLayer(
	indices: Uint16Array | Uint32Array,
	groups: Group[],
	runs: ArrayLike<number>
): { indices: Uint16Array | Uint32Array; groups: Group[]; layerIndex: LayerIndex } {
	// the material of each run: the group it starts in (both are in index order)
	const sortedGroups = [...groups].sort((a, b) => a.start - b.start);
	const list: Array<{ material: number; layer: number; start: number; count: number }> = [];
	let g = 0;
	for (let i = 0; i < runs.length; i += 3) {
		const start = runs[i + 1];
		while (g < sortedGroups.length - 1 && start >= sortedGroups[g].start + sortedGroups[g].count)
			g++;
		const material = sortedGroups[g]?.materialIndex ?? 0;
		list.push({ material, layer: runs[i], start, count: runs[i + 2] });
	}
	list.sort((a, b) => a.material - b.material || a.layer - b.layer || a.start - b.start);

	const out = new (indices instanceof Uint16Array ? Uint16Array : Uint32Array)(indices.length);
	const newGroups: Group[] = [];
	const index: LayerIndex["groups"] = [];
	let at = 0;
	for (let i = 0; i < list.length;) {
		const material = list[i].material;
		const groupStart = at;
		const layers: number[] = [];
		const starts: number[] = [];
		for (; i < list.length && list[i].material === material; i++) {
			const run = list[i];
			if (layers[layers.length - 1] !== run.layer) {
				layers.push(run.layer);
				starts.push(at);
			}
			out.set(indices.subarray(run.start, run.start + run.count), at);
			at += run.count;
		}
		newGroups.push({ start: groupStart, count: at - groupStart, materialIndex: material });
		index.push({
			materialIndex: material,
			layers: Int32Array.from(layers),
			starts: Uint32Array.from(starts),
			end: at,
		});
	}
	return { indices: out, groups: newGroups, layerIndex: withBounds(index) };
}

/**
 * The layer index of a mesh already laid out by material, then layer, in each of its groups (one chunk's mesh, as the
 * WASM returns it), or null when `runs` does not fit the groups so.
 */
export function layerIndexOf(groups: Group[], runs: ArrayLike<number>): LayerIndex | null {
	const index: LayerIndex["groups"] = [];
	let r = 0;
	for (const group of [...groups].sort((a, b) => a.start - b.start)) {
		const end = group.start + group.count;
		const layers: number[] = [];
		const starts: number[] = [];
		let at = group.start;
		for (; r < runs.length && runs[r + 1] < end; r += 3) {
			if (runs[r + 1] !== at || (layers.length && runs[r] < layers[layers.length - 1])) return null;
			if (layers[layers.length - 1] !== runs[r]) {
				layers.push(runs[r]);
				starts.push(at);
			}
			at += runs[r + 2];
		}
		if (at !== end) return null;
		index.push({
			materialIndex: group.materialIndex,
			layers: Int32Array.from(layers),
			starts: Uint32Array.from(starts),
			end,
		});
	}
	return r === runs.length ? withBounds(index) : null;
}

function withBounds(groups: LayerIndex["groups"]): LayerIndex {
	let min = Infinity,
		max = -Infinity;
	for (const g of groups) {
		if (!g.layers.length) continue;
		min = Math.min(min, g.layers[0]);
		max = Math.max(max, g.layers[g.layers.length - 1]);
	}
	return { groups, min, max };
}

/** The first position in an ascending array whose value is at least `v`. */
function lowerBound(a: Int32Array, v: number): number {
	let lo = 0,
		hi = a.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (a[mid] < v) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** Points a geometry's groups at the layers of `range` (null: every layer), one group per material. */
export function applyLayerRange(
	geometry: THREE.BufferGeometry,
	index: LayerIndex,
	range: LayerRange | null
) {
	geometry.clearGroups();
	for (const g of index.groups) {
		if (!range) {
			geometry.addGroup(g.starts[0] ?? g.end, g.end - (g.starts[0] ?? g.end), g.materialIndex);
			continue;
		}
		const a = lowerBound(g.layers, range.minY);
		const b = lowerBound(g.layers, range.maxY);
		const start = a < g.layers.length ? g.starts[a] : g.end;
		const end = b < g.layers.length ? g.starts[b] : g.end;
		if (end > start) geometry.addGroup(start, end - start, g.materialIndex);
	}
}

/** Whether a layer (a block's y) is in a range (null: every layer). */
export const inLayerRange = (y: number, range: LayerRange | null): boolean =>
	!range || (y >= range.minY && y < range.maxY);
