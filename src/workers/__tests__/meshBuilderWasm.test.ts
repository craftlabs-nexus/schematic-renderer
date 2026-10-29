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
			new Int32Array(),
			new Uint16Array()
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

describe("WASM mesh builder layers and groups", () => {
	const stone = () => {
		const builder = new MeshBuilder();
		builder.update_palette([
			{ index: 0, occlusionFlags: 63, category: "solid", geometries: [cube(0)] },
			{ index: 1, occlusionFlags: 63, category: "solid", geometries: [cube(1)] },
		]);
		return builder;
	};
	const none = new Uint16Array();
	const triangles = (out: { meshes: Array<{ indices: ArrayLike<number> }> }) =>
		out.meshes.reduce((n, m) => n + m.indices.length / 3, 0);
	// the runs as [layer, group, start, count]
	const runs = (mesh: { layers: Int32Array }) => {
		const out: number[][] = [];
		for (let i = 0; i < mesh.layers.length; i += 4)
			out.push(Array.from(mesh.layers.subarray(i, i + 4)));
		return out;
	};
	// the vertices a cap's triangles use (positions quantized by 1024)
	const capVertices = (mesh: { indices: ArrayLike<number>; positions: Int16Array }) =>
		Array.from(mesh.indices, (v) => [0, 1, 2].map((k) => mesh.positions[v * 3 + k] / 1024));

	it("orders a mesh's triangles by material, then layer, and says where each run is", () => {
		const builder = stone();
		// a column of three: material 0 at y 0 and 2, material 1 at y 1
		const out = builder.build_chunk(
			new Int32Array([0, 0, 0, 0, 0, 1, 0, 1, 0, 2, 0, 0]),
			0,
			0,
			0,
			new Int32Array(),
			none
		);
		const [mesh] = out.meshes;
		// y 0: 5 faces (its top is under y 1), y 1: 4, y 2: 5; two triangles a face
		expect(runs(mesh)).toEqual([
			[0, 0, 0, 30],
			[2, 0, 30, 30],
			[1, 0, 60, 24],
		]);
		expect(mesh.groups).toEqual([
			{ start: 0, count: 60, materialIndex: 0 },
			{ start: 60, count: 24, materialIndex: 1 },
		]);
		builder.free();
	});

	it("orders the blocks of one layer by their cell group", () => {
		const builder = stone();
		// three in a row along x, groups 2, 0, 2
		const out = builder.build_chunk(
			new Int32Array([0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0]),
			0,
			0,
			0,
			new Int32Array(),
			Uint16Array.from([2, 0, 2])
		);
		// the middle block: 4 faces (x faces covered); the ends 5 each
		expect(runs(out.meshes[0])).toEqual([
			[0, 0, 0, 24],
			[0, 2, 24, 60],
		]);
		builder.free();
	});

	it("caps the faces a hidden cell covered: below, above or beside", () => {
		const builder = stone();
		const at = (x: number, y: number) => new Int32Array([x, y, 0, 0]);
		// the lower block shown, the one above hidden: its top face
		const up = builder.build_caps(at(0, 0), 0, 0, 0, at(0, 1), none);
		expect(triangles(up)).toBe(2);
		expect(capVertices(up.meshes[0]).every(([, y]) => y === 0.5)).toBe(true);
		// the upper one shown, the lower hidden: its bottom face
		expect(triangles(builder.build_caps(at(0, 1), 0, 1, 0, at(0, 0), none))).toBe(2);
		// a block beside it hidden: the face toward it
		const side = builder.build_caps(at(0, 0), 0, 0, 0, at(1, 0), none);
		expect(capVertices(side.meshes[0]).every(([x]) => x === 0.5)).toBe(true);
		// nothing hidden beside it: no cap (its faces are in the mesh itself)
		expect(triangles(builder.build_caps(at(0, 1), 0, 1, 0, new Int32Array(), none))).toBe(0);
		// a face another shown block covers stays covered: two shown side by side, a hidden one above the first
		const pair = builder.build_caps(
			new Int32Array([0, 0, 0, 0, 1, 0, 0, 0]),
			0,
			0,
			0,
			at(0, 1),
			none
		);
		expect(triangles(pair)).toBe(2);
		builder.free();
	});
});

