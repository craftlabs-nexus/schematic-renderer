// A schematic's rendering bounds (SchematicObject.renderingBounds): the cells it draws, from min to max, max
// exclusive on every axis. One test of a cell against them, for every build path to cut the same cells.

/** The cells from `min` to `max` (exclusive); `enabled` false (or absent) draws them all. */
export interface RenderingBounds {
	min: { x: number; y: number; z: number };
	max: { x: number; y: number; z: number };
	enabled?: boolean;
}

/** Whether the cell at x, y, z is inside `bounds` (min inclusive, max exclusive). */
export function inRenderingBounds(
	bounds: Pick<RenderingBounds, "min" | "max">,
	x: number,
	y: number,
	z: number
): boolean {
	const { min, max } = bounds;
	return x >= min.x && x < max.x && y >= min.y && y < max.y && z >= min.z && z < max.z;
}

/**
 * The blocks of a chunk, flat [x, y, z, paletteIndex, ...] or one array each, inside `bounds`: all of them, as they
 * are, when there are none or they are not enabled.
 */
export function blocksInBounds<T extends Int32Array | number[][]>(
	blocks: T,
	bounds: RenderingBounds | undefined
): T {
	if (!bounds?.enabled) return blocks;
	if (blocks instanceof Int32Array) {
		const kept: number[] = [];
		for (let i = 0; i + 3 < blocks.length; i += 4)
			if (inRenderingBounds(bounds, blocks[i], blocks[i + 1], blocks[i + 2]))
				kept.push(blocks[i], blocks[i + 1], blocks[i + 2], blocks[i + 3]);
		return new Int32Array(kept) as T;
	}
	return (blocks as number[][]).filter(([x, y, z]) => inRenderingBounds(bounds, x, y, z)) as T;
}
