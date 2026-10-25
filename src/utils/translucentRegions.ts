// Drawing translucent blocks (water, stained glass, ice, slime, honey) in a usable order.
//
// Translucent materials blend without writing depth, so what draws last shows on top. three.js draws its transparent
// objects back to front by the depth of each object's centre, unless their renderOrder differs: then renderOrder
// wins. So every block mesh gets the same renderOrder, whatever its category, and the distance decides.
//
// A batched mesh spans up to 64 chunks, and inside one mesh the triangles blend in index order: sorting meshes that
// large means little (a lake's water and the glass beside it share one centre). So the triangles of translucent
// materials leave their batch for meshes of their own, one per region of the world, each with its layer runs, so a
// layer range or hidden cell groups still show without a rebuild (utils/layerRange.ts). Opaque and cutout materials
// write depth and stay in the batch.

import { runsWithMaterial } from "./layerRange";

/** The renderOrder of every block mesh: one value, so three.js sorts translucent meshes by distance. */
export const BLOCK_RENDER_ORDER = 0;

/**
 * The edge of a translucent region, in blocks: two chunks. Smaller sorts better but draws more: each region is a
 * mesh, and a draw call for each translucent material in it (with the atlas, one or two). On a 228 x 131 x 206 test
 * build 24 meshes became 46 (16: 67, 64: 37).
 */
export const TRANSLUCENT_REGION_SIZE = 32;

type Group = { start: number; count: number; materialIndex: number };

/** A mesh as the WASM worker batches it: world Float32 positions, groups by material, layer runs. */
export interface BatchMesh {
	category: string;
	positions: Float32Array;
	normals?: Int8Array | Float32Array;
	uvs?: Float32Array;
	indices: Uint16Array | Uint32Array;
	groups: Group[];
	/** flat [layer, group, start, count, ...] index runs (layerRange.ts); absent when the mesher gave none */
	layers?: ArrayLike<number>;
	/** set on a mesh of translucent triangles: its region, in region units */
	translucentRegion?: [number, number, number];
	/** where each chunk's vertices begin, flat [chunkX, chunkY, chunkZ, firstVertex, ...] (utils/batchChunks.ts) */
	chunks?: ArrayLike<number>;
	/** each vertex's chunk, numbered in the order of `chunks`; carried with the vertices */
	vertexChunks?: Uint8Array | Uint16Array;
	[key: string]: unknown;
}

/** An index range of one material, and the layer and cell group it belongs to (none without runs). */
type Segment = { material: number; layer: number; group: number; start: number; count: number };

function segmentsOf(mesh: BatchMesh): { segments: Segment[]; hasRuns: boolean } {
	const runs = mesh.layers;
	if (!runs || runs.length === 0)
		return {
			segments: [...mesh.groups]
				.sort((a, b) => a.start - b.start)
				.map((g) => ({ material: g.materialIndex, layer: 0, group: 0, ...g })),
			hasRuns: false,
		};
	return {
		segments: runsWithMaterial(mesh.groups, runs).sort((a, b) => a.start - b.start),
		hasRuns: true,
	};
}

/** One output mesh being gathered: the vertices it uses (copied), its indices, groups and runs. */
class Gather {
	positions: number[] = [];
	normals: number[] = [];
	uvs: number[] = [];
	vertexChunks: number[] = [];
	indices: number[] = [];
	groups: Group[] = [];
	runs: number[] = [];
	private vertexCount = 0;
	private lastSegment = -1;

	constructor(
		private readonly id: number,
		private readonly src: BatchMesh,
		// shared by all the meshes of a split: which mesh last copied a vertex, and where it went
		private readonly owner: Int32Array,
		private readonly moved: Int32Array,
		// keep the source's vertex buffers as they are instead of copying the ones used
		private readonly inPlace = false
	) {}

