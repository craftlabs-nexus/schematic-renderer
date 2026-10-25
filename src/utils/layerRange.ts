// Showing some of a schematic's cells (a range of layers, all but some groups of cells) without meshing it again.
//
// The WASM mesher orders each mesh's triangles by material, then layer (the y of the block they belong to), then cell
// group (a caller's label for cells it may hide together, such as a part of a build), and reports the runs
// ([layer, group, start, count, ...] index ranges). A mesh laid out that way draws some layers and groups by drawing,
// for each material, the index ranges they take, joined where they touch: its groups are pointed at them
// (geometry.groups, no upload; raycasting follows the groups too). The faces the hidden cells covered on the shown
// ones are drawn by separate cap meshes (WASM build_caps; SchematicObject.setLayerRange / setHiddenGroups).

import * as THREE from "three";

/** For each material group of a geometry, its runs: the layer and cell group of each, and where it starts. */
export interface LayerIndex {
	groups: Array<{
		materialIndex: number;
		/** each run's layer, ascending */
		layers: Int32Array;
		/** each run's cell group, ascending within a layer */
		cellGroups: Uint16Array;
		/** the index each run starts at (the next run's start is where it ends) */
		starts: Uint32Array;
		/** the index the material's runs end at */
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

/** What to show: a range of layers (null: all) and the cell groups to leave out (null or empty: none). */
export interface CellFilter {
	range: LayerRange | null;
	hidden: ReadonlySet<number> | null;
}

type Group = { start: number; count: number; materialIndex: number };
type Run = { layer: number; group: number; start: number; count: number };

/**
 * The runs `[layer, group, start, count, ...]` of `runs`, with each one's material: the group it starts in. Also how
 * translucentRegions reads a batch's runs.
 */
export function runsWithMaterial(groups: Group[], runs: ArrayLike<number>) {
	const sortedGroups = [...groups].sort((a, b) => a.start - b.start);
	const out: Array<Run & { material: number }> = [];
	let g = 0;
	for (let i = 0; i + 3 < runs.length; i += 4) {
		const start = runs[i + 2];
		while (g < sortedGroups.length - 1 && start >= sortedGroups[g].start + sortedGroups[g].count)
			g++;
		out.push({
			material: sortedGroups[g]?.materialIndex ?? 0,
			layer: runs[i],
			group: runs[i + 1],
			start,
			count: runs[i + 3],
		});
	}
	return out;
}

/** One material's entry of a layer index from its runs in order (runs of the same layer and group joined). */
function entry(materialIndex: number, runs: Run[], end: number): LayerIndex["groups"][number] {
	const layers: number[] = [],
		cellGroups: number[] = [],
		starts: number[] = [];
	for (const r of runs) {
		const n = layers.length;
		if (n && layers[n - 1] === r.layer && cellGroups[n - 1] === r.group) continue;
		layers.push(r.layer);
		cellGroups.push(r.group);
		starts.push(r.start);
	}
	return {
		materialIndex,
		layers: Int32Array.from(layers),
		cellGroups: Uint16Array.from(cellGroups),
		starts: Uint32Array.from(starts),
		end,
	};
}

/**
 * Reorders a mesh's index buffer by material, then layer, then cell group, across all the runs it was merged from (a
 * batch of chunks, each laid out so on its own), and returns the new indices, one group per material and the layer
 * index. `runs` is flat [layer, group, start, count, ...]; each run lies within one of `groups`.
 */
export function sortByLayer(
	indices: Uint16Array | Uint32Array,
	groups: Group[],
	runs: ArrayLike<number>
): { indices: Uint16Array | Uint32Array; groups: Group[]; layerIndex: LayerIndex } {
	const list = runsWithMaterial(groups, runs);
	list.sort(
		(a, b) => a.material - b.material || a.layer - b.layer || a.group - b.group || a.start - b.start
	);
	const out = new (indices instanceof Uint16Array ? Uint16Array : Uint32Array)(indices.length);
	const newGroups: Group[] = [];
	const index: LayerIndex["groups"] = [];
	let at = 0;
	for (let i = 0; i < list.length;) {
		const material = list[i].material;
		const groupStart = at;
		const placed: Run[] = [];
		for (; i < list.length && list[i].material === material; i++) {
			const run = list[i];
			placed.push({ layer: run.layer, group: run.group, start: at, count: run.count });
			out.set(indices.subarray(run.start, run.start + run.count), at);
			at += run.count;
		}
		newGroups.push({ start: groupStart, count: at - groupStart, materialIndex: material });
		index.push(entry(material, placed, at));
	}
	return { indices: out, groups: newGroups, layerIndex: withBounds(index) };
}

/**
 * The layer index of a mesh already laid out by material, then layer, then cell group in each of its groups (one
 * chunk's mesh, as the WASM returns it), or null when `runs` does not fit the groups so.
 */
export function layerIndexOf(groups: Group[], runs: ArrayLike<number>): LayerIndex | null {
	const index: LayerIndex["groups"] = [];
	let r = 0;
	for (const group of [...groups].sort((a, b) => a.start - b.start)) {
		const end = group.start + group.count;
		const placed: Run[] = [];
		let at = group.start;
		for (; r + 3 < runs.length && runs[r + 2] < end; r += 4) {
			const run = { layer: runs[r], group: runs[r + 1], start: runs[r + 2], count: runs[r + 3] };
			const last = placed[placed.length - 1];
			const ordered =
				!last || run.layer > last.layer || (run.layer === last.layer && run.group >= last.group);
			if (run.start !== at || !ordered) return null;
			placed.push(run);
			at += run.count;
		}
		if (at !== end) return null;
		index.push(entry(group.materialIndex, placed, end));
	}
	return r === runs.length ? withBounds(index) : null;
}

/** A layer index's entry for each material of some placed pieces (a block each), in the order given. */
export function layerIndexOfPieces(
	pieces: Array<{
		materialIndex: number;
		layer: number;
		group: number;
		start: number;
		count: number;
	}>
): LayerIndex {
	const byMaterial = new Map<number, Run[]>();
	for (const p of pieces) {
		let list = byMaterial.get(p.materialIndex);
		if (!list) byMaterial.set(p.materialIndex, (list = []));
		list.push(p);
	}
	const groups = [...byMaterial].map(([material, runs]) => {
		const last = runs[runs.length - 1];
		return entry(material, runs, last.start + last.count);
	});
	return withBounds(groups);
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

/**
 * Points a geometry's groups at what `filter` shows (null: everything): for each material, the runs of the layers in
 * its range whose cell group is not hidden, joined where they touch.
 */
export function applyLayerRange(
	geometry: THREE.BufferGeometry,
	index: LayerIndex,
	filter: CellFilter | LayerRange | null
) {
	const { range, hidden } = toFilter(filter);
	geometry.clearGroups();
	for (const g of index.groups) {
		const a = range ? lowerBound(g.layers, range.minY) : 0;
		const b = range ? lowerBound(g.layers, range.maxY) : g.layers.length;
		let start = -1,
			end = -1;
		for (let i = a; i < b; i++) {
			if (hidden?.has(g.cellGroups[i])) continue;
			const s = g.starts[i],
				e = i + 1 < g.starts.length ? g.starts[i + 1] : g.end;
			if (s === end) {
				end = e;
				continue;
			}
			if (end > start) geometry.addGroup(start, end - start, g.materialIndex);
			start = s;
			end = e;
		}
		if (end > start) geometry.addGroup(start, end - start, g.materialIndex);
	}
}

/** A filter from a filter, a bare range, or null. */
export function toFilter(filter: CellFilter | LayerRange | null): CellFilter {
	if (!filter) return { range: null, hidden: null };
	if ("minY" in filter) return { range: filter, hidden: null };
	return { range: filter.range, hidden: filter.hidden?.size ? filter.hidden : null };
}

/** Whether a layer (a block's y) is in a range (null: every layer). */
export const inLayerRange = (y: number, range: LayerRange | null): boolean =>
	!range || (y >= range.minY && y < range.maxY);

/** Whether a cell of a layer and cell group shows under a filter. */
export const shownBy = (y: number, group: number, filter: CellFilter): boolean =>
	inLayerRange(y, filter.range) && !filter.hidden?.has(group);
