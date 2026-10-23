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
