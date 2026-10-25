import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { applyLayerRange, CellFilter, sortByLayer } from "../layerRange";
import { BatchMesh, splitTranslucentRegions } from "../translucentRegions";

// Faces as the WASM worker batches them: world positions with blocks centred on whole coordinates, a quad per face
// wound to face outwards, groups by material and a layer run per face.
type Face = {
	at: [number, number, number];
	dir: [number, number, number];
	material: number;
	group?: number;
};

function batch(faces: Face[], { runs = true } = {}): BatchMesh {
	const positions: number[] = [],
		normals: number[] = [],
		uvs: number[] = [],
		indices: number[] = [],
		layers: number[] = [];
	const groups: BatchMesh["groups"] = [];
	for (const { at, dir, material, group = 0 } of faces) {
		const k = dir.findIndex((d) => d !== 0);
		const [u, v] = [0, 1, 2].filter((a) => a !== k);
		const base = positions.length / 3;
		for (const [du, dv] of [
			[-0.5, -0.5],
			[0.5, -0.5],
			[0.5, 0.5],
			[-0.5, 0.5],
		]) {
			const p = [...at];
			p[k] += dir[k] * 0.5;
			p[u] += du;
			p[v] += dv;
			positions.push(...p);
			normals.push(...dir.map((d) => d * 127));
			uvs.push(du + 0.5, dv + 0.5);
		}
		// wind the quad so its normal points along `dir`
		const a = new THREE.Vector3().fromArray(positions, base * 3);
		const b = new THREE.Vector3().fromArray(positions, (base + 1) * 3).sub(a);
		const c = new THREE.Vector3().fromArray(positions, (base + 2) * 3).sub(a);
		const outward = b.cross(c).dot(new THREE.Vector3(...dir)) > 0;
		const quad = outward ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
		const start = indices.length;
		indices.push(...quad.map((i) => base + i));
		const last = groups[groups.length - 1];
		if (last?.materialIndex === material) last.count += 6;
		else groups.push({ start, count: 6, materialIndex: material });
		layers.push(at[1], group, start, 6);
	}
	return {
		category: "solid",
		positions: new Float32Array(positions),
		normals: new Int8Array(normals),
		uvs: new Float32Array(uvs),
		indices: new Uint32Array(indices),
		groups,
		layers: runs ? Int32Array.from(layers) : undefined,
	};
}

const translucent = (m: number) => m >= 1; // 0 stone; 1 water, 2 stained glass

/** The triangles a mesh draws under a filter, by their material and corner positions. */
function drawn(mesh: BatchMesh, filter: CellFilter | null): string[] {
	const sorted = sortByLayer(mesh.indices, mesh.groups, mesh.layers ?? []);
	const geometry = new THREE.BufferGeometry();
	geometry.setIndex(new THREE.BufferAttribute(sorted.indices, 1));
	applyLayerRange(geometry, sorted.layerIndex, filter);
	const out: string[] = [];
	for (const g of geometry.groups)
		for (let t = g.start; t < g.start + g.count; t += 3) {
			const corners = [0, 1, 2].map((i) =>
				Array.from(
					mesh.positions.subarray(sorted.indices[t + i] * 3, sorted.indices[t + i] * 3 + 3)
				)
			);
			out.push(`${g.materialIndex}:${JSON.stringify(corners)}`);
		}
	return out;
}

const UP: [number, number, number] = [0, 1, 0];
const WEST: [number, number, number] = [-1, 0, 0];

