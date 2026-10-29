// Chunks and the block lists they are built from, the same way for every build path: a chunk's key, and a list of
// blocks given flat ([x, y, z, paletteIndex, ...], as Int32Array or any typed array) or as one array a block.

/** A chunk's key, `x,y,z` in chunks: how the build tags a chunk's objects, and how its maps are keyed. */
export function chunkKey(x: number, y: number, z: number): string {
	return `${x},${y},${z}`;
}

/** Visits each block of a list given flat ([x, y, z, paletteIndex, ...]) or as one array a block. */
export function forEachBlock(
	blocks: unknown,
	visit: (x: number, y: number, z: number, p: number) => void
): void {
	if (ArrayBuffer.isView(blocks)) {
		const flat = blocks as unknown as ArrayLike<number>;
		for (let i = 0; i + 3 < flat.length; i += 4)
			visit(flat[i], flat[i + 1], flat[i + 2], flat[i + 3]);
	} else if (Array.isArray(blocks)) {
		for (const b of blocks as ArrayLike<number>[]) visit(b[0], b[1], b[2], b[3]);
	}
}