	private vertex(v: number): number {
		if (this.inPlace) return v;
		if (this.owner[v] === this.id) return this.moved[v];
		const { positions, normals, uvs, vertexChunks } = this.src;
		this.positions.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
		if (normals) this.normals.push(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
		if (uvs) this.uvs.push(uvs[v * 2], uvs[v * 2 + 1]);
		if (vertexChunks) this.vertexChunks.push(vertexChunks[v]);
		this.owner[v] = this.id;
		this.moved[v] = this.vertexCount;
		return this.vertexCount++;
	}

	/** Appends the indices from..from+count of a segment (all of it, or some of its triangles). */
	add(segmentId: number, s: Segment, from: number, count: number) {
		const at = this.indices.length;
		for (let i = from; i < from + count; i++) this.indices.push(this.vertex(this.src.indices[i]));
		const lastGroup = this.groups[this.groups.length - 1];
		if (lastGroup?.materialIndex === s.material) lastGroup.count += count;
		else this.groups.push({ start: at, count, materialIndex: s.material });
		if (this.lastSegment === segmentId) this.runs[this.runs.length - 1] += count;
		else this.runs.push(s.layer, s.group, at, count);
		this.lastSegment = segmentId;
	}

	result(hasRuns: boolean): BatchMesh {
		const { src } = this;
		if (this.inPlace) {
			const n = src.positions.length / 3;
			return {
				category: src.category,
				positions: src.positions,
				normals: src.normals,
				uvs: src.uvs,
				vertexChunks: src.vertexChunks,
				indices: n > 65535 ? new Uint32Array(this.indices) : new Uint16Array(this.indices),
				groups: this.groups,
				layers: hasRuns ? Int32Array.from(this.runs) : undefined,
			};
		}
		const Normals = src.normals?.constructor as (new (a: number[]) => Int8Array) | undefined;
		const VertexChunks = src.vertexChunks?.constructor as
			(new (a: number[]) => Uint8Array | Uint16Array) | undefined;
		return {
			category: src.category,
			positions: new Float32Array(this.positions),
			normals: Normals ? new Normals(this.normals) : undefined,
			uvs: src.uvs ? new Float32Array(this.uvs) : undefined,
			vertexChunks: VertexChunks ? new VertexChunks(this.vertexChunks) : undefined,
			indices:
				this.vertexCount > 65535 ? new Uint32Array(this.indices) : new Uint16Array(this.indices),
			groups: this.groups,
			layers: hasRuns ? Int32Array.from(this.runs) : undefined,
		};
	}
}

/**
 * Splits a batched mesh: the triangles of the materials `translucent` names go to a mesh per region of `size`
 * blocks (by the block each triangle belongs to), in their order, with their layer runs; the rest stays together.
 * A mesh with no translucent material comes back as it is. A region's mesh copies the vertices it uses.
 */
export function splitTranslucentRegions(
	mesh: BatchMesh,
	translucent: (materialIndex: number) => boolean,
	size: number = TRANSLUCENT_REGION_SIZE
): BatchMesh[] {
	const { positions, indices } = mesh;
	if (!(positions instanceof Float32Array) || !indices?.length) return [mesh];
	if (!mesh.groups.some((g) => g.count > 0 && translucent(g.materialIndex))) return [mesh];

	const { segments, hasRuns } = segmentsOf(mesh);
	const vertexCount = positions.length / 3;
	const owner = new Int32Array(vertexCount).fill(-1);
	const moved = new Int32Array(vertexCount);
	// the rest keeps the batch's vertex buffers unless most of them were translucent (a lake's water)
	let translucentIndices = 0;
	for (const s of segments) if (translucent(s.material)) translucentIndices += s.count;
	const rest = new Gather(0, mesh, owner, moved, translucentIndices * 2 <= indices.length);
	const regions = new Map<number, { gather: Gather; at: [number, number, number] }>();
	const p = positions;
	// the region of the block a point is in (| 0 makes -0 a plain 0)
	const regionOf = (v: number) => Math.floor(Math.round(v) / size) | 0;

	segments.forEach((s, id) => {
		if (!translucent(s.material)) {
			rest.add(id, s, s.start, s.count);
			return;
		}
		for (let t = s.start; t + 2 < s.start + s.count; t += 3) {
			const a = indices[t] * 3,
				b = indices[t + 1] * 3,
				c = indices[t + 2] * 3;
			// the block the triangle belongs to (blocks are centred on whole coordinates): its centre, moved a
			// little behind it (against its winding's normal), so a face on a block's edge counts in that block
			const ux = p[b] - p[a],
				uy = p[b + 1] - p[a + 1],
				uz = p[b + 2] - p[a + 2];
			const vx = p[c] - p[a],
				vy = p[c + 1] - p[a + 1],
				vz = p[c + 2] - p[a + 2];
			const nx = uy * vz - uz * vy,
				ny = uz * vx - ux * vz,
				nz = ux * vy - uy * vx;
			const back = 0.01 / (Math.hypot(nx, ny, nz) || Infinity);
			const rx = regionOf((p[a] + p[b] + p[c]) / 3 - nx * back);
			const ry = regionOf((p[a + 1] + p[b + 1] + p[c + 1]) / 3 - ny * back);
			const rz = regionOf((p[a + 2] + p[b + 2] + p[c + 2]) / 3 - nz * back);
			// one number per region (a world spans far fewer than 2^16 regions an axis)
			const key = ((rx + 32768) * 65536 + (ry + 32768)) * 65536 + (rz + 32768);
			let region = regions.get(key);
			if (!region) {
				region = { gather: new Gather(regions.size + 1, mesh, owner, moved), at: [rx, ry, rz] };
				regions.set(key, region);
			}
			region.gather.add(id, s, t, 3);
		}
	});

	const out: BatchMesh[] = [];
	if (rest.indices.length) out.push(rest.result(hasRuns));
	for (const { gather, at } of regions.values())
		out.push({ ...gather.result(hasRuns), translucentRegion: at });
	return out;
}
