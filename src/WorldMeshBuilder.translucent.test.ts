import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { WebGLRenderList } from "three/src/renderers/webgl/WebGLRenderLists.js";

// The same stand-ins as WorldMeshBuilder.test.ts, so the module loads without WASM, workers or a renderer.
vi.mock("./wasm/minecraft_schematic_utils_bg.wasm", () => ({ default: "mock-utils-wasm" }));
vi.mock("nucleation", () => ({
	default: vi.fn().mockResolvedValue(undefined),
	SchematicWrapper: class {},
}));
vi.mock("./workers/MeshBuilder.worker?worker&inline", () => ({
	default: class MockWorker {
		postMessage() {}
		terminate() {}
		onmessage = null;
	},
}));
vi.mock("./SchematicRenderer");
vi.mock("./cubane", () => ({ Cubane: class {} }));
vi.mock("./managers/SchematicObject");
vi.mock("./MaterialRegistry");
vi.mock("./InstancedBlockRenderer");

import { WorldMeshBuilder } from "./WorldMeshBuilder";
import { BLOCK_RENDER_ORDER } from "./utils/translucentRegions";
import { cutChunkFromBatch, vertexChunksOf } from "./utils/batchChunks";

// Translucent materials draw without depth writes, so their draw order decides what shows in front. The meshes
// holding them used a renderOrder by category (water 3, glass 2), which beat three.js's back-to-front sort: water
// always covered the glass in front of it. Their triangles are now in regional meshes at one renderOrder.

const stone = new THREE.MeshBasicMaterial();
const water = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, opacity: 0.8 });
const glass = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, opacity: 0.6 });
const materials = [stone, water, glass];

function builder() {
	const wmb = Object.create(WorldMeshBuilder.prototype) as any;
	Object.assign(wmb, { palettes: new Map(), schematicPalettes: new WeakMap() });
	wmb.paletteCache = { isReady: true, palette: [], blockData: [], globalMaterials: materials };
	return wmb;
}

/** A batch of block tops (blocks centred on whole coordinates), a layer run each, as the WASM worker sends it. */
function batchOf(
	category: string,
	tops: Array<{ at: [number, number, number]; material: number }>
) {
	const positions: number[] = [],
		normals: number[] = [],
		indices: number[] = [],
		layers: number[] = [];
	const groups: Array<{ start: number; count: number; materialIndex: number }> = [];
	for (const { at, material } of tops) {
		const [x, y, z] = at;
		const base = positions.length / 3;
		positions.push(
			...[x - 0.5, y + 0.5, z - 0.5],
			...[x - 0.5, y + 0.5, z + 0.5],
			...[x + 0.5, y + 0.5, z + 0.5],
			...[x + 0.5, y + 0.5, z - 0.5]
		);
		normals.push(0, 127, 0, 0, 127, 0, 0, 127, 0, 0, 127, 0);
		const start = indices.length;
		indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
		groups.push({ start, count: 6, materialIndex: material });
		layers.push(y, 0, start, 6);
	}
	return {
		category,
		positions: new Float32Array(positions),
		normals: new Int8Array(normals),
		uvs: new Float32Array((positions.length / 3) * 2),
		indices: new Uint16Array(indices),
		groups,
		layers: Int32Array.from(layers),
	};
}

/** The translucent draws of some meshes in the order three.js makes them for a camera (WebGLRenderer.projectObject). */
function transparentOrder(meshes: THREE.Mesh[], camera: THREE.Camera): THREE.Mesh[] {
	camera.updateMatrixWorld();
	const projScreen = new THREE.Matrix4().multiplyMatrices(
		(camera as THREE.PerspectiveCamera).projectionMatrix,
		camera.matrixWorldInverse
	);
	// the typings name arguments the plain JS list does not need
	const list = new (WebGLRenderList as any)();
	list.init();
	for (const mesh of meshes) {
		mesh.updateMatrixWorld();
		mesh.geometry.computeBoundingSphere();
		const { x, y, z: cz } = (mesh.geometry.boundingSphere as THREE.Sphere).center;
		const z = new THREE.Vector4(x, y, cz, 1)
			.applyMatrix4(mesh.matrixWorld)
			.applyMatrix4(projScreen).z;
		const all = mesh.material as THREE.Material[];
		for (const group of mesh.geometry.groups)
			list.push(mesh, mesh.geometry, all[group.materialIndex ?? 0], 0, z, group);
	}
	list.sort();
	return list.transparent.map((item: { object: THREE.Mesh }) => item.object);
}

