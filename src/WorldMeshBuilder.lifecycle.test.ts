import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

// The same stand-ins as WorldMeshBuilder.palette.test.ts, so the module loads without WASM, workers or a renderer.
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
	MaterialRegistry: {
		getMaterial: vi.fn((m: THREE.Material) => m),
		peekMaterial: () => undefined,
		releaseMaterial: vi.fn(),
	},
}));
vi.mock("./InstancedBlockRenderer");

import { WorldMeshBuilder, blocksForWorker } from "./WorldMeshBuilder";
import { MaterialRegistry } from "./MaterialRegistry";

// A mesh builder whose Cubane makes a box for every block, `delay` ms each, and counts them.
function builder(delay = 5) {
	const wmb = Object.create(WorldMeshBuilder.prototype) as any;
	Object.assign(wmb, { palettes: new Map(), schematicPalettes: new WeakMap() });
	const posted: any[] = [];
	let made = 0;
	Object.assign(wmb, {
		schematicRenderer: { options: {} },
		paletteCache: null,
		paletteKey: "",
		palettesPending: new Map(),
		paletteGeneration: 0,
		paletteContextId: null,
		nextPaletteId: 0,
		connectingPalette: new Set(),
		gpuInitPromise: null,
		useGPUCompute: false,
		useWasmMeshBuilder: true,
		useSharedMemory: false,
		sharedMemoryPool: null,
		chunkSize: 16,
		meshContextId: "mctx-test",
		lentWorkers: new Set(),
		workers: [{ postMessage: (m: any) => posted.push(m) }],
		initializeWorkers() {},
		cubane: {
			prepareBlockEntityModels: async () => {},
			isConnectingBlock: async (block: string) => block.includes("glass"),
			getBlockMesh: async () => {
				made++;
				await new Promise((res) => setTimeout(res, delay));
				return new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
			},
			getBlockOptimizationData: async () => null,
			shapeCacheKey: () => null,
			isBlockEntityModel: () => false,
		},
	});
	return { wmb, posted, made: () => made };
}
const palette = (...names: string[]) => names.map((name) => ({ name, properties: {} }));

describe("a chunk's blocks sent to a worker without SharedArrayBuffer", () => {
	it("are a copy: the chunk keeps its blocks for the connected-texture blocks and the caller", async () => {
		const { wmb } = builder();
		// a worker as the browser's: postMessage moves (detaches) the buffers it is given
		const worker: any = {
			postMessage: (m: any, transfer?: Transferable[]) => {
				if (transfer?.length) structuredClone(m, { transfer });
				if (m.type === "buildChunk")
					queueMicrotask(() =>
						wmb.handleWorkerMessage(worker, {
							data: { type: "chunkBuilt", chunkId: m.chunkId, meshes: [], origin: [0, 0, 0] },
						})
					);
			},
		};
		Object.assign(wmb, {
			workers: [worker],
			freeWorkers: [worker],
			workerQueue: [],
			queuedWaiters: new Map(),
			pendingRequests: new Map(),
			nextChunkRequest: 1,
		});
		const seen: number[] = [];
		wmb.buildConnectedBlockMeshes = async (blocks: Int32Array) => {
			seen.push(blocks.length);
			return [];
		};
		vi.spyOn(console, "log").mockImplementation(() => {});
		await wmb.precomputePaletteGeometries(palette("minecraft:air", "minecraft:glass"));
		const schematic = { getBlockEntitiesMap: () => new Map(), cellGroupsOf: () => undefined };
		const blocks = new Int32Array([0, 0, 0, 1, 1, 0, 0, 1]);
		await wmb.getChunkMesh({ blocks, chunk_x: 0, chunk_y: 0, chunk_z: 0 }, schematic);
		// the glass blocks were read from an emptied array, and never drawn
		expect(seen).toEqual([8]);
		expect(blocks.length).toBe(8);
	});

	it("moves the copy's buffer, not the caller's", () => {
		const blocks = new Int32Array([1, 2, 3, 4]);
		const sent = blocksForWorker(blocks);
		expect(sent.blocks).not.toBe(blocks);
		expect(Array.from(sent.blocks)).toEqual([1, 2, 3, 4]);
		expect(sent.transfer).toEqual([sent.blocks.buffer]);
		const list = [[1, 2, 3, 4]];
		expect(blocksForWorker(list)).toEqual({ blocks: list, transfer: [] });
	});
});

