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

describe("WASM mesh builder binary", () => {
	it("names no absolute path of the machine it was built on (npm run build:wasm remaps them)", () => {
		const text = readFileSync(
			resolve(process.cwd(), "src/wasm/mesh_builder_wasm_bg.wasm")
		).toString("latin1");
		// rustc embeds source paths for panics: a Windows drive path or a Unix home directory would name the builder
		expect(text).not.toMatch(/[A-Za-z]:[\\/](Users|home)[\\/]/i);
		expect(text).not.toMatch(/\/(Users|home)\/[^/\0]+\//);
	});
});

/** A unit cube centred on the block (six quads, two triangles each), in one material. */
function cube(materialIndex = 0) {
	const faces: Array<[number[], number[]]> = [
		// normal, then the corner order of its quad
		[
			[1, 0, 0],
			[0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5],
		],
		[
			[-1, 0, 0],
			[-0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, -0.5],
		],
		[
			[0, 1, 0],
			[-0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, -0.5],
		],
		[
			[0, -1, 0],
			[-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, -0.5, -0.5, 0.5],
		],
		[
			[0, 0, 1],
			[-0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5],
		],
		[
			[0, 0, -1],
			[-0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, -0.5, -0.5],
		],
	];
	const positions: number[] = [],
		normals: number[] = [],
		uvs: number[] = [],
		indices: number[] = [];
	faces.forEach(([n, corners], f) => {
		positions.push(...corners);
		for (let i = 0; i < 4; i++) normals.push(...n);
		uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
		indices.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3);
	});
	return {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		uvs: new Float32Array(uvs),
		indices: new Uint32Array(indices),
		materialIndex,
	};
}

describe("WASM mesh builder layers", () => {
	const stone = () => {
		const builder = new MeshBuilder();
		builder.update_palette([
			{ index: 0, occlusionFlags: 63, category: "solid", geometries: [cube(0)] },
			{ index: 1, occlusionFlags: 63, category: "solid", geometries: [cube(1)] },
		]);
		return builder;
	};
	const triangles = (out: { meshes: Array<{ indices: ArrayLike<number> }> }) =>
		out.meshes.reduce((n, m) => n + m.indices.length / 3, 0);
	// the y of each triangle's first vertex, as the mesh lays them out
	const runs = (mesh: { layers: Int32Array }) => {
		const out: Array<[number, number, number]> = [];
		for (let i = 0; i < mesh.layers.length; i += 3)
			out.push([mesh.layers[i], mesh.layers[i + 1], mesh.layers[i + 2]]);
		return out;
	};

	it("orders a mesh's triangles by material, then layer, and says where each layer's run is", () => {
		const builder = stone();
		// a column of three: material 0 at y 0 and 2, material 1 at y 1
		const out = builder.build_chunk(
			new Int32Array([0, 0, 0, 0, 0, 1, 0, 1, 0, 2, 0, 0]),
			0,
			0,
			0,
			new Int32Array()
		);
		const [mesh] = out.meshes;
		// y 0: 5 faces (its top is under y 1), y 1: 4, y 2: 5; two triangles a face
		expect(runs(mesh)).toEqual([
			[0, 0, 30],
			[2, 30, 30],
			[1, 60, 24],
		]);
		expect(mesh.groups).toEqual([
			{ start: 0, count: 60, materialIndex: 0 },
			{ start: 60, count: 24, materialIndex: 1 },
		]);
		builder.free();
	});

	it("builds the faces between two layers as caps: up for the lower layer, down for the upper", () => {
		const builder = stone();
		const lower = new Int32Array([0, 0, 0, 0]),
			upper = new Int32Array([0, 1, 0, 0]);
		const up = builder.build_caps(lower, 0, 0, 0, upper, 1);
		expect(triangles(up)).toBe(2);
		// the cap is the lower block's top face: every vertex at y 0.5 (positions quantized by 1024)
		const [cap] = up.meshes;
		const ys = Array.from(cap.indices as ArrayLike<number>, (v) => cap.positions[v * 3 + 1]);
		expect(ys.every((y) => y === 512)).toBe(true);
		expect(triangles(builder.build_caps(upper, 0, 1, 0, lower, -1))).toBe(2);
		// nothing above: no cap (the top face is in the mesh itself)
		expect(triangles(builder.build_caps(upper, 0, 1, 0, new Int32Array(), 1))).toBe(0);
		builder.free();
	});
});