describe("translucent blocks drawn back to front", () => {
	it("gives every category's mesh the same renderOrder", () => {
		const wmb = builder();
		for (const category of ["solid", "water", "transparent", "emissive", "redstone"]) {
			const mesh = new THREE.Mesh(new THREE.BufferGeometry(), stone);
			mesh.renderOrder = 7;
			wmb.configureMeshForCategory(mesh, category);
			expect(mesh.renderOrder).toBe(BLOCK_RENDER_ORDER);
		}
	});

	it("puts a batch's translucent triangles in regional meshes, each showing its layers on its own", () => {
		const meshes: THREE.Mesh[] = builder().createMeshesFromBatchResult(
			{
				meshes: [
					batchOf("solid", [
						{ at: [0, 0, 0], material: 0 },
						{ at: [0, 1, 0], material: 2 }, // honey, say: translucent among the solids
						{ at: [100, 1, 0], material: 2 },
					]),
				],
			},
			materials
		);
		expect(meshes.map((m) => m.name)).toEqual([
			"batched_solid",
			"batched_solid_translucent",
			"batched_solid_translucent",
		]);
		const [rest, near, far] = meshes;
		expect(rest.geometry.groups).toEqual([{ start: 0, count: 6, materialIndex: 0 }]);
		expect(near.userData.translucentRegion).toEqual([0, 0, 0]);
		expect(far.userData.translucentRegion).toEqual([3, 0, 0]);
		for (const m of meshes) {
			expect(m.renderOrder).toBe(BLOCK_RENDER_ORDER);
			expect(m.geometry.userData.layerIndex).toBeTruthy();
		}
		expect(near.geometry.userData.layerIndex).toMatchObject({ min: 1, max: 1 });
		// its own bounds, not the batch's: what three.js sorts it by
		near.geometry.computeBoundingSphere();
		expect(near.geometry.boundingSphere?.center.x).toBeCloseTo(0);
	});

	it("draws glass in front of water after it, and water in front of glass after that", () => {
		const wmb = builder();
		// a pool at z 0 to 9 and a stained glass wall at z 40, in the same batch of chunks
		const pool = Array.from({ length: 10 }, (_, z) => ({
			at: [0, 0, z] as [number, number, number],
			material: 1,
		}));
		const meshes: THREE.Mesh[] = wmb.createMeshesFromBatchResult(
			{
				meshes: [batchOf("water", pool), batchOf("transparent", [{ at: [0, 0, 40], material: 2 }])],
			},
			materials
		);
		const named = (name: string) => meshes.filter((m) => m.name === name);
		const [waterMesh] = named("batched_water_translucent");
		const [glassMesh] = named("batched_transparent_translucent");
		expect([waterMesh, glassMesh].every(Boolean)).toBe(true);

		const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
		camera.position.set(0, 20, 80); // beyond the glass: it is in front of the water
		camera.lookAt(0, 0, 0);
		expect(transparentOrder(meshes, camera)).toEqual([waterMesh, glassMesh]);

		camera.position.set(0, 20, -60); // beyond the pool: the water is in front
		camera.lookAt(0, 0, 20);
		expect(transparentOrder(meshes, camera)).toEqual([glassMesh, waterMesh]);
	});
});

describe("a chunk cut out of a batch", () => {
	// the corners of each triangle a geometry still draws (degenerate ones draw nothing)
	function drawn(geometry: THREE.BufferGeometry): number[][] {
		const index = geometry.index!.array;
		const position = geometry.getAttribute("position");
		const out: number[][] = [];
		for (let t = 0; t + 2 < index.length; t += 3) {
			const [a, b, c] = [index[t], index[t + 1], index[t + 2]];
			if (a === b || b === c || a === c) continue;
			out.push([position.getX(a), position.getY(a), position.getZ(a)]);
		}
		return out;
	}

	it("hides its triangles in every mesh the batch made, translucent ones included, and no other chunk's", () => {
		// chunk 0,0,0 then chunk 1,0,0, each a stone top and a honey top; their vertices follow one another
		const batch = batchOf("solid", [
			{ at: [0, 0, 0], material: 0 },
			{ at: [0, 1, 0], material: 2 },
			{ at: [16, 0, 0], material: 0 },
			{ at: [17, 1, 0], material: 2 },
		]);
		const meshes: THREE.Mesh[] = builder().createMeshesFromBatchResult(
			{ meshes: [{ ...batch, chunks: Int32Array.from([0, 0, 0, 0, 1, 0, 0, 8]) }] },
			materials
		);
		expect(meshes).toHaveLength(2);
		const before = meshes.map((m) => drawn(m.geometry).length);
		expect(before).toEqual([4, 4]);
		const versions = meshes.map((m) => m.geometry.index!.version);
		expect(meshes.map((m) => cutChunkFromBatch(m.geometry, "0,0,0"))).toEqual([true, true]);
		// what is left is the other chunk's: its stone top at x 16 and its honey top at x 17
		const [rest, honey] = meshes.map((m) => drawn(m.geometry));
		expect(rest.length).toBe(2);
		expect(rest.every(([x]) => x > 15)).toBe(true);
		expect(honey.length).toBe(2);
		expect(honey.every(([x]) => x > 15)).toBe(true);
		// only the index buffer goes up again, and a second cut of the chunk has nothing to do
		meshes.forEach((m, i) => expect(m.geometry.index!.version).toBe(versions[i] + 1));
		expect(meshes.map((m) => cutChunkFromBatch(m.geometry, "0,0,0"))).toEqual([false, false]);
	});
});

describe("each vertex's chunk in a batch", () => {
	it("runs from where the chunk's vertices begin to where the next chunk's do, one number per chunk", () => {
		const { keys, ofVertex } = vertexChunksOf([0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 3], 5);
		expect(keys).toEqual(["0,0,0", "1,0,0"]);
		expect(Array.from(ofVertex)).toEqual([0, 0, 1, 0, 0]);
	});
});
