// Cutting a chunk out of a batched build's meshes, so a chunk meshed again after a block edit is not drawn twice.
//
// A batched build (WorldMeshBuilder.processChunksBatched) merges up to 64 chunks into a mesh per category, so an
// edited chunk cannot be taken out by removing its objects, as the other build modes do: its old faces would stay
// drawn under its new chunk mesh. The WASM worker appends each chunk's vertices after the last chunk's and says where
// each chunk's begin (BatchMesh.chunks), and every triangle's vertices are of one chunk. So each vertex keeps the
// chunk it is of (vertexChunks, carried through the split of translucent triangles into meshes of their own), and
// the geometry the key of each chunk (geometry.userData.batchChunks). An edited chunk's triangles in the batch are
// made degenerate (all three corners on one vertex): nothing is drawn or picked of them, the index ranges of the
// groups and layer runs stay as they are (a filter still applies: layerRange.applyLayerRange), and only the span of
// the index buffer they lie in goes to the GPU again.

import * as THREE from "three";

/** A batched geometry's chunks: each chunk's key ("x,y,z") and number, and each vertex's chunk number. */
export interface BatchChunks {
	keys: Map<string, number>;
	ofVertex: Uint8Array | Uint16Array;
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
 * edit of it costs nothing here. Whether any were hidden; false for a geometry without chunks.
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
	// added to the ranges of other cuts made before the next upload, which sends them all
	index.addUpdateRange(first, last + 3 - first);
	index.needsUpdate = true;
	return true;
}
