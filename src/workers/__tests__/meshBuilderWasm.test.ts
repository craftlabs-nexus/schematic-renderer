import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initSync, MeshBuilder } from "../../wasm/mesh_builder_wasm.js";

// The WASM mesh builder as shipped (src/wasm, built from mesh_builder_wasm/): the renderer's default mesher. Tests
// run from the package root.
beforeAll(() => {
	initSync({ module: readFileSync(resolve(process.cwd(), "src/wasm/mesh_builder_wasm_bg.wasm")) });
});

/** A quad facing -x at `x` (block-centred coordinates), as two triangles. */
function westQuad(x: number) {
	return {
		positions: new Float32Array([x, -0.5, -0.5, x, -0.5, 0.5, x, 0.5, 0.5, x, 0.5, -0.5]),
		normals: new Float32Array([-1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0]),
		uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
		indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
		materialIndex: 0,
	};
}

describe("WASM mesh builder face culling", () => {
	it("culls a face on the block's boundary against a solid neighbour, not one in its middle plane", () => {
		const builder = new MeshBuilder();
		builder.update_palette([
			// a repeater-like block: one west face on its boundary, one in its middle plane (a torch's side)
			{ index: 0, occlusionFlags: 0, category: "solid", geometries: [westQuad(-0.5), westQuad(0)] },
			// stone: occludes all six faces, nothing of its own to draw here
			{ index: 1, occlusionFlags: 63, category: "solid", geometries: [] },
		]);
		// the block at x = 1, stone to its west at x = 0
		const out = builder.build_chunk(
			new Int32Array([1, 0, 0, 0, 0, 0, 0, 1]),
			0,
			0,
			0,
			new Int32Array()
		);
		const triangles = out.meshes.reduce(
			(n: number, m: { indices: ArrayLike<number> }) => n + m.indices.length / 3,
			0
		);
		// the middle-plane quad (2 triangles) stays; the boundary quad is hidden by the stone
		expect(triangles).toBe(2);
		builder.free();
	});
});
