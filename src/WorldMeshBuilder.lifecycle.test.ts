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
	MaterialRegistry: { getMaterial: (m: THREE.Material) => m, peekMaterial: () => undefined },
}));
vi.mock("./InstancedBlockRenderer");

import { WorldMeshBuilder, blocksForWorker } from "./WorldMeshBuilder";

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
		palettePending: null,
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
