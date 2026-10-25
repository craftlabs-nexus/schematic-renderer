// Cutting a chunk out of a batched build's meshes, so a chunk meshed again after a block edit is not drawn twice.
//
// A batched build (WorldMeshBuilder.processChunksBatched) merges up to 64 chunks into a mesh per category, so an
// edited chunk cannot be taken out by removing its objects, as the other build modes do: its old faces would stay
// drawn under its new chunk mesh. The WASM worker appends each chunk's vertices after the last chunk's and says where
// each chunk's begin (BatchMesh.chunks), and every triangle's vertices are of one chunk. So each vertex keeps the
// chunk it is of (vertexChunks, carried through the split of translucent triangles into meshes of their own), and
// the geometry the key of each chunk (geometry.userData.batchChunks). An edited chunk's triangles in the batch are
// made degenerate (all three corners on one vertex): nothing is drawn or picked of them, the index ranges of the
// groups and layer runs stay as they are (a filter still applies: layerRange.applyLayerRange), and the index buffer
// goes to the GPU again from the first of them to the last (a batch's triangles are ordered by material and layer
// across its chunks, so that is most of it), the vertex buffers not.
//
// Collapsed triangles still cost their index fetches, vertex shading and raycasts. Once they pass a share of the
// index buffer (COMPACT_SHARE) it is made again without them, its groups and layer runs moved to match, and the
// geometry's buffers go to the GPU again. A geometry every chunk of which is cut lets go of its buffers.

import * as THREE from "three";

/**
 * A batched geometry's chunks: the key ("x,y,z") and number of each chunk it has triangles of, each vertex's chunk
 * number, and how many of its indices are of triangles cut out.
 */
export interface BatchChunks {
	keys: Map<string, number>;
	ofVertex: Uint8Array | Uint16Array;
	collapsed: number;
}

/** The share of a batched geometry's index buffer past which its cut triangles are taken out of it. */
export const COMPACT_SHARE = 1 / 4;

/**
 * The chunks of a batched geometry from its batch's (`keys`, numbered as `ofVertex` numbers them): the ones its
 * triangles are of. A translucent region's mesh holds a few of its batch's chunks, and the rest of the batch may keep
 * vertices of chunks whose triangles all went to regions.
 */
export function batchChunksOf(
	keys: string[],
	ofVertex: Uint8Array | Uint16Array,
	indices: ArrayLike<number>
): BatchChunks {
	const held = new Set<number>();
	for (let t = 0; t < indices.length; t += 3) held.add(ofVertex[indices[t]]);
	return {
		keys: new Map([...held].sort((a, b) => a - b).map((n) => [keys[n], n])),
		ofVertex,
		collapsed: 0,
	};
}

/**
 * The chunk of each vertex of a batch, from where each chunk's vertices begin (flat [chunkX, chunkY, chunkZ,
 * firstVertex, ...], in order), and the chunks' keys, numbered in that order.
 */
export function vertexChunksOf(
	chunks: ArrayLike<number>,
	vertexCount: number
): { keys: string[]; ofVertex: Uint8Array | Uint16Array } {
	const keys: string[] = [];
	// a chunk listed twice (two of its meshes in one category) keeps one number
	const numbers = new Map<string, number>();
	const ofVertex =
		chunks.length / 4 > 255 ? new Uint16Array(vertexCount) : new Uint8Array(vertexCount);
	for (let i = 0; i + 3 < chunks.length; i += 4) {
		const key = `${chunks[i]},${chunks[i + 1]},${chunks[i + 2]}`;
		let n = numbers.get(key);
		if (n === undefined) {
			numbers.set(key, (n = keys.length));
			keys.push(key);
		}
		const end = i + 7 < chunks.length ? chunks[i + 7] : vertexCount;
		ofVertex.fill(n, chunks[i + 3], end);
	}
	return { keys, ofVertex };
}

/**
 * Hides the triangles of chunk `key` in a batched geometry (degenerate, in place), and forgets the chunk, so a later
 * edit of it costs nothing here; compacts the index buffer once cut triangles pass COMPACT_SHARE of it, and empties
 * the geometry once every chunk of it is cut. Whether any were hidden; false for a geometry without chunks.
 */