describe("a pack switch while a palette builds", () => {
	it("builds the palette again from the new packs instead of keeping the one made from the old", async () => {
		const { wmb, posted, made } = builder(10);
		vi.spyOn(console, "log").mockImplementation(() => {});
		const p = palette("minecraft:stone", "minecraft:dirt", "minecraft:sand");
		const first = wmb.precomputePaletteGeometries(p);
		await new Promise((res) => setTimeout(res, 2)); // the build is under way
		wmb.invalidateCache(); // the packs change
		const second = wmb.precomputePaletteGeometries(p);
		await Promise.all([first, second]);
		// every block made twice: the first build was from the old packs
		expect(made()).toBe(6);
		expect(wmb.paletteCache?.isReady).toBe(true);
		// one palette went to the workers, the one made after the switch
		const uploads = posted.filter((m) => m.type === "updatePalette");
		expect(uploads).toHaveLength(1);
		expect(wmb.palettes.get(wmb.paletteKey)?.contextId).toBe(uploads[0].meshContextId);
	});

	it("does not keep shapes made across the switch under the old packs", async () => {
		const { wmb } = builder(10);
		vi.spyOn(console, "log").mockImplementation(() => {});
		let packs = "old";
		wmb.cubane.shapeCacheKey = () => packs;
		wmb.cubane.alphaClasses = () => ({ "block/stone": "opaque" });
		wmb.cubane.seedAlphaClasses = () => {};
		wmb.cubane.faceMaterialSpec = () => null;
		// one cache per pack set, each recording what is kept in it
		const kept = new Map<string, unknown[]>();
		const { ShapeCache } = await import("./cubane/ShapeCache");
		vi.spyOn(ShapeCache, "open").mockImplementation(async (set: string) => {
			const key = set.split("|")[0];
			return {
				getMany: async () => ({ shapes: new Map(), alpha: {} }),
				putMany: async (...args: unknown[]) => void kept.set(key, args),
			} as any;
		});
		const p = palette("minecraft:stone");
		const first = wmb.precomputePaletteGeometries(p);
		await new Promise((res) => setTimeout(res, 2));
		packs = "new";
		wmb.invalidateCache();
		await first;
		// the build made across the switch kept nothing under the old packs; the one after it kept its own
		expect(kept.has("old")).toBe(false);
		expect(kept.has("new")).toBe(true);
	});
});

describe("a builder on a shared worker pool, disposed while it holds a worker", () => {
	it("gives the worker back to the pool, to a builder waiting for one first", async () => {
		const { wmb } = builder();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const posted: any[] = [];
		const shared: any = { postMessage: (m: any) => posted.push(m), terminate() {} };
		// the context's pool (SchematicRendererContext): one worker, free
		const context = { sharedFreeWorkers: [shared] as any[], sharedWorkerQueue: [] as any[] };
		Object.assign(wmb, {
			schematicRenderer: { options: { context } },
			workers: [shared],
			freeWorkers: context.sharedFreeWorkers,
			workerQueue: context.sharedWorkerQueue,
			queuedWaiters: new Map(),
			lentWorkers: new Set(),
			capsRequests: new Map(),
			nextCapsRequest: 1,
			pendingRequests: new Map(),
			batchPendingChunks: new Map(),
			batchFinishes: new Map(),
		});
		await wmb.precomputePaletteGeometries(palette("minecraft:air", "minecraft:stone"));
		const piece = {
			blocks: new Int32Array([0, 0, 0, 1]),
			apron: new Int32Array(0),
			cellGroups: new Uint16Array(1),
			origin: [0, 0, 0],
		};
		const caps = wmb.buildCaps([piece]); // borrows the worker; its answer never comes
		await new Promise((res) => setTimeout(res, 0));
		expect(context.sharedFreeWorkers).toEqual([]);
		// another renderer on the context waits for a worker
		let handed: unknown = null;
		context.sharedWorkerQueue.push((worker: unknown) => (handed = worker));

		wmb.dispose();
		expect(await caps).toEqual([]);
		// the pool lost the worker for good, and the waiting builder waited for ever
		expect(handed).toBe(shared);
		// the palette the caps held is dropped in the shared workers too
		expect(posted.some((m) => m.type === "dropPalette")).toBe(true);
	});
});