describe("translucent triangles in regional meshes", () => {
	it("leaves a mesh with no translucent material as it is", () => {
		const mesh = batch([{ at: [0, 0, 0], dir: UP, material: 0 }]);
		expect(splitTranslucentRegions(mesh, translucent)).toEqual([mesh]);
		expect(splitTranslucentRegions(mesh, translucent)[0]).toBe(mesh);
	});

	it("moves each translucent triangle to its block's region and keeps the opaque ones together", () => {
		const mesh = batch([
			{ at: [0, 0, 0], dir: UP, material: 0 },
			{ at: [1, 0, 0], dir: UP, material: 1 },
			{ at: [40, 0, 0], dir: UP, material: 1 },
			// on the edge between regions 0 and 1 (x 31.5): the glass block at x 32 is in region 1
			{ at: [32, 0, 0], dir: WEST, material: 2 },
			{ at: [33, 0, 0], dir: UP, material: 0 },
		]);
		const [rest, ...regions] = splitTranslucentRegions(mesh, translucent, 32);
		expect(rest.translucentRegion).toBeUndefined();
		expect(rest.groups.map((g) => g.materialIndex)).toEqual([0]);
		expect(rest.indices.length).toBe(12);
		expect(regions.map((r) => r.translucentRegion)).toEqual([
			[0, 0, 0],
			[1, 0, 0],
		]);
		expect(regions[0].groups).toEqual([{ start: 0, count: 6, materialIndex: 1 }]);
		expect(regions[1].groups).toEqual([
			{ start: 0, count: 6, materialIndex: 1 },
			{ start: 6, count: 6, materialIndex: 2 },
		]);
		// a region holds the vertices it uses, nothing else
		expect(regions[1].positions.length).toBe(8 * 3);
		expect(Math.min(...regions[1].positions.filter((_, i) => i % 3 === 0))).toBe(31.5);
		expect(regions[1].normals).toBeInstanceOf(Int8Array);
	});

	it("draws the same triangles for any layer range or hidden group once split", () => {
		const faces: Face[] = [];
		for (let x = 0; x < 70; x += 3)
			for (let y = 0; y < 5; y++)
				faces.push({
					at: [x, y + (x % 2) * 30, x % 7],
					dir: x % 2 ? UP : WEST,
					material: (x + y) % 3,
					group: y % 2 ? 4 : 0,
				});
		const mesh = batch(faces);
		const parts = splitTranslucentRegions(mesh, translucent, 16);
		expect(parts.length).toBeGreaterThan(4);
		for (const filter of [
			null,
			{ range: { minY: 1, maxY: 3 }, hidden: null },
			{ range: null, hidden: new Set([4]) },
			{ range: { minY: 2, maxY: 33 }, hidden: new Set([0]) },
		]) {
			const whole = drawn(mesh, filter).sort();
			const split = parts.flatMap((p) => drawn(p, filter)).sort();
			expect(split).toEqual(whole);
		}
	});

	it("keeps the batch's vertex buffers for the rest unless most of them were translucent", () => {
		const mostlyStone = batch([
			{ at: [0, 0, 0], dir: UP, material: 0 },
			{ at: [1, 0, 0], dir: UP, material: 0 },
			{ at: [2, 0, 0], dir: UP, material: 1 },
		]);
		expect(splitTranslucentRegions(mostlyStone, translucent)[0].positions).toBe(
			mostlyStone.positions
		);
		const lake = batch([
			{ at: [0, 0, 0], dir: UP, material: 0 },
			{ at: [1, 0, 0], dir: UP, material: 1 },
			{ at: [2, 0, 0], dir: UP, material: 1 },
		]);
		const rest = splitTranslucentRegions(lake, translucent)[0];
		expect(rest.positions.length).toBe(4 * 3);
		expect(rest.indices.length).toBe(6);
		expect(Math.max(...rest.indices)).toBe(3);
	});

	it("splits a mesh without layer runs too (greedy meshing), leaving it without them", () => {
		const mesh = batch(
			[
				{ at: [0, 0, 0], dir: UP, material: 0 },
				{ at: [50, 0, 0], dir: UP, material: 2 },
			],
			{ runs: false }
		);
		const parts = splitTranslucentRegions(mesh, translucent);
		expect(parts).toHaveLength(2);
		for (const p of parts) expect(p.layers).toBeUndefined();
		expect(parts[1].groups).toEqual([{ start: 0, count: 6, materialIndex: 2 }]);
	});
});
