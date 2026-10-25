/** A box of cells, min and max inclusive. */
export interface CellBox {
	min: [number, number, number];
	max: [number, number, number];
}

/**
 * The cells a schematic spans: its bounding box, air margins included. Not get_dimensions(), which is the size of
 * the box its blocks fill (a file whose blocks are mostly air, one part of it shown, spans far more than that).
 */
export function schematicBox(wrapper: any): CellBox {
	const bb = wrapper?.get_bounding_box?.();
	if (bb?.min && bb?.max) {
		const [a, b, c] = Array.from(bb.min as ArrayLike<number>);
		const [x, y, z] = Array.from(bb.max as ArrayLike<number>);
		return { min: [a, b, c], max: [x, y, z] };
	}
	const [w, h, l] = Array.from((wrapper?.get_dimensions?.() as ArrayLike<number>) ?? [0, 0, 0]);
	return { min: [0, 0, 0], max: [w - 1, h - 1, l - 1] };
}