describe("WASM mesh builder culling by cull key and fluid", () => {
	// two blocks side by side along x, each a unit cube (12 triangles): the triangles drawn in all
	const pair = (a: Record<string, unknown>, b: Record<string, unknown>) => {
		const builder = new MeshBuilder();
		builder.update_palette([
			{ index: 0, geometries: [cube(0)], ...a },
			{ index: 1, geometries: [cube(1)], ...b },
		]);
		const out = builder.build_chunk(
			new Int32Array([0, 0, 0, 0, 1, 0, 0, 1]),
			0,
			0,
			0,
			new Int32Array(),
			new Uint16Array()
		);
		const n = out.meshes.reduce(
			(t: number, m: { indices: ArrayLike<number> }) => t + m.indices.length / 3,
			0
		);
		builder.free();
		return n;
	};
	const stone = { occlusionFlags: 63, category: "solid", cullKey: "solid" };
	const glass = { occlusionFlags: 63, category: "transparent", cullKey: "minecraft:glass" };
	const redGlass = {
		occlusionFlags: 63,
		category: "transparent",
		cullKey: "minecraft:red_stained_glass",
	};
	const leaves = { occlusionFlags: 0, category: "transparent", cullKey: "minecraft:oak_leaves" };
	const slime = { occlusionFlags: 63, category: "solid", cullKey: "minecraft:slime_block" };

	it("culls the face between two of the same see-through block", () => {
		expect(pair(glass, glass)).toBe(20);
	});

	it("keeps both faces between different see-through blocks", () => {
		// glass beside leaves or another glass lost both faces, and the gap showed through
		expect(pair(glass, leaves)).toBe(24);
		expect(pair(glass, redGlass)).toBe(24);
		expect(pair(leaves, leaves)).toBe(24);
	});

	it("keeps an opaque block's face beside a see-through one, and hides the see-through face", () => {
		// stone beside slime lost its face: the slime's side, see-through, showed nothing behind it
		expect(pair(stone, slime)).toBe(22);
		expect(pair(stone, glass)).toBe(22);
	});

	it("culls water against a waterlogged block's water, not the block's own faces", () => {
		const water = { occlusionFlags: 0, category: "water", cullKey: "minecraft:water", fluid: 1 };
		// a waterlogged block: its water cube and, of its own shape, a full-height west side that covers nothing
		// (a slab's half-high side)
		const builder = new MeshBuilder();
		builder.update_palette([
			{ index: 0, ...water, geometries: [{ ...cube(0), fluid: 1 }] },
			{
				index: 1,
				occlusionFlags: 0,
				category: "water",
				cullKey: "solid",
				fluid: 1,
				geometries: [
					{ ...cube(0), fluid: 1 },
					{ ...westQuad(-0.5), materialIndex: 1 },
				],
			},
		]);
		const out = builder.build_chunk(
			new Int32Array([0, 0, 0, 0, 1, 0, 0, 1]),
			0,
			0,
			0,
			new Int32Array(),
			new Uint16Array()
		);
		const byMaterial = new Map<number, number>();
		for (const m of out.meshes as Array<{
			groups: Array<{ count: number; materialIndex: number }>;
		}>)
			for (const g of m.groups)
				byMaterial.set(g.materialIndex, (byMaterial.get(g.materialIndex) ?? 0) + g.count / 3);
		// the two water cubes share no face (24 - 4); the block's own side stays (2)
		expect(byMaterial.get(0)).toBe(20);
		expect(byMaterial.get(1)).toBe(2);
		builder.free();
	});
});

describe("WASM mesh builder with a block drawn elsewhere", () => {
	// a connected-texture block: in the palette with its culling and no geometry (meshed per position elsewhere)
	const palette = [
		{ index: 0, occlusionFlags: 63, category: "solid", cullKey: "solid", geometries: [cube(0)] },
		{ index: 1, occlusionFlags: 63, category: "solid", cullKey: "solid", geometries: [] },
	];
	const triangles = (out: { meshes: Array<{ indices: ArrayLike<number> }> }) =>
		out.meshes.reduce((n, m) => n + m.indices.length / 3, 0);

	it("hides the faces of the blocks beside it, and draws nothing in its place", () => {
		const builder = new MeshBuilder();
		builder.update_palette(palette);
		// stone at x 0, the connected block at x 1
		const out = builder.build_chunk(
			new Int32Array([0, 0, 0, 0, 1, 0, 0, 1]),
			0,
			0,
			0,
			new Int32Array(),
			new Uint16Array()
		);
		// the stone's face against it is hidden (it was drawn: the block had no palette entry)
		expect(triangles(out)).toBe(10);
		builder.free();
	});

	it("draws nothing in its place when greedy meshing", () => {
		const builder = new MeshBuilder();
		builder.update_palette(palette);
		const out = builder.build_chunk_greedy(new Int32Array([1, 0, 0, 1]), 0, 0, 0, new Int32Array());
		// its six faces were drawn, in the first material, over the connected block's own mesh
		expect(triangles(out)).toBe(0);
		builder.free();
	});
});