export function cutChunkFromBatch(geometry: THREE.BufferGeometry, key: string): boolean {
	const chunks = geometry.userData.batchChunks as BatchChunks | undefined;
	const chunk = chunks?.keys.get(key);
	const index = geometry.index;
	if (!chunks || chunk === undefined || !index) return false;
	chunks.keys.delete(key);
	const indices = index.array as Uint16Array | Uint32Array;
	const { ofVertex } = chunks;
	let first = -1,
		last = -1;
	for (let t = 0; t + 2 < indices.length; t += 3) {
		const v = indices[t];
		if (ofVertex[v] !== chunk) continue;
		indices[t + 1] = v;
		indices[t + 2] = v;
		if (first < 0) first = t;
		last = t;
	}
	if (first < 0) return false;
	if (chunks.keys.size === 0) {
		emptyGeometry(geometry);
		return true;
	}
	chunks.collapsed += countCut(indices, ofVertex, chunk, first, last);
	if (chunks.collapsed > indices.length * COMPACT_SHARE) {
		compactIndex(geometry);
		return true;
	}
	// added to the ranges of other cuts made before the next upload, which sends them all
	index.addUpdateRange(first, last + 3 - first);
	index.needsUpdate = true;
	return true;
}

/** How many indices of chunk `chunk`'s triangles lie from triangle `first` to `last`. */
function countCut(
	indices: ArrayLike<number>,
	ofVertex: ArrayLike<number>,
	chunk: number,
	first: number,
	last: number
): number {
	let n = 0;
	for (let t = first; t <= last; t += 3) if (ofVertex[indices[t]] === chunk) n += 3;
	return n;
}

/**
 * An index buffer without its collapsed triangles (two corners on one vertex: a cut chunk's, or any other with no
 * area), and where each triangle's start in the old buffer lands in the new (`at`), for the index ranges into it to
 * follow. Null when it has none.
 */
export function withoutCollapsed<T extends Uint16Array | Uint32Array>(
	indices: T
): { indices: T; at: (start: number) => number } | null {
	const triangles = Math.floor(indices.length / 3);
	// the triangles kept before each one
	const kept = new Uint32Array(triangles + 1);
	for (let t = 0; t < triangles; t++) {
		const [a, b, c] = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
		kept[t + 1] = kept[t] + (a === b || b === c || a === c ? 0 : 1);
	}
	if (kept[triangles] === triangles) return null;
	const out = new (indices.constructor as new (n: number) => T)(kept[triangles] * 3);
	for (let t = 0; t < triangles; t++)
		if (kept[t + 1] > kept[t]) out.set(indices.subarray(t * 3, t * 3 + 3), kept[t] * 3);
	return { indices: out, at: (start) => kept[Math.min(Math.floor(start / 3), triangles)] * 3 };
}

/** A geometry's groups and layer runs (layerRange.ts) moved by `at`, as its index buffer was remade. */
export function moveIndexRanges(geometry: THREE.BufferGeometry, at: (start: number) => number) {
	const groups = geometry.groups.map((g) => ({
		materialIndex: g.materialIndex,
		start: at(g.start),
		end: at(g.start + g.count),
	}));
	geometry.clearGroups();
	for (const g of groups) geometry.addGroup(g.start, g.end - g.start, g.materialIndex);
	const layerIndex = geometry.userData.layerIndex as
		{ groups: Array<{ starts: Uint32Array; end: number }> } | undefined;
	for (const g of layerIndex?.groups ?? []) {
		g.starts = g.starts.map(at);
		g.end = at(g.end);
	}
}

/** Remakes a batched geometry's index buffer without the triangles cut out of it. */
function compactIndex(geometry: THREE.BufferGeometry) {
	const compacted = withoutCollapsed(geometry.index!.array as Uint16Array | Uint32Array);
	(geometry.userData.batchChunks as BatchChunks).collapsed = 0;
	if (!compacted) return;
	// its buffers on the GPU go (the old index buffer with them) and are sent again at the next draw
	geometry.dispose();
	geometry.setIndex(new THREE.BufferAttribute(compacted.indices, 1));
	moveIndexRanges(geometry, compacted.at);
}

/** Lets go of a batched geometry's buffers, every chunk of it cut: it draws nothing, as an empty geometry. */
function emptyGeometry(geometry: THREE.BufferGeometry) {
	geometry.dispose();
	const empty = (array: THREE.TypedArray) =>
		new (array.constructor as new (n: number) => THREE.TypedArray)(0);
	geometry.setIndex(new THREE.BufferAttribute(empty(geometry.index!.array), 1));
	for (const [name, attribute] of Object.entries(geometry.attributes)) {
		const { array, itemSize, normalized } = attribute as THREE.BufferAttribute;
		geometry.setAttribute(name, new THREE.BufferAttribute(empty(array), itemSize, normalized));
	}
	moveIndexRanges(geometry, () => 0);
	(geometry.userData.batchChunks as BatchChunks).collapsed = 0;
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
}
