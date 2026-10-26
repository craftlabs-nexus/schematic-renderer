import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

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
vi.mock("./MaterialRegistry", () => ({
	MaterialRegistry: { getMaterial: (m: THREE.Material) => m, peekMaterial: () => undefined },
}));
vi.mock("./InstancedBlockRenderer");

import { WorldMeshBuilder } from "./WorldMeshBuilder";

// A mesh builder whose Cubane makes a box for every block, slowly enough for two palette builds to overlap; the
// messages its workers get are recorded.
function builder() {
	const wmb = Object.create(WorldMeshBuilder.prototype) as any;
	Object.assign(wmb, { palettes: new Map(), schematicPalettes: new WeakMap() });
	const posted: any[] = [];
	Object.assign(wmb, {
		schematicRenderer: { options: {} },
		paletteCache: null,
		paletteKey: "",
		palettePending: null,
		paletteContextId: null,
		nextPaletteId: 0,
		connectingPalette: new Set(),
		gpuInitPromise: null,
		useGPUCompute: false,
		useWasmMeshBuilder: true,
		meshContextId: "mctx-test",
		workers: [{ postMessage: (m: any) => posted.push(m) }],
		initializeWorkers() {},
		cubane: {
			prepareBlockEntityModels: async () => {},
			isConnectingBlock: async (block: string) => block.includes("glass"),
			getBlockMesh: async () => {
				await new Promise((res) => setTimeout(res, 5));
				return new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
			},
			getBlockOptimizationData: async () => null,
			// no packs' key: no shape cache (ShapeCache), every shape made
			shapeCacheKey: () => null,
		},
	});
	return { wmb, posted };
}

const palette = (...names: string[]) => names.map((name) => ({ name, properties: {} }));

describe("the palette cache", () => {
	it("is the palette asked for when two builds of the same palette overlap", async () => {
		const { wmb } = builder();
		const first = palette("minecraft:air", "minecraft:stone");
		const second = palette("minecraft:air", "minecraft:dirt", "minecraft:glass");
		await wmb.precomputePaletteGeometries(first);
		const a = wmb.precomputePaletteGeometries(second);
		// a second build of the same palette while the first is still at it
		await wmb.precomputePaletteGeometries(second);
		expect(wmb.paletteCache.palette).toBe(second);
		expect([...wmb.connectingPalette]).toEqual([2]);
		await a;
		expect(wmb.paletteCache.palette).toBe(second);
	});
});