describe("a palette dropped", () => {
	it("releases the registry references its build took", async () => {
		const { wmb } = builder(0);
		vi.spyOn(console, "log").mockImplementation(() => {});
		// a block's mesh as Cubane makes it: a group of meshes, one material each
		wmb.cubane.getBlockMesh = async () => {
			const block = new THREE.Group();
			block.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
			return block;
		};
		wmb.cubane.faceMaterialSpec = () => null;
		const taken = vi.mocked(MaterialRegistry.getMaterial);
		const released = vi.mocked(MaterialRegistry.releaseMaterial);
		taken.mockClear();
		released.mockClear();
		await wmb.precomputePaletteGeometries(palette("minecraft:stone", "minecraft:dirt"));
		const tookFirst = taken.mock.results.map((r) => r.value);
		expect(tookFirst).toHaveLength(2);
		// another palette is built and made the last one; the first, used by no schematic, is dropped
		await wmb.precomputePaletteGeometries(palette("minecraft:sand"));
		// the references only grew until a pack switch cleared the registry
		expect(released.mock.calls.map((c) => c[0])).toEqual(tookFirst);
	});
});

describe("palettes building at once", () => {
	it("are each built once, whichever is asked for again meanwhile", async () => {
		const { wmb, made } = builder(5);
		vi.spyOn(console, "log").mockImplementation(() => {});
		const a = palette("minecraft:stone", "minecraft:dirt");
		const b = palette("minecraft:sand");
		const builds = [wmb.precomputePaletteGeometries(a), wmb.precomputePaletteGeometries(b)];
		// the first again while both build: it waited only for the last one asked for, and built the first again
		builds.push(wmb.precomputePaletteGeometries(a));
		await Promise.all(builds);
		expect(made()).toBe(3);
	});
});

describe("a connected-texture block in the palette", () => {
	it("is there for its neighbours to cull against, with no geometry of its own", async () => {
		const { wmb, posted } = builder(0);
		vi.spyOn(console, "log").mockImplementation(() => {});
		// a block's mesh as Cubane makes it: a group of meshes
		wmb.cubane.getBlockMesh = async () => {
			const block = new THREE.Group();
			block.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
			return block;
		};
		wmb.cubane.faceMaterialSpec = () => null;
		await wmb.precomputePaletteGeometries(palette("minecraft:stone", "minecraft:glass"));
		const upload = posted.find((m) => m.type === "updatePalette");
		const glass = upload.paletteData.find((e: any) => e.index === 1);
		// it had no entry, so no face beside it was ever hidden against it
		expect(glass).toBeDefined();
		expect(glass.geometries).toEqual([]);
		expect(typeof glass.cullKey).toBe("string");
		// and its culling, with every block's, is there for the connected blocks' own faces
		const state = wmb.palettes.get(wmb.paletteKey);
		expect([...state.cullByBlock.keys()].sort()).toEqual(["minecraft:glass", "minecraft:stone"]);
	});
});

describe("a batch mesh's normals", () => {
	const wmb = (webgpu: boolean) =>
		Object.assign(Object.create(WorldMeshBuilder.prototype), {
			schematicRenderer: { renderManager: { isWebGPU: webgpu } },
		}) as any;
	const normals = new Int8Array([0, 127, 0, 0, -127, 0]);

	it("stay 8-bit and normalised for WebGL, a quarter of the bytes of floats", () => {
		const attribute = wmb(false).normalAttribute(normals);
		expect(attribute.array).toBe(normals);
		expect(attribute.normalized).toBe(true);
	});

	it("are floats for the WebGPU renderer, whose vertex buffers need a stride of 4 bytes", () => {
		const attribute = wmb(true).normalAttribute(normals);
		expect(attribute.array).toBeInstanceOf(Float32Array);
		expect(Array.from(attribute.array)).toEqual([0, 1, 0, 0, -1, 0]);
	});
});
