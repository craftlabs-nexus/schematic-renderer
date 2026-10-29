/**
 * Whether a face lies on its block's boundary, so that a neighbour on that side may hide it. `pos` is the face's
 * coordinate on its normal's axis and `dir` the normal's sign (+1 or -1). Block geometry is centred on the origin,
 * so the boundary is at +-0.5. A face anywhere else, such as a repeater torch's side in the block's middle plane, is
 * never flush: accepting 0.0 and 1.0 too (as if blocks ran from 0 to 1) culled those against the neighbour beyond.
 *
 * The WASM mesh builder (mesh_builder_wasm/src/lib.rs) and the WebGPU one (gpu/ComputeMeshBuilder.ts) test the same.
 */
export function isOnBlockBoundary(pos: number, dir: number, epsilon = 0.01): boolean {
	if (dir === 1) return Math.abs(pos - 0.5) < epsilon;
	if (dir === -1) return Math.abs(pos + 0.5) < epsilon;
	return false;
}

/** The cull key of a block whose full sides are all opaque: such a side hides any face against it. */
export const SOLID_CULL_KEY = "solid";

/** Which fluid a block holds, or a geometry is: none, water (water and waterlogged blocks) or lava. */
export const FLUID_NONE = 0;
export const FLUID_WATER = 1;
export const FLUID_LAVA = 2;

/** Each side's occlusion bit (CullInfo.occlusionFlags). */
export const SIDE_BIT = { west: 0, east: 1, down: 2, up: 3, north: 4, south: 5 } as const;

/** What a palette entry tells its neighbours about hiding their faces. */
export interface CullInfo {
	/** the sides its shape covers fully (bit 0 west, 1 east, 2 down, 3 up, 4 north, 5 south) */
	occlusionFlags: number;
	/** SOLID_CULL_KEY when those sides are opaque; else its block id: see-through sides hide an identical block only */
	cullKey: string;
	/** the fluid it holds (FLUID_*) */
	fluid: number;
}

/**
 * Whether a face on the boundary of `self`, facing a neighbour, is hidden by it, as the game decides: `side` is the
 * neighbour's side toward the face (its occlusion bit) and `faceFluid` whether the face is the block's fluid.
 * - an opaque full side hides any face against it (stone hides glass, water and a slab's side alike);
 * - a fluid's face is hidden by the same fluid beyond it (water, or a waterlogged block's water), not by the block's
 *   own shape: a waterlogged slab keeps its sides next to water, and the water between two cells is not drawn;
 * - a see-through full side (glass, ice, slime, a copper grate) hides only the same block's face: two glass blocks
 *   share no face, glass next to leaves or to other glass keeps both.
 * The WASM mesh builder (mesh_builder_wasm/src/lib.rs, face_hidden_by) decides the same.
 */
export function faceHiddenBy(
	self: CullInfo,
	faceFluid: number,
	neighbour: CullInfo,
	side: number
): boolean {
	const covers = (neighbour.occlusionFlags & (1 << side)) !== 0;
	if (covers && neighbour.cullKey === SOLID_CULL_KEY) return true;
	if (faceFluid !== FLUID_NONE) return neighbour.fluid === faceFluid;
	return covers && neighbour.cullKey === self.cullKey;
}