describe("a caps build that fails in its worker", () => {
	it("draws no caps and gives the worker back, instead of waiting for good", async () => {
		const wmb = Object.create(WorldMeshBuilder.prototype) as any;
		Object.assign(wmb, { palettes: new Map(), schematicPalettes: new WeakMap() });
		const worker: any = {
			postMessage: (m: any) =>
				queueMicrotask(() =>
					wmb.handleWorkerMessage(worker, {
						data: { type: "error", error: "unreachable", requestId: m.requestId },
					})
				),
		};
		Object.assign(wmb, {
			paletteCache: { isReady: true, palette: [], blockData: [], globalMaterials: [] },
			useWasmMeshBuilder: true,
			useGPUCompute: false,
			meshContextId: "mctx-test",
			workers: [worker],
			freeWorkers: [worker],
			workerQueue: [],
			queuedWaiters: new Map(),
			capsRequests: new Map(),
			nextCapsRequest: 1,
			batchPendingChunks: new Map(),
			pendingRequests: new Map(),
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const piece = {
			blocks: new Int32Array([0, 0, 0, 1]),
			apron: new Int32Array([0, 1, 0, 1]),
			cellGroups: new Uint16Array(1),
			origin: [0, 0, 0],
		};
		expect(await wmb.buildCaps([piece])).toEqual([]);
		expect(wmb.freeWorkers).toEqual([worker]);
		expect(wmb.capsRequests.size).toBe(0);
	});
});

describe("two schematics of different palettes", () => {
	it("cap each against its own palette, whichever was built last, and drop a palette with its schematic", async () => {
		const { wmb, posted } = builder();
		const worker: any = {
			postMessage: (m: any) => {
				posted.push(m);
				if (m.type !== "buildCaps") return;
				const mesh = {
					category: "solid",
					positions: new Float32Array(9),
					normals: new Int8Array(9),
					uvs: new Float32Array(6),
					indices: new Uint16Array([0, 1, 2]),
					groups: [{ start: 0, count: 3, materialIndex: 0 }],
				};
				queueMicrotask(() =>
					wmb.handleWorkerMessage(worker, {
						data: { type: "capsBuilt", requestId: m.requestId, meshes: [mesh] },
					})
				);
			},
		};
		Object.assign(wmb, {
			workers: [worker],
			freeWorkers: [worker],
			workerQueue: [],
			queuedWaiters: new Map(),
			capsRequests: new Map(),
			nextCapsRequest: 1,
		});
		const a = {},
			b = {};
		await wmb.precomputePaletteGeometries(palette("minecraft:stone"), a);
		const aMaterials = wmb.paletteCache.globalMaterials;
		await wmb.precomputePaletteGeometries(palette("minecraft:dirt", "minecraft:sand"), b);
		const contexts = posted.filter((m) => m.type === "updatePalette").map((m) => m.meshContextId);
		expect(new Set(contexts).size).toBe(2);

		const piece = {
			blocks: new Int32Array([0, 0, 0, 0]),
			apron: new Int32Array([0, 1, 0, 0]),
			cellGroups: new Uint16Array(1),
			origin: [0, 0, 0],
		};
		const [cap] = await wmb.buildCaps([piece], a);
		expect(posted.find((m) => m.type === "buildCaps").meshContextId).toBe(contexts[0]);
		expect(cap.material).toBe(aMaterials);
		expect([wmb.getPaletteSize(a), wmb.getPaletteSize(b)]).toEqual([1, 2]);

		// a's palette goes with it; b's, the last built, stays
		wmb.releasePalette(a);
		expect(posted.filter((m) => m.type === "dropPalette").map((m) => m.meshContextId)).toEqual([
			contexts[0],
		]);
		expect(wmb.canBuildCaps(b)).toBe(true);
	});
});

describe("a request waiting for a worker", () => {
	// a worker that answers caps and chunks at once, recording what it was sent
	function answering(wmb: any, posted: any[]) {
		const worker: any = {
			postMessage: (m: any) => {
				posted.push(m);
				const data =
					m.type === "buildCaps"
						? { type: "capsBuilt", requestId: m.requestId, meshes: [] }
						: m.type === "buildChunk"
							? { type: "chunkBuilt", chunkId: m.chunkId, meshes: [], origin: [0, 0, 0] }
							: null;
				if (data) queueMicrotask(() => wmb.handleWorkerMessage(worker, { data }));
			},
		};
		Object.assign(wmb, {
			workers: [worker],
			freeWorkers: [],
			workerQueue: [],
			queuedWaiters: new Map(),
			capsRequests: new Map(),
			nextCapsRequest: 1,
			pendingRequests: new Map(),
		});
		return worker;
	}
	const piece = () => ({
		blocks: new Int32Array([0, 0, 0, 1]),
		apron: new Int32Array([0, 1, 0, 1]),
		cellGroups: new Uint16Array(1),
		origin: [0, 0, 0],
	});
	const drops = (posted: any[]) =>
		posted.filter((m) => m.type === "dropPalette").map((m) => m.meshContextId);

	it("meshes against its palette though an edit's new palette drops it meanwhile", async () => {
		const { wmb, posted } = builder();
		const worker = answering(wmb, posted);
		const s = { cellGroupsOf: () => undefined };
		await wmb.precomputePaletteGeometries(palette("minecraft:air", "minecraft:stone"), s);
		const old = wmb.paletteFor(s).contextId;
		const caps = wmb.buildCaps([piece()], s);
		const chunk = wmb.getChunkGeometries(
			{ blocks: new Int32Array([0, 0, 0, 1]), chunk_x: 0, chunk_y: 0, chunk_z: 0 },
			undefined,
			s
		);
		await new Promise((res) => setTimeout(res, 0));
		// an edit adds a block type: the schematic's palette is another one
		await wmb.precomputePaletteGeometries(
			palette("minecraft:air", "minecraft:stone", "minecraft:dirt"),
			s
		);
		expect(drops(posted)).toEqual([]);
		wmb.returnWorker(worker);
		await caps;
		wmb.returnWorker(worker);
		await chunk;
		const requests = posted.filter((m) => m.type === "buildCaps" || m.type === "buildChunk");
		expect(requests.map((m) => m.meshContextId)).toEqual([old, old]);
		// dropped once the last request with it is over
		expect(drops(posted)).toEqual([old]);
		expect(posted.findIndex((m) => m.type === "dropPalette")).toBeGreaterThan(
			posted.indexOf(requests[1])
		);
	});

	it("keeps its palette in the workers across invalidateCache until it is over", async () => {
		const { wmb, posted } = builder();
		const worker = answering(wmb, posted);
		const s = { cellGroupsOf: () => undefined };
		await wmb.precomputePaletteGeometries(palette("minecraft:air", "minecraft:stone"), s);
		const old = wmb.paletteFor(s).contextId;
		const caps = wmb.buildCaps([piece()], s);
		wmb.invalidateCache();
		expect(drops(posted)).toEqual([]);
		wmb.returnWorker(worker);
		await caps;
		expect(posted.find((m) => m.type === "buildCaps").meshContextId).toBe(old);
		expect(drops(posted)).toEqual([old]);
	});

	it("keeps a palette just built for its schematic though another is made the last built meanwhile", async () => {
		const { wmb, posted } = builder();
		const [a, b] = [{}, {}];
		await wmb.precomputePaletteGeometries(palette("minecraft:air", "minecraft:dirt"), b);
		const bPalette = wmb.paletteFor(b);
		// as a's palette is done, before a takes it, a build of b's (cached) palette makes that the last built
		const usePalette = wmb.usePalette.bind(wmb);
		wmb.usePalette = (state: any, schematic?: any) => {
			usePalette(state, schematic);
			if (state !== bPalette && !schematic) queueMicrotask(() => usePalette(bPalette, b));
		};
		await wmb.precomputePaletteGeometries(palette("minecraft:air", "minecraft:stone"), a);
		expect(wmb.canBuildCaps(a)).toBe(true);
		expect(drops(posted)).toEqual([]);
	});
});

describe("two builds at once", () => {
	// a worker that answers after `delay` ms, its batch's one mesh named for it
	function slowWorker(wmb: any, name: string, delay: number) {
		const worker: any = {
			postMessage: (m: any) => {
				const later = (data: object) =>
					setTimeout(() => wmb.handleWorkerMessage(worker, { data }), delay);
				if (m.type === "buildChunkBatched") later({ type: "chunkAccumulated", chunkId: m.chunkId });
				if (m.type === "buildChunk")
					later({ type: "chunkBuilt", chunkId: m.chunkId, meshes: [], origin: [0, 0, 0], name });
				if (m.type === "finishBatch")
					later({
						type: "batchFinished",
						batchId: m.batchId,
						meshes: [
							{
								category: name,
								positions: new Float32Array(9),
								normals: new Int8Array(9),
								uvs: new Float32Array(6),
								indices: new Uint16Array([0, 1, 2]),
								groups: [{ start: 0, count: 3, materialIndex: 0 }],
							},
						],
					});
			},
		};
		return worker;
	}
	const chunk = () => ({
		blocks: new Int32Array([0, 0, 0, 1]),
		chunk_x: 0,
		chunk_y: 0,
		chunk_z: 0,
	});
	const timeout = <T>(p: Promise<T>) =>
		Promise.race([p, new Promise((res) => setTimeout(() => res("hung"), 200))]);

	it("of the same chunk coordinates, batched, each finish with their own meshes", async () => {
		const { wmb } = builder();
		const [slow, fast] = [slowWorker(wmb, "slow", 20), slowWorker(wmb, "fast", 1)];
		Object.assign(wmb, {
			workers: [slow, fast],
			freeWorkers: [fast, slow],
			workerQueue: [],
			queuedWaiters: new Map(),
			batchPendingChunks: new Map(),
			batchFinishes: new Map(),
			pendingRequests: new Map(),
			nextChunkRequest: 1,
			nextBatchId: 1,
		});
		wmb.configureMeshForCategory = () => {};
		await wmb.precomputePaletteGeometries(palette("minecraft:air", "minecraft:stone"));
		const a = wmb.processChunksBatched([chunk()]);
		const b = wmb.processChunksBatched([chunk()]);
		const names = async (p: Promise<any>) => {
			const meshes: any = await timeout(p);
			return meshes === "hung" ? meshes : meshes.map((m: any) => m.name);
		};
		expect(await Promise.all([names(a), names(b)])).toEqual([["batched_slow"], ["batched_fast"]]);
	});

	it("of the same chunk, each hear their own worker's answer", async () => {
		const { wmb } = builder();
		const [slow, fast] = [slowWorker(wmb, "slow", 20), slowWorker(wmb, "fast", 1)];
		Object.assign(wmb, {
			workers: [slow, fast],
			freeWorkers: [fast, slow],
			workerQueue: [],
			queuedWaiters: new Map(),
			pendingRequests: new Map(),
			nextChunkRequest: 1,
		});
		await wmb.precomputePaletteGeometries(palette("minecraft:air", "minecraft:stone"));
		const a = wmb.getChunkGeometries(chunk());
		const b = wmb.getChunkGeometries(chunk());
		expect((await Promise.all([timeout(a), timeout(b)])).map((r: any) => typeof r)).toEqual([
			"object",
			"object",
		]);
		expect(wmb.freeWorkers.length).toBe(2);
	});
});

describe("dispose", () => {
	it("settles every request in flight or waiting for a worker, leaving other builders' waits queued", async () => {
		const { wmb } = builder();
		const silent: any = { postMessage() {}, terminate() {} };
		// the queue a context's builders share, with another builder's wait in it
		const othersWait = () => {};
		const queue = [othersWait];
		Object.assign(wmb, {
			workers: [silent],
			freeWorkers: [silent],
			workerQueue: queue,
			queuedWaiters: new Map(),
			capsRequests: new Map(),
			nextCapsRequest: 1,
			pendingRequests: new Map(),
			batchPendingChunks: new Map(),
			batchFinishes: new Map(),
			nextChunkRequest: 1,
			nextBatchId: 1,
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		await wmb.precomputePaletteGeometries(palette("minecraft:air", "minecraft:stone"));
		const piece = {
			blocks: new Int32Array([0, 0, 0, 1]),
			apron: new Int32Array(0),
			cellGroups: new Uint16Array(1),
			origin: [0, 0, 0],
		};
		const chunk = { blocks: new Int32Array([0, 0, 0, 1]), chunk_x: 0, chunk_y: 0, chunk_z: 0 };
		// the caps take the one worker, which never answers; the rest wait for it
		const caps = wmb.buildCaps([piece]);
		await new Promise((res) => setTimeout(res, 0));
		const settled = [
			caps,
			wmb.getChunkGeometries({ ...chunk, blocks: new Int32Array([0, 0, 0, 1]) }),
			wmb.getChunkMesh({ ...chunk }, { getBlockEntitiesMap: () => new Map() }),
			wmb.buildCaps([{ ...piece, blocks: new Int32Array([0, 0, 0, 1]) }]),
			wmb.processChunksBatched([{ ...chunk }]),
		].map((p) =>
			p.then(
				(v: unknown) => (Array.isArray(v) ? v.length : "geometries"),
				() => "rejected"
			)
		);
		await new Promise((res) => setTimeout(res, 0));
		wmb.dispose();
		const outcome = await Promise.race([
			Promise.all(settled),
			new Promise((res) => setTimeout(() => res("hung"), 200)),
		]);
		expect(outcome).toEqual([0, "geometries", "rejected", 0, "rejected"]);
		expect(queue).toEqual([othersWait]);
	});
});
