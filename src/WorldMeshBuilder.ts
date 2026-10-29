import * as THREE from "three";
import { SchematicRenderer } from "./SchematicRenderer";
import { SchematicObject } from "./managers/SchematicObject";
import { MaterialRegistry } from "./MaterialRegistry";
import type {
	ChunkMeshes,
	ProcessedBlockGeometry,
	PaletteMaterialGroup,
	PaletteBlockData,
	PaletteCache,
	ChunkGeometryData,
} from "./types";
// @ts-ignore
import { Cubane } from "./cubane";
import { InstancedBlockRenderer } from "./InstancedBlockRenderer";
import { performanceMonitor } from "./performance/PerformanceMonitor";
// Worker imports - Vite handles bundling
// @ts-ignore
import MeshBuilderWorker from "./workers/MeshBuilder.worker?worker&inline";
// @ts-ignore
import MeshBuilderWasmWorker from "./workers/MeshBuilderWasm.worker?worker&inline";
import { GPUCapabilityManager } from "./gpu/GPUCapabilityManager";
import { ComputeMeshBuilder } from "./gpu/ComputeMeshBuilder";
import { getSharedMemoryPool, SharedMemoryPool } from "./workers/SharedMemoryManager";
import { NeighborState } from "./cubane/ConnectedTextures";
import { mergeBufferGeometries } from "./cubane/mergeBufferGeometries";
import { formatBlockString, isAir, namespacedId } from "./cubane/blockString";
import { nextFrame } from "./utils/nextFrame";
import { ShapeCache, materialFingerprint, type CachedShape } from "./cubane/ShapeCache";
import { disposeObject } from "./utils/MemoryLeakFix";
import { LayerIndex, layerIndexOf, layerIndexOfPieces, sortByLayer } from "./utils/layerRange";
import { batchChunksOf, vertexChunksOf } from "./utils/batchChunks";
import { blocksInBounds, inRenderingBounds } from "./utils/renderingBounds";
import { chunkKey } from "./utils/chunks";
import { BLOCK_RENDER_ORDER, BatchMesh, splitTranslucentRegions } from "./utils/translucentRegions";
import { SOLID_CULL_KEY, FLUID_NONE, FLUID_WATER, FLUID_LAVA } from "./workers/faceCulling";
import { isWaterlogged, liquidOf } from "./cubane/liquids";

/**
 * A chunk's blocks as a worker message takes them without SharedArrayBuffer: a copy whose buffer is moved to the
 * worker. Moving the chunk's own buffer emptied the array for the caller, and getChunkMesh read it again afterwards
 * for the connected-texture blocks, which were then never drawn.
 */
export function blocksForWorker<T extends Int32Array | number[][]>(
	blocks: T
): { blocks: T; transfer: Transferable[] } {
	if (!(blocks instanceof Int32Array)) return { blocks, transfer: [] };
	const copy = blocks.slice();
	return { blocks: copy as T, transfer: [copy.buffer] };
}

/** Whether a face's material is drawn opaque (its texture has no see-through pixels): only such a face hides others. */
function isOpaqueMaterial(material: THREE.Material | undefined): boolean {
	if (!material) return false;
	const cls = material.userData?.alphaClass;
	if (cls) return cls === "opaque";
	return !material.transparent && !(material.alphaTest > 0);
}

export const INVISIBLE_BLOCKS = new Set([
	"minecraft:air",
	"minecraft:cave_air",
	"minecraft:void_air",
	"minecraft:structure_void",
	"minecraft:light",
	"minecraft:barrier",
]);

// Constants matching worker
const POSITION_SCALE = 1024;

/**
 * Convert Int8 normals to Float32 for WebGPU compatibility.
 * WebGPU requires vertex buffer strides to be multiples of 4 bytes.
 * Int8 with 3 components has stride 3, which is invalid for WebGPU.
 */
function convertInt8NormalsToFloat32(int8Normals: Int8Array): Float32Array {
	const float32Normals = new Float32Array(int8Normals.length);
	for (let i = 0; i < int8Normals.length; i++) {
		// Normalize from [-128, 127] to [-1.0, 1.0]
		float32Normals[i] = int8Normals[i] / 127.0;
	}
	return float32Normals;
}

/** What the worker sends back for buildCaps: per-category meshes as a batch's (MeshBuilderWasm.worker buildCaps). */
type CapsResult = {
	requestId: number;
	// the caps as a batch's meshes (an empty category with no indices)
	meshes?: BatchMesh[];
};

/**
 * A palette built (precomputePaletteGeometries): its cache, its connected-texture entries, the id its geometry has
 * in the workers, the schematics whose meshes were built against it, and the requests in flight with it
 * (holdPalette): its geometry stays in the workers until the last of them is over, though it is dropped meanwhile.
 */
type PaletteState = {
	key: string;
	cache: PaletteCache | null;
	connecting: Set<number>;
	contextId: string;
	users: Set<SchematicObject>;
	holds: number;
	// dropped while held: the workers let go of it once the last hold is
	dropped: boolean;
	// built from packs an invalidateCache has replaced since: never registered nor sent to the workers
	stale?: boolean;
	// the MaterialRegistry references its build took (one per geometry), released when it is dropped
	materialRefs?: THREE.Material[];
};

export class WorldMeshBuilder {
	// @ts-ignore
	private schematicRenderer: SchematicRenderer;
	private cubane: Cubane;
	private paletteCache: PaletteCache | null = null;
	// palette indices of blocks with connected textures, meshed per position
	private connectingPalette: Set<number> = new Set();
	private instancedRenderer: InstancedBlockRenderer | null = null;
	private useInstancedRendering: boolean = false;

	// Worker Pool. Each builder has a unique meshContextId so that when several
	// builders share one context's worker pool, their palettes stay separate in
	// the workers (one WASM MeshBuilder per id). Single-instance use is unaffected.
	private static nextMeshContextId = 0;
	private readonly meshContextId = `mctx-${WorldMeshBuilder.nextMeshContextId++}`;
	private workers: Worker[] = [];
	/** The last palette build's shapes: how many came from the shape cache, how many were made (and kept). */
	public shapeCacheStats: {
		palette: number;
		fromCache: number;
		made: number;
		cacheOn: boolean;
	} | null = null;
	private freeWorkers: Worker[] = [];
	private workerQueue: ((worker: Worker) => void)[] = []; // Queue for waiting tasks
	// this builder's waiters in workerQueue (shared with other builders on a context), each with its reject
	private queuedWaiters = new Map<(worker: Worker) => void, (reason: Error) => void>();
	// the workers this builder has borrowed (getFreeWorker) and not given back (returnWorker): dispose hands a shared
	// pool's back to it
	private lentWorkers = new Set<Worker>();
	private pendingRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (reason?: any) => void; worker: Worker }
	>();
	// Cap at 8 workers - more than that has diminishing returns and increases startup overhead
	private maxWorkers: number = Math.min(navigator.hardwareConcurrency || 4, 8);

	// Chunk size configuration for buffer sizing
	private chunkSize: number = 16; // Default Minecraft chunk size

	// Phase 2 optimizations configuration
	private useQuantization: boolean = false;

	// WebGPU Compute
	private useGPUCompute: boolean = false;
	private computeMeshBuilder: ComputeMeshBuilder | null = null;
	private gpuInitPromise: Promise<boolean> | null = null;

	// WASM Mesh Builder
	private useWasmMeshBuilder: boolean = false;

	// SharedArrayBuffer for zero-copy transfers
	private sharedMemoryPool: SharedMemoryPool | null = null;
	private useSharedMemory: boolean = false;

	constructor(schematicRenderer: SchematicRenderer, cubane: Cubane) {
		this.cubane = cubane;
		this.schematicRenderer = schematicRenderer;
		// Check WASM option (enabled by default)
		this.useWasmMeshBuilder = schematicRenderer.options.wasmMeshBuilderOptions?.enabled ?? true;
		// Check for custom maxWorkers setting
		const configuredMaxWorkers = schematicRenderer.options.wasmMeshBuilderOptions?.maxWorkers;
		if (configuredMaxWorkers && configuredMaxWorkers > 0) {
			this.maxWorkers = configuredMaxWorkers;
		}
		// Try GPU compute first, fall back to workers
		this.initializeGPUCompute();
	}

	/**
	 * Initialize WebGPU compute for mesh building
	 * Falls back to workers if WebGPU is not available
	 */
	private async initializeGPUCompute(): Promise<boolean> {
		if (this.gpuInitPromise) {
			return this.gpuInitPromise;
		}

		this.gpuInitPromise = this._doInitializeGPU();
		return this.gpuInitPromise;
	}

	private async _doInitializeGPU(): Promise<boolean> {
		try {
			// Check if GPU compute is enabled in options
			const gpuOptions = this.schematicRenderer.options.gpuComputeOptions;
			if (!gpuOptions?.enabled) {
				this.initializeWorkers();
				return false;
			}

			// Check if WebGPU is available
			const isAvailable = await GPUCapabilityManager.isWebGPUAvailable();
			if (!isAvailable) {
				this.initializeWorkers();
				return false;
			}

			// Initialize compute mesh builder
			this.computeMeshBuilder = new ComputeMeshBuilder();
			const success = await this.computeMeshBuilder.initialize();

			if (success) {
				this.useGPUCompute = true;
				console.warn("  WARNING: GPU compute is ~6x SLOWER than workers due to GPU→CPU readback!");
				console.warn("  Textures will not render correctly (wireframe only).");
				console.warn("  Set gpuComputeOptions.enabled = false for better performance.");
				return true;
			} else {
				console.warn("[WorldMeshBuilder] GPU compute init failed, using worker fallback");
				this.computeMeshBuilder = null;
				this.initializeWorkers();
				return false;
			}
		} catch (error) {
			console.warn("[WorldMeshBuilder] GPU compute error, using worker fallback:", error);
			this.computeMeshBuilder = null;
			this.initializeWorkers();
			return false;
		}
	}

	/**
	 * Check if GPU compute is being used
	 */
	public isUsingGPUCompute(): boolean {
		return this.useGPUCompute && this.computeMeshBuilder !== null;
	}

	private initializeWorkers() {
		if (this.workers.length > 0) return;

		// Initialize shared memory pool for zero-copy transfers
		this.sharedMemoryPool = getSharedMemoryPool();
		this.useSharedMemory = this.sharedMemoryPool.usingSharedMemory();

		const context = this.schematicRenderer.options.context;
		// Sharing is supported only for the WASM worker (the default), whose palette
		// is namespaced per meshContextId. The JS worker stays per-renderer.
		if (context && this.useWasmMeshBuilder) {
			// Share one worker pool across every renderer on this context (WASM is
			// initialized once per worker; palettes are namespaced by meshContextId).
			// onmessage is (re)bound per acquire in getFreeWorker, since workers are
			// borrowed exclusively by one builder at a time.
			this.workers = context.getSharedWorkers(this.maxWorkers, true);
			this.freeWorkers = context.sharedFreeWorkers;
			this.workerQueue = context.sharedWorkerQueue;
			return;
		}

		for (let i = 0; i < this.maxWorkers; i++) {
			// Use WASM worker if enabled, otherwise use JavaScript worker
			const worker = this.useWasmMeshBuilder
				? new MeshBuilderWasmWorker()
				: new MeshBuilderWorker();
			worker.onmessage = (event: MessageEvent) => this.handleWorkerMessage(worker, event);
			this.workers.push(worker);
			this.freeWorkers.push(worker);
		}
	}

	/**
	 * Check if using WASM mesh builder
	 */
	public isUsingWasmMeshBuilder(): boolean {
		return this.useWasmMeshBuilder && this.workers.length > 0;
	}

	/**
	 * Check if using SharedArrayBuffer
	 */
	public isUsingSharedMemory(): boolean {
		return this.useSharedMemory && this.sharedMemoryPool !== null;
	}

	// Greedy meshing state
	private greedyMeshingEnabled = false;

	/**
	 * Enable or disable greedy meshing optimization
	 * Greedy meshing merges coplanar faces into larger quads, reducing vertex count significantly
	 */
	public setGreedyMeshing(enabled: boolean): void {
		this.greedyMeshingEnabled = enabled;

		// Notify all workers
		for (const worker of this.workers) {
			worker.postMessage({ type: "setGreedyMeshing", enabled });
		}
	}

	/**
	 * Check if greedy meshing is enabled
	 */
	public isGreedyMeshingEnabled(): boolean {
		return this.greedyMeshingEnabled;
	}

	// Static stats collector
	static stats = {
		totalSetup: 0,
		totalSort: 0,
		totalMerge: 0,
		totalWorkerTime: 0,
		chunkCount: 0,
	};

	static resetStats() {
		this.stats = {
			totalSetup: 0,
			totalSort: 0,
			totalMerge: 0,
			totalWorkerTime: 0,
			chunkCount: 0,
		};
	}

	// Batch mode state: the chunks sent and the batches finishing, by ids unique to their build (chunkRequestId,
	// nextBatchId), so builds of two schematics at once hear their own answers
	private batchPendingChunks: Map<string, { resolve: () => void; reject: (err: any) => void }> =
		new Map();
	private batchFinishes = new Map<
		number,
		{ resolve: (data: any) => void; reject: (err: any) => void }
	>();
	private nextBatchId = 1;
	// for the ids of the chunk requests (chunkRequestId)
	private nextChunkRequest = 1;

	/**
	 * The id a chunk request goes to its worker with, which the worker answers with: unique to the request, so two
	 * builds of one chunk at once (two schematics' chunks at the same coordinates, or a rebuild meanwhile), and
	 * builders sharing the shared memory pool, do not take each other's answers.
	 */
	private chunkRequestId(chunk: string): string {
		return `${this.meshContextId}#${this.nextChunkRequest++}@${chunk}`;
	}

	// the palette the palette cache was built for (precomputePaletteGeometries), set with the cache; and the palette
	// being built, which a build of the same palette waits for
	private paletteKey = "";
	// each palette being built, by key: one slot let a third build of the first of two palettes building at once start
	// a second build of it
	private palettesPending = new Map<string, Promise<unknown>>();
	// bumped by invalidateCache (a pack switch): a palette build started under an older one is stale when it ends
	private paletteGeneration = 0;
	// The palettes built, by key, and each schematic's (the one its last build meshed with). One builder meshes every
	// schematic of a renderer, each with its own palette: a schematic's caps and chunk rebuilds mesh against its
	// own, in the workers under its own id, not against the last one built. A palette no schematic has, other than
	// the last built, is dropped.
	private palettes = new Map<string, PaletteState>();
	private schematicPalettes = new WeakMap<SchematicObject, PaletteState>();
	private paletteContextId: string | null = null;
	private nextPaletteId = 0;
	// caps in flight (buildCaps), by request id
	private capsRequests = new Map<number, (data: CapsResult) => void>();
	private nextCapsRequest = 1;

	private handleWorkerMessage(worker: Worker, event: MessageEvent) {
		const { type, chunkId, error, timings, ...data } = event.data;

		if (type === "chunkBuilt") {
			if (timings) {
				// the JavaScript mesher's phases (the WASM mesher's timings have none of them: they are left out)
				const add = (v: unknown) => (Number.isFinite(v) ? (v as number) : 0);
				WorldMeshBuilder.stats.totalSetup += add(timings.setup);
				WorldMeshBuilder.stats.totalSort += add(timings.sort);
				WorldMeshBuilder.stats.totalMerge += add(timings.merge);
				WorldMeshBuilder.stats.totalWorkerTime += add(timings.total);
				WorldMeshBuilder.stats.chunkCount++;
			}

			const request = this.pendingRequests.get(chunkId);
			if (request) {
				request.resolve(data);
				this.pendingRequests.delete(chunkId);

				// Return worker to pool
				this.returnWorker(worker);
			}
		} else if (type === "chunkAccumulated") {
			// Batch mode: chunk accumulated. The batch holds its worker for the whole
			// run (released in processChunksBatched's `finally`) — do NOT return it
			// here, or with a shared pool another build grabs it mid-batch and rebinds
			// onmessage, misrouting this build's remaining responses (deadlock at 0/N).
			const request = this.batchPendingChunks.get(chunkId);
			if (request) {
				request.resolve();
				this.batchPendingChunks.delete(chunkId);
			}
		} else if (type === "capsBuilt") {
			const resolve = this.capsRequests.get(data.requestId);
			if (resolve) {
				this.capsRequests.delete(data.requestId);
				resolve(data);
				this.returnWorker(worker);
			}
		} else if (type === "batchFinished") {
			// Batch mode complete - return accumulated meshes
			const finish = this.batchFinishes.get(data.batchId);
			if (finish) {
				this.batchFinishes.delete(data.batchId);
				finish.resolve(data);
			}
		} else if (type === "error") {
			const caps = data.requestId !== undefined ? this.capsRequests.get(data.requestId) : undefined;
			if (caps) {
				// a caps build that failed draws no caps (the filter still shows), and gives its worker back
				console.error("[WorldMeshBuilder] Caps build failed:", error);
				this.capsRequests.delete(data.requestId);
				caps({ requestId: data.requestId, meshes: [] });
				this.returnWorker(worker);
			} else if (chunkId && this.pendingRequests.has(chunkId)) {
				const request = this.pendingRequests.get(chunkId)!;
				request.reject(new Error(error));
				this.pendingRequests.delete(chunkId);
				this.returnWorker(worker);
			} else if (chunkId && this.batchPendingChunks.has(chunkId)) {
				// a batch's chunk: the batch fails (its worker is given back when it ends)
				this.batchPendingChunks.get(chunkId)!.reject(new Error(error));
				this.batchPendingChunks.delete(chunkId);
			} else if (data.batchId !== undefined && this.batchFinishes.has(data.batchId)) {
				this.batchFinishes.get(data.batchId)!.reject(new Error(error));
				this.batchFinishes.delete(data.batchId);
			} else {
				console.error("[WorldMeshBuilder] Worker error:", error);
			}
		} else if (type === "paletteUpdated") {
			// Optional: handle palette update confirmation
		}
	}

	private returnWorker(worker: Worker) {
		this.lentWorkers.delete(worker);
		if (!this.workers.includes(worker)) return; // Worker might have been terminated

		if (this.workerQueue.length > 0) {
			const resolve = this.workerQueue.shift()!;
			resolve(worker);
		} else {
			this.freeWorkers.push(worker);
		}
	}

	public setChunkSize(newChunkSize: number): void {
		if (newChunkSize <= 0 || newChunkSize > 64) {
			throw new Error("Chunk size must be between 1 and 64");
		}
		this.chunkSize = newChunkSize;
	}

	public getChunkSize(): number {
		return this.chunkSize;
	}

	public setQuantization(enabled: boolean): void {
		this.useQuantization = enabled;
	}

	public getQuantization(): boolean {
		return this.useQuantization;
	}

	/**
	 * What a block tells its neighbours about hiding their faces (faceCulling.ts, faceHiddenBy): the sides its shape
	 * covers fully, and who they hide. A side covered by opaque faces hides any face against it (cull key "solid");
	 * a block with a full side that is not opaque (glass, ice, slime, a copper grate: cutout or translucent
	 * textures) is keyed by its id, so its full sides hide only the same block's faces, as the game culls glass
	 * against glass only. Leaves hide nothing (the game's fancy leaves). A fluid's own faces cull against the same
	 * fluid (the entry's `fluid`), not through these flags.
	 */
	private async computeCulling(
		blockString: string
	): Promise<{ occlusionFlags: number; cullKey: string }> {
		const id = blockString.replace(/\[.*$/, "");
		if (liquidOf(id) || WorldMeshBuilder.LEAVES.test(id)) {
			return { occlusionFlags: 0, cullKey: id };
		}
		const { opaque, seeThrough } = await this.computeFullSides(blockString);
		return seeThrough === 0
			? { occlusionFlags: opaque, cullKey: SOLID_CULL_KEY }
			: { occlusionFlags: opaque | seeThrough, cullKey: id };
	}

	/** The sides a block's faces cover fully (by their `cullface`), split by whether every such face is opaque. */
	private async computeFullSides(
		blockString: string
	): Promise<{ opaque: number; seeThrough: number }> {
		try {
			// @ts-ignore - Accessing Cubane's optimization data
			const data = await this.cubane.getBlockOptimizationData(blockString, "plains", true);

			if (!data || !data.cullableFaces) {
				return { opaque: 0, seeThrough: 0 };
			}

			let opaque = 0;
			let seeThrough = 0;
			const mapping: Record<string, number> = {
				west: 0,
				east: 1,
				down: 2,
				up: 3,
				north: 4,
				south: 5,
			};

			// @ts-ignore
			for (const [dir, faces] of data.cullableFaces.entries()) {
				const bit = mapping[dir];
				if (bit === undefined) continue;

				// the side is covered when one face spans it; opaque when one such face is opaque (a grass block's
				// cutout overlay lies over its opaque dirt side, which still hides what is behind it)
				let full = false;
				let fullOpaque = false;

				if (Array.isArray(faces)) {
					for (const face of faces) {
						// Check bounds if available to ensure it's a full face
						let isFullFace = false;
						if (face.elementBounds) {
							const [min, max] = face.elementBounds;
							// min and max are [x, y, z] in 0..16 coordinates typically
							const [a, b] =
								dir === "up" || dir === "down"
									? [0, 2]
									: dir === "north" || dir === "south"
										? [0, 1]
										: [1, 2];
							// Assume 16 is the full block size; allow a small epsilon for float precision.
							isFullFace = Math.abs(max[a] - min[a]) > 15.9 && Math.abs(max[b] - min[b]) > 15.9;
						} else {
							// Fallback if no bounds: trust 'isCube' property if available.
							// If it's a cube, all cullable faces are full faces.
							// @ts-ignore
							if (data.isCube) isFullFace = true;
						}
						if (!isFullFace) continue;
						full = true;
						if (isOpaqueMaterial(face.material)) fullOpaque = true;
					}
				}

				if (fullOpaque) opaque |= 1 << bit;
				else if (full) seeThrough |= 1 << bit;
			}

			return { opaque, seeThrough };
		} catch (e) {
			return { opaque: 0, seeThrough: 0 };
		}
	}

	/**
	 * Invalidate the palette cache to force re-computation of geometries.
	 * Call this when textures/materials change (e.g., resource pack change).
	 */
	public invalidateCache(): void {
		console.log("[WorldMeshBuilder] Invalidating cache");
		// a palette build still running is made from the packs being replaced: it ends stale (buildPaletteCache), and
		// whoever waits for it builds again
		this.paletteGeneration++;
		this.palettesPending.clear();
		for (const state of [...this.palettes.values()]) this.dropPalette(state);
		if (this.paletteCache) {
			this.paletteCache.blockData.forEach((blockData) => {
				blockData.materialGroups.forEach((group) => {
					if (group.baseGeometry) {
						group.baseGeometry.dispose();
					}
				});
			});
			this.paletteCache = null;
		}
		this.paletteKey = "";
	}

	/**
	 * The palette a schematic's meshes are built against: the one its last build used (precomputePaletteGeometries
	 * with the schematic), else the last one built.
	 */
	private paletteFor(schematicObject?: SchematicObject): PaletteState {
		const own = schematicObject ? this.schematicPalettes.get(schematicObject) : undefined;
		return (
			own ??
			this.palettes.get(this.paletteKey) ?? {
				key: this.paletteKey,
				cache: this.paletteCache,
				connecting: this.connectingPalette,
				contextId: this.paletteContextId ?? this.meshContextId,
				users: new Set(),
				holds: 0,
				dropped: false,
			}
		);
	}

	/**
	 * A schematic's palette (paletteFor), held for a request that waits (for a worker, or the worker's answer) before
	 * it is done with it: an edit's new palette or invalidateCache meanwhile drops it, but the workers keep its
	 * geometry until releaseHold, so the request meshes against it rather than against nothing.
	 */
	private holdPalette(schematicObject?: SchematicObject): PaletteState {
		const state = this.paletteFor(schematicObject);
		state.holds++;
		return state;
	}

	/** Runs a request with a schematic's palette held (holdPalette) until it is over. */
	private async withPalette<T>(
		schematicObject: SchematicObject | undefined,
		request: (palette: PaletteState) => Promise<T>
	): Promise<T> {
		const palette = this.holdPalette(schematicObject);
		try {
			return await request(palette);
		} finally {
			this.releaseHold(palette);
		}
	}

	private releaseHold(state: PaletteState) {
		if (--state.holds > 0) return;
		if (state.dropped) this.dropInWorkers(state);
		else this.dropPaletteIfUnused(state);
	}

	/** Makes a built palette the last one built, and the schematic's when one is given. */
	private usePalette(state: PaletteState, schematicObject?: SchematicObject) {
		const previous = this.palettes.get(this.paletteKey);
		this.paletteCache = state.cache;
		this.paletteKey = state.key;
		this.connectingPalette = state.connecting;
		this.paletteContextId = state.contextId;
		if (schematicObject) {
			const old = this.schematicPalettes.get(schematicObject);
			this.schematicPalettes.set(schematicObject, state);
			state.users.add(schematicObject);
			if (old && old !== state) {
				old.users.delete(schematicObject);
				this.dropPaletteIfUnused(old);
			}
		}
		if (previous && previous !== state) this.dropPaletteIfUnused(previous);
	}

	/** Lets go of a schematic's palette once it is removed (SchematicObject.dispose). */
	public releasePalette(schematicObject: SchematicObject): void {
		const state = this.schematicPalettes.get(schematicObject);
		if (!state) return;
		this.schematicPalettes.delete(schematicObject);
		state.users.delete(schematicObject);
		this.dropPaletteIfUnused(state);
	}

	private dropPaletteIfUnused(state: PaletteState) {
		if (state.users.size === 0 && state.holds === 0 && state.key !== this.paletteKey)
			this.dropPalette(state);
	}

	/**
	 * Drops a palette: its geometry here and in the workers (once no request holds it). A schematic still holding it
	 * builds nothing with it.
	 */
	private dropPalette(state: PaletteState) {
		if (this.palettes.get(state.key) !== state) return;
		this.palettes.delete(state.key);
		if (state.cache) {
			state.cache.isReady = false;
			if (state.cache !== this.paletteCache)
				for (const blockData of state.cache.blockData)
					for (const group of blockData?.materialGroups ?? []) group.baseGeometry?.dispose();
		}
		this.releasePaletteMaterials(state);
		if (state.holds > 0) state.dropped = true;
		else this.dropInWorkers(state);
	}

	/**
	 * Lets go of the registry references a palette's build took (one per geometry): they only grew until a pack switch
	 * cleared the registry, so the materials of every palette ever built stayed. A material another palette still
	 * holds stays; one none holds is disposed (a mesh still drawn with it uploads it again).
	 */
	private releasePaletteMaterials(state: PaletteState) {
		for (const material of state.materialRefs ?? []) MaterialRegistry.releaseMaterial(material);
		state.materialRefs = [];
	}

	private dropInWorkers(state: PaletteState) {
		state.dropped = false;
		for (const worker of this.workers)
			worker.postMessage({ type: "dropPalette", meshContextId: state.contextId });
	}

	/**
	 * Builds a palette's geometry (here and in the workers) once, and makes it `schematicObject`'s: what its meshes,
	 * caps and chunk rebuilds are built against.
	 */
	public async precomputePaletteGeometries(
		palette: any[],
		schematicObject?: SchematicObject
	): Promise<void> {
		performanceMonitor.startOperation("precomputePaletteGeometries");
		// which blocks get a built-in entity model depends on what the pack draws (chests)
		await this.cubane.prepareBlockEntityModels();

		// The same palette as the last build (another file of the same blocks, or the same file again): its
		// geometry is kept. Every entry is compared: two files' palettes can share their length, first and last
		// entries and still differ in between, and a match on those alone drew the second with the first's blocks.
		// each entry as its block string (namespaced, properties sorted): the same palette read with its properties
		// in another order, or a name without its namespace, is the same palette
		const paletteKey = palette.map((p) => this.createBlockStringFromPaletteEntry(p)).join("|");
		try {
			// again when the build it waited for, or its own, ended stale (a pack switch meanwhile: invalidateCache)
			for (;;) {
				const built = this.palettes.get(paletteKey);
				if (built?.cache?.isReady) {
					this.usePalette(built, schematicObject);
					return;
				}
				// The key goes with the cache, once it is built: set before, a second build of the same palette
				// meanwhile found the previous palette's cache under it and meshed against that. It waits for this
				// one instead.
				const building = this.palettesPending.get(paletteKey);
				if (building) {
					await building;
					continue;
				}
				const done = this.buildPaletteCache(palette, paletteKey);
				this.palettesPending.set(paletteKey, done);
				let state: PaletteState;
				try {
					state = await done;
				} finally {
					if (this.palettesPending.get(paletteKey) === done)
						this.palettesPending.delete(paletteKey);
				}
				if (state.stale) continue;
				// held from its build (buildPaletteCache) until it is the schematic's: no other palette made the last
				// built in between drops it
				if (this.palettes.get(paletteKey) === state) this.usePalette(state, schematicObject);
				this.releaseHold(state);
				return;
			}
		} finally {
			performanceMonitor.endOperation("precomputePaletteGeometries");
		}
	}

	/**
	 * The palette cache of a palette (precomputePaletteGeometries), and its geometry in the workers: held
	 * (holdPalette) for the caller to let go of.
	 */
	private async buildPaletteCache(palette: any[], paletteKey: string): Promise<PaletteState> {
		// the packs this build is made from: an invalidateCache before it ends makes it stale
		const generation = this.paletteGeneration;
		const stale = () => generation !== this.paletteGeneration;

		// Reset stats on start
		WorldMeshBuilder.resetStats();

		// Re-initialize GPU compute if it was disposed (e.g., during cleanup between runs)
		// This must happen BEFORE worker initialization to allow GPU to take precedence
		if (!this.gpuInitPromise && this.schematicRenderer.options.gpuComputeOptions?.enabled) {
			this.gpuInitPromise = this._doInitializeGPU();
		}

		// Wait for GPU init if in progress - GPU init will create workers as fallback if needed
		if (this.gpuInitPromise) {
			await this.gpuInitPromise;
		} else {
			// Only initialize workers if GPU is not being used
			this.initializeWorkers();
		}

		const paletteBlockData: PaletteBlockData[] = new Array(palette.length);
		const globalMaterialMap = new Map<string, THREE.Material>();
		const globalMaterials: THREE.Material[] = [];
		// every registry reference addGeometry takes, for the palette to release when it is dropped
		const materialRefs: THREE.Material[] = [];
		const paletteGeometryData: any[] = [];

		// Process all palette entries
		const CONCURRENCY_LIMIT = 8;
		let currentIndex = 0;
		const workerPromises: Promise<void>[] = [];
		// set with the cache too: the previous palette's builds read the set they were built with
		const connectingPalette = new Set<number>();
		const biome = "plains";
		const blockStrings = palette.map((p) => this.createBlockStringFromPaletteEntry(p));

		// The shapes kept from an earlier build with these packs (ShapeCache), and those made now, to keep. Without
		// IndexedDB, or with caching off, every shape is made as before.
		const shapeKey = this.cubane.shapeCacheKey();
		const shapeCache = shapeKey
			? await ShapeCache.open(`${shapeKey}|${biome}`).catch(() => null)
			: null;
		const fromStore = shapeCache ? await shapeCache.getMany(blockStrings).catch(() => null) : null;
		const kept: Map<string, CachedShape> = fromStore?.shapes ?? new Map();
		// the textures' alpha classes too: reading a texture's pixels back from the atlas is most of making a material
		const keptAlpha = Object.keys(fromStore?.alpha ?? {}).length;
		if (fromStore) this.cubane.seedAlphaClasses(fromStore.alpha);
		const made = new Map<string, CachedShape>();
		let fromCache = 0;

		// A geometry and its material into the palette: the material shared (MaterialRegistry) and numbered across it.
		const addGeometry = (
			geometry: THREE.BufferGeometry,
			material: THREE.Material,
			materialGroups: PaletteMaterialGroup[],
			geometryData: any[]
		) => {
			// Get or create shared material
			const sharedMaterial = MaterialRegistry.getMaterial(material);
			materialRefs.push(sharedMaterial);
			const materialKey = sharedMaterial.uuid;

			// Get or assign global material index
			let globalMaterial = globalMaterialMap.get(materialKey);
			if (!globalMaterial) {
				globalMaterial = sharedMaterial;
				globalMaterialMap.set(materialKey, globalMaterial);
				globalMaterials.push(globalMaterial);
			}

			const materialIndex = globalMaterials.indexOf(globalMaterial);

			materialGroups.push({
				material: globalMaterial,
				baseGeometry: geometry,
				positions: [],
				materialIndex: materialIndex,
			});

			// Extract buffers for worker
			geometryData.push({
				positions: geometry.attributes.position.array,
				normals: geometry.attributes.normal?.array,
				uvs: geometry.attributes.uv?.array,
				indices: geometry.index?.array || null,
				materialIndex: materialIndex,
				// a waterlogged block's water culls against water; its own shape as it would dry
				fluid: this.fluidOfMaterial(material),
			});
		};

		// Each kept material made once (a palette's ~7500 geometries share a few hundred): null when the material made
		// again is not the one the shape was kept with.
		const remade = new Map<string, Promise<THREE.Material | null>>();
		const remake = (g: CachedShape["geometries"][number]) => {
			// a face's direction changes only a liquid's material: the other faces of a texture share one
			const spec = g.spec.isLiquid ? g.spec : { ...g.spec, direction: "" };
			const key = `${JSON.stringify(spec)}|${g.fingerprint}`;
			let material = remade.get(key);
			if (!material) {
				material = this.cubane
					.materialFromSpec(g.spec)
					.then((m) => (materialFingerprint(m) === g.fingerprint ? m : null));
				remade.set(key, material);
			}
			return material;
		};

		// A kept shape into the palette, its materials made again from this session's atlas. False (the block is then
		// made from its models) when a material made again is not the one the shape was kept with.
		const restoreShape = async (index: number, shape: CachedShape): Promise<boolean> => {
			const blockState = palette[index];
			const category = this.getBlockCategory(blockState.name, blockState.properties);
			if (shape.connects) {
				connectingPalette.add(index);
				paletteBlockData[index] = { blockName: blockState.name, materialGroups: [], category };
				return true;
			}
			const materials: THREE.Material[] = [];
			for (const g of shape.geometries) {
				const material = await remake(g);
				if (!material) return false;
				materials.push(material);
			}
			const materialGroups: PaletteMaterialGroup[] = [];
			const geometryData: any[] = [];
			shape.geometries.forEach((g, i) => {
				const geometry = new THREE.BufferGeometry();
				for (const [name, { array, itemSize }] of Object.entries(g.attributes))
					geometry.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
				if (g.index) geometry.setIndex(new THREE.BufferAttribute(g.index, 1));
				addGeometry(geometry, materials[i], materialGroups, geometryData);
			});
			paletteBlockData[index] = { blockName: blockState.name, materialGroups, category };
			if (geometryData.length > 0) {
				paletteGeometryData.push({
					index,
					category,
					occlusionFlags: shape.occlusionFlags,
					cullKey: shape.cullKey,
					fluid: this.fluidOf(blockState.name, blockState.properties),
					geometries: geometryData,
				});
			}
			return true;
		};

		/** A block's shape as the cache keeps it, when every material of it is a face material (else null: an
		 *  entity's or a fallback's, or no geometry at all, which may be a model that failed to load). */
		const shapeToKeep = (
			extracted: { geometry: THREE.BufferGeometry; material: THREE.Material }[],
			category: string,
			occlusionFlags: number,
			cullKey: string
		): CachedShape | null => {
			const geometries: CachedShape["geometries"] = [];
			for (const { geometry, material } of extracted) {
				if (geometry.attributes.position.count === 0) continue;
				const spec = this.cubane.faceMaterialSpec(material);
				if (!spec) return null;
				const attributes: CachedShape["geometries"][number]["attributes"] = {};
				for (const [name, attr] of Object.entries(geometry.attributes)) {
					const a = attr as THREE.BufferAttribute;
					if (!(a.array instanceof Float32Array)) return null;
					attributes[name] = { array: a.array, itemSize: a.itemSize };
				}
				const index = geometry.index?.array ?? null;
				if (index && !(index instanceof Uint16Array || index instanceof Uint32Array)) return null;
				geometries.push({
					attributes,
					index: index as Uint16Array | Uint32Array | null,
					spec,
					fingerprint: materialFingerprint(material),
				});
			}
			return geometries.length
				? { connects: false, category, occlusionFlags, cullKey, geometries }
				: null;
		};

		const processBlock = async (index: number) => {
			const blockState = palette[index];
			const blockString = blockStrings[index];

			try {
				const keptShape = kept.get(blockString);
				if (keptShape && (await restoreShape(index, keptShape))) {
					fromCache++;
					return;
				}

				// Blocks whose textures connect to their neighbours (Fusion) are meshed per
				// position on the main thread (buildConnectedBlockMeshes); the worker gets no
				// geometry for them, so it draws nothing in their place.
				if (await this.cubane.isConnectingBlock(blockString)) {
					connectingPalette.add(index);
					const category = this.getBlockCategory(blockState.name, blockState.properties);
					paletteBlockData[index] = {
						blockName: blockState.name,
						materialGroups: [],
						category,
					};
					if (shapeCache)
						made.set(blockString, {
							connects: true,
							category,
							occlusionFlags: 0,
							cullKey: SOLID_CULL_KEY,
							geometries: [],
						});
					return;
				}

				// Get geometry from Cubane (Main Thread)
				const cubaneObj = await this.cubane.getBlockMesh(blockString, biome, true);
				const extractedGeometries = cubaneObj
					? this.extractAllMeshData(cubaneObj)
					: this.extractAllMeshData(this.createFallbackObject3D(blockString));

				// Create material groups for this block type
				const materialGroups: PaletteMaterialGroup[] = [];
				const geometryData: any[] = [];

				for (const { geometry, material } of extractedGeometries) {
					if (geometry.attributes.position.count === 0) continue;
					addGeometry(geometry, material, materialGroups, geometryData);
				}

				const category = this.getBlockCategory(blockState.name, blockState.properties);

				paletteBlockData[index] = {
					blockName: blockState.name,
					materialGroups,
					category,
				};

				// Add to worker payload
				if (geometryData.length > 0) {
					const { occlusionFlags, cullKey } = await this.computeCulling(blockString);
					paletteGeometryData.push({
						index,
						category,
						occlusionFlags,
						cullKey,
						fluid: this.fluidOf(blockState.name, blockState.properties),
						geometries: geometryData,
					});
					const shape = shapeCache
						? shapeToKeep(extractedGeometries, category, occlusionFlags, cullKey)
						: null;
					if (shape) made.set(blockString, shape);
				}
			} catch (error) {
				console.warn(`Error processing palette index ${index}:`, error);
			}
		};

		// Process with concurrency limit
		while (currentIndex < palette.length || workerPromises.length > 0) {
			while (workerPromises.length < CONCURRENCY_LIMIT && currentIndex < palette.length) {
				const index = currentIndex++;
				const promise = processBlock(index).then(() => {
					const idx = workerPromises.indexOf(promise);
					if (idx > -1) workerPromises.splice(idx, 1);
				});
				workerPromises.push(promise);
			}

			if (workerPromises.length > 0) {
				await Promise.race(workerPromises.map((p) => p.catch(() => {})));
			} else if (currentIndex >= palette.length) {
				break;
			}
		}

		// the shapes made now are kept for the next build with these packs (not waited for: the build goes on)
		this.shapeCacheStats = {
			palette: palette.length,
			fromCache,
			made: made.size,
			cacheOn: !!shapeCache,
		};
		// kept under the pack set it was made from, and only while that is still the one drawn: shapes made across a
		// pack switch would be kept under the old packs' key and restored with them for good
		if (shapeCache && !stale() && this.cubane.shapeCacheKey() === shapeKey) {
			const alpha = this.cubane.alphaClasses();
			const newAlpha = Object.keys(alpha).length > keptAlpha;
			if (made.size > 0 || newAlpha)
				shapeCache
					.putMany(made, newAlpha ? alpha : undefined)
					.catch((e) => console.warn("[WorldMeshBuilder] shape cache: not kept", e));
		}

		// Wait for GPU init to complete
		if (this.gpuInitPromise) {
			await this.gpuInitPromise;
		}

		const state: PaletteState = {
			key: paletteKey,
			cache: { palette: palette, blockData: paletteBlockData, globalMaterials, isReady: true },
			connecting: connectingPalette,
			contextId: `${this.meshContextId}/${this.nextPaletteId++}`,
			users: new Set(),
			holds: 1,
			dropped: false,
			materialRefs,
		};

		// A pack switch meanwhile (invalidateCache): its geometry and materials are the old packs'. Not kept, not sent
		// to the workers; precomputePaletteGeometries builds again.
		const discardStale = () => {
			state.stale = true;
			state.cache!.isReady = false;
			for (const blockData of paletteBlockData)
				for (const group of blockData?.materialGroups ?? []) group.baseGeometry?.dispose();
			this.releasePaletteMaterials(state);
			return state;
		};
		if (stale()) return discardStale();

		// Upload to GPU if using GPU compute, otherwise broadcast to workers, before a build can use it (a worker takes
		// its messages in order, so a chunk sent after this is meshed with this palette)
		if (this.useGPUCompute && this.computeMeshBuilder) {
			await this.computeMeshBuilder.uploadPaletteData(state.cache!);
			if (stale()) return discardStale();
		} else {
			this.workers.forEach((worker) => {
				worker.postMessage({
					type: "updatePalette",
					paletteData: paletteGeometryData,
					meshContextId: state.contextId,
				});
			});
		}
		this.palettes.set(paletteKey, state);
		this.usePalette(state);
		return state;
	}

	// Helper to acquire a worker. Rebinds onmessage to THIS builder so that, with a
	// shared pool, responses route back to the builder that borrowed the worker
	// (workers are lent exclusively until returnWorker).
	private async getFreeWorker(): Promise<Worker> {
		const bind = (worker: Worker): Worker => {
			worker.onmessage = (event: MessageEvent) => this.handleWorkerMessage(worker, event);
			this.lentWorkers.add(worker);
			return worker;
		};
		if (this.freeWorkers.length > 0) {
			return bind(this.freeWorkers.pop()!);
		}
		// Wait for a worker to become free (or for dispose, which turns the wait down)
		return new Promise<Worker>((resolve, reject) => {
			const waiter = (worker: Worker) => {
				this.queuedWaiters.delete(waiter);
				resolve(bind(worker));
			};
			this.queuedWaiters.set(waiter, reject);
			this.workerQueue.push(waiter);
		});
	}

	/**
	 * Process all chunks in batch mode - returns merged meshes
	 * instead of one mesh per chunk. This reduces main thread work significantly.
	 *
	 * CRITICAL: We split into sub-batches to avoid creating meshes that are too large.
	 * Without this, a 256³ schematic creates 3 meshes with millions of vertices = crash.
	 *
	 * @param allChunks - Iterator or array of chunk data
	 * @param onProgress - Optional progress callback
	 * @returns Promise with merged meshes
	 */
	public async processChunksBatched(
		// flat [x, y, z, paletteIndex, ...], as SchematicObject.buildSchematicMeshesBatched makes them
		allChunks: Array<{
			blocks: Int32Array;
			chunk_x: number;
			chunk_y: number;
			chunk_z: number;
			// Neighbouring chunks' boundary blocks for cross-chunk face culling (occlusion only).
			apronBlocks?: Int32Array;
		}>,
		onProgress?: (processed: number, total: number) => void,
		// the schematic the chunks come from: needed for blocks with connected textures,
		// which read their neighbours and are meshed per position
		schematicObject?: SchematicObject
	): Promise<THREE.Object3D[]> {
		return this.withPalette(schematicObject, async (palette) => {
			const cache = palette.cache;
			if (!cache?.isReady) {
				throw new Error("Palette cache not ready. Call precomputePaletteGeometries() first.");
			}

			if (this.workers.length === 0) {
				this.initializeWorkers();
			}

			const totalChunks = allChunks.length;
			let globalProcessedCount = 0;

			// CRITICAL: Split into sub-batches to avoid creating meshes that are too large
			// Each sub-batch creates ~3 meshes (solid, transparent, etc.)
			// Without this, a 256³ schematic creates 3 meshes with millions of vertices each = crash
			const SUB_BATCH_SIZE = 64; // ~64 chunks per sub-batch = manageable mesh sizes
			const allResultMeshes: THREE.Object3D[] = [];

			const numSubBatches = Math.ceil(totalChunks / SUB_BATCH_SIZE);

			// Acquire one worker exclusively for the whole batch so this works with a
			// shared pool (other builders use other workers). Released in `finally`.
			const batchWorker = await this.getFreeWorker();
			try {
				for (let subBatchIdx = 0; subBatchIdx < numSubBatches; subBatchIdx++) {
					const subBatchStart = subBatchIdx * SUB_BATCH_SIZE;
					const subBatchEnd = Math.min(subBatchStart + SUB_BATCH_SIZE, totalChunks);
					const subBatchChunks = allChunks.slice(subBatchStart, subBatchEnd);

					// Start batch mode on worker for this sub-batch
					batchWorker.postMessage({ type: "startBatch", meshContextId: palette.contextId });

					// Process this sub-batch's chunks through the batch worker
					for (const chunkData of subBatchChunks) {
						// the schematic was removed while this ran: stop, and let go of what was built
						if (schematicObject?.isDisposed()) {
							batchWorker.postMessage({ type: "finishBatch", meshContextId: palette.contextId });
							for (const m of allResultMeshes) disposeObject(m);
							return [];
						}
						const chunkId = this.chunkRequestId(
							chunkKey(chunkData.chunk_x, chunkData.chunk_y, chunkData.chunk_z)
						);
						const cellGroups = schematicObject?.cellGroupsOf(chunkData.blocks);
						if (schematicObject) {
							const connected = await this.buildConnectedBlockMeshes(
								chunkData.blocks,
								schematicObject
							);
							// which chunk they are of: a cell filter makes a chunk's again (SchematicObject.connectedCapsFor)
							const chunk = chunkKey(chunkData.chunk_x, chunkData.chunk_y, chunkData.chunk_z);
							for (const mesh of connected) mesh.userData.connectedChunk = chunk;
							allResultMeshes.push(...connected);
						}

						const blocksArray = chunkData.blocks;

						// Calculate origin
						let minX = Infinity,
							minY = Infinity,
							minZ = Infinity;
						for (let i = 0; i < blocksArray.length; i += 4) {
							minX = Math.min(minX, blocksArray[i]);
							minY = Math.min(minY, blocksArray[i + 1]);
							minZ = Math.min(minZ, blocksArray[i + 2]);
						}
						const originX = isFinite(minX) ? minX : 0;
						const originY = isFinite(minY) ? minY : 0;
						const originZ = isFinite(minZ) ? minZ : 0;

						// Wait for chunk to be accumulated
						await new Promise<void>((resolve, reject) => {
							// the worker has read the chunk's input by the time it answers
							const release = () => this.sharedMemoryPool?.releaseBuffers(chunkId);
							this.batchPendingChunks.set(chunkId, {
								resolve: () => {
									release();
									resolve();
								},
								reject: (err) => {
									release();
									reject(err);
								},
							});

							// Use SharedArrayBuffer if available
							if (this.useSharedMemory && this.sharedMemoryPool) {
								const sharedBuffer = this.sharedMemoryPool.writeChunkInput(
									chunkId,
									blocksArray,
									originX,
									originY,
									originZ
								);
								batchWorker.postMessage({
									type: "buildChunkBatched",
									chunkId,
									sharedInputBuffer: sharedBuffer,
									chunkOrigin: [originX, originY, originZ],
									apronBlocks: chunkData.apronBlocks, // occlusion-only neighbour shell
									meshContextId: palette.contextId,
									cellGroups,
									chunk: [chunkData.chunk_x, chunkData.chunk_y, chunkData.chunk_z],
								});
							} else {
								batchWorker.postMessage(
									{
										type: "buildChunkBatched",
										chunkId,
										blocks: blocksArray,
										chunkOrigin: [originX, originY, originZ],
										apronBlocks: chunkData.apronBlocks, // occlusion-only neighbour shell
										meshContextId: palette.contextId,
										cellGroups,
										chunk: [chunkData.chunk_x, chunkData.chunk_y, chunkData.chunk_z],
									},
									[blocksArray.buffer]
								);
							}
						});

						globalProcessedCount++;
						if (onProgress) {
							onProgress(globalProcessedCount, totalChunks);
						}
					}

					// Finish this sub-batch and get merged results
					const batchResult = await new Promise<any>((resolve, reject) => {
						const batchId = this.nextBatchId++;
						this.batchFinishes.set(batchId, { resolve, reject });
						batchWorker.postMessage({
							type: "finishBatch",
							meshContextId: palette.contextId,
							batchId,
						});
					});

					// Create Three.js meshes from this sub-batch's merged data
					const subBatchMeshes = this.createMeshesFromBatchResult(
						batchResult,
						cache.globalMaterials
					);
					allResultMeshes.push(...subBatchMeshes);

					// Let the browser breathe between sub-batches (render and handle input); in a hidden
					// tab, where no frames come, the build goes on after a short timeout instead
					if (subBatchIdx < numSubBatches - 1) {
						await nextFrame();
					}
				}

				return allResultMeshes;
			} catch (error) {
				// a chunk or a sub-batch failed (or dispose turned them down): the meshes built so far go with it
				for (const m of allResultMeshes) disposeObject(m);
				throw error;
			} finally {
				// Release the batch worker back to the (possibly shared) pool.
				this.returnWorker(batchWorker);
			}
		});
	}

	/**
	 * Helper to create Three.js meshes from a batch result
	 */
	private createMeshesFromBatchResult(
		batchResult: { meshes: BatchMesh[] },
		materials: THREE.Material[]
	): THREE.Mesh[] {
		const meshes: THREE.Mesh[] = [];
		// materials drawn without depth writes blend in draw order: their triangles go to regional meshes that
		// three.js can sort by distance (utils/translucentRegions.ts)
		const translucent = (i: number) => materials[i]?.depthWrite === false;
		// each vertex's chunk, for a chunk edited later to be cut out of the batch (utils/batchChunks.ts)
		const split = batchResult.meshes.flatMap((m) => {
			let keys: string[] | undefined;
			if (m.chunks && m.positions) {
				const of = vertexChunksOf(m.chunks, m.positions.length / 3);
				m.vertexChunks = of.ofVertex;
				keys = of.keys;
			}
			return splitTranslucentRegions(m, translucent).map((part) => ({ part, keys }));
		});

		for (const { part: meshData, keys } of split) {
			// One group per material: with layer runs from the WASM mesher, each material's indices ordered by layer
			// across the batch's chunks too, so a range of layers is one index range per material
			// (utils/layerRange.ts); without, merged by material only
			let optimized: BatchMesh;
			let layerIndex: LayerIndex | null = null;
			if (meshData.layers && meshData.indices && meshData.groups) {
				const sorted = sortByLayer(meshData.indices, meshData.groups, meshData.layers);
				layerIndex = sorted.layerIndex;
				optimized = {
					...meshData,
					indices: sorted.indices,
					groups: sorted.groups,
					normals:
						meshData.normals instanceof Int8Array
							? convertInt8NormalsToFloat32(meshData.normals)
							: meshData.normals,
				};
			} else {
				optimized = this.optimizeGeometryGroups(meshData);
			}

			const geometry = new THREE.BufferGeometry();

			if (optimized.positions) {
				const posAttr = new THREE.BufferAttribute(optimized.positions, 3);
				geometry.setAttribute("position", posAttr);
			}

			if (optimized.normals) {
				const normAttr = new THREE.BufferAttribute(optimized.normals, 3);
				geometry.setAttribute("normal", normAttr);
			}

			if (optimized.uvs) {
				const uvAttr = new THREE.BufferAttribute(optimized.uvs, 2);
				geometry.setAttribute("uv", uvAttr);
			}

			if (optimized.indices) {
				geometry.setIndex(new THREE.BufferAttribute(optimized.indices, 1));
			}

			if (optimized.groups) {
				for (const group of optimized.groups) {
					geometry.addGroup(group.start, group.count, group.materialIndex);
				}
			}

			if (layerIndex) geometry.userData.layerIndex = layerIndex;
			// the chunks it holds: a translucent region's mesh, a few of its batch's
			if (keys && meshData.vertexChunks && optimized.indices) {
				geometry.userData.batchChunks = batchChunksOf(
					keys,
					meshData.vertexChunks,
					optimized.indices
				);
			}

			const mesh = new THREE.Mesh(geometry, materials);
			mesh.name = `batched_${meshData.category}`;
			if (meshData.translucentRegion) {
				mesh.name += "_translucent";
				mesh.userData.translucentRegion = meshData.translucentRegion;
			}

			this.configureMeshForCategory(mesh, meshData.category as keyof ChunkMeshes);
			meshes.push(mesh);
		}

		return meshes;
	}

	/**
	 * OPTIMIZATION: Sort geometry data by material index to merge groups
	 * This reduces draw calls from N_blocks to N_materials per mesh
	 */
	private optimizeGeometryGroups(meshData: BatchMesh): BatchMesh {
		if (!meshData.groups || meshData.groups.length <= 1) {
			// Pre-convert normals if needed
			if (meshData.normals && meshData.normals instanceof Int8Array) {
				meshData.normals = convertInt8NormalsToFloat32(meshData.normals);
			}
			return meshData;
		}

		// Check if already sorted/minimal (heuristic: count groups vs materials)
		// If groups.length is huge but unique materials is small, we need to optimize
		const uniqueMaterials = new Set(meshData.groups.map((g) => g.materialIndex)).size;
		if (meshData.groups.length <= uniqueMaterials * 1.5) {
			// Already optimized enough
			if (meshData.normals && meshData.normals instanceof Int8Array) {
				meshData.normals = convertInt8NormalsToFloat32(meshData.normals);
			}
			return meshData;
		}

		// Prepare new arrays
		const positions = meshData.positions;
		const normals = meshData.normals; // Int8Array usually
		const uvs = meshData.uvs;
		const indices = meshData.indices;

		// const vertexCount = positions.length / 3;
		// const indexCount = indices ? indices.length : vertexCount;

		// We need to reorder everything based on material index
		// 1. Group all existing groups by material index
		const groupsByMaterial = new Map<number, any[]>();
		for (const group of meshData.groups) {
			if (!groupsByMaterial.has(group.materialIndex)) {
				groupsByMaterial.set(group.materialIndex, []);
			}
			groupsByMaterial.get(group.materialIndex)!.push(group);
		}

		// 2. Calculate new size (same as old)
		// const newPositions = new Float32Array(positions.length);
		// const newNormals = normals ? new Float32Array(normals.length) : null;
		// const newUVs = uvs ? new Float32Array(uvs.length) : null;
		// Use same type for indices (Uint16 or Uint32)
		const NewIndexType = indices instanceof Uint16Array ? Uint16Array : Uint32Array;
		const newIndices = indices ? new NewIndexType(indices.length) : null;

		const newGroups: any[] = [];
		let currentIndexOffset = 0;
		const currentVertexOffset = 0; // Only relevant if not using indices (unlikely)

		// 3. Iterate materials and rebuild buffers
		for (const [materialIndex, groups] of groupsByMaterial.entries()) {
			const groupStart = newIndices ? currentIndexOffset : currentVertexOffset;
			let groupCount = 0;

			for (const group of groups) {
				// Copy data for this group
				// Note: Groups refer to INDICES range (start, count)
				// But vertices are not necessarily contiguous for the group!
				// Wait, standard Three.js groups just define a range of the INDEX buffer to render.
				// If the index buffer points to vertices all over the place, that's fine.
				// BUT we want to make the INDEX buffer contiguous for this material.

				if (newIndices && indices) {
					// Copy indices for this group
					// We can copy them directly, but we need to verify if vertices need reordering.
					// If we just reorder indices, that's enough for draw calls!
					// Vertices can stay where they are.
					// Optimization: Just reorder indices.

					const sourceStart = group.start;
					const count = group.count;

					// Copy slice of indices
					const subIndices = indices.subarray(sourceStart, sourceStart + count);
					newIndices.set(subIndices, currentIndexOffset);

					currentIndexOffset += count;
					groupCount += count;
				} else {
					// Non-indexed geometry: we must move vertices.
					// This is rarer but possible.
					// We assume indexed for now as WorldMeshBuilder generates indices.
				}
			}

			newGroups.push({
				start: groupStart,
				count: groupCount,
				materialIndex: materialIndex,
			});
		}

		// 4. Handle Normals conversion
		let finalNormals = normals;
		if (normals && normals instanceof Int8Array) {
			finalNormals = convertInt8NormalsToFloat32(normals);
		}

		// If we only reordered indices, we can reuse vertex buffers!
		// This is much faster than moving vertices.
		if (newIndices) {
			return {
				positions: positions, // Unchanged
				normals: finalNormals, // Converted but order unchanged
				uvs: uvs, // Unchanged
				indices: newIndices, // REORDERED
				groups: newGroups, // OPTIMIZED
				category: meshData.category,
			};
		}

		// Fallback for non-indexed (should not happen with current builder)
		return meshData;
	}

	/**
	 * Meshes a chunk's blocks in a worker against `palette` (getChunkGeometries, getChunkMesh): one request, with a
	 * worker of its own until the answer comes. The blocks go through shared memory when the page has it, else as a
	 * copy moved to the worker (blocksForWorker). Resolves with the worker's answer ({ meshes, origin }); rejects after
	 * 30 s, or when dispose turns the request down.
	 */
	private async meshChunkInWorker(
		chunkId: string,
		blocks: Int32Array | number[][],
		origin: [number, number, number],
		palette: PaletteState,
		schematicObject?: SchematicObject,
		apronBlocks?: Int32Array
	): Promise<{ meshes: any[]; origin?: number[] }> {
		if (blocks.length === 0) return { meshes: [] };
		if (this.workers.length === 0) this.initializeWorkers();
		const worker = await this.getFreeWorker();
		// unique to this request: two builds of one chunk at once each hear their own answer
		const requestId = this.chunkRequestId(chunkId);
		return new Promise((resolve, reject) => {
			const release = () => this.sharedMemoryPool?.releaseBuffers(requestId);
			// a worker that never answers does not hold the build for good
			const timeoutId = setTimeout(() => {
				const request = this.pendingRequests.get(requestId);
				if (!request) return;
				this.pendingRequests.delete(requestId);
				this.returnWorker(request.worker);
				release();
				reject(new Error(`Chunk build timeout for ${chunkId}`));
			}, 30000);
			this.pendingRequests.set(requestId, {
				resolve: (data) => {
					clearTimeout(timeoutId);
					release();
					resolve(data);
				},
				reject: (err) => {
					clearTimeout(timeoutId);
					release();
					reject(err);
				},
				worker,
			});
			const message = {
				type: "buildChunk",
				chunkId: requestId,
				chunkOrigin: origin,
				meshContextId: palette.contextId,
				cellGroups: schematicObject?.cellGroupsOf(blocks),
				// occlusion only: the neighbouring chunks' blocks its seams cull against
				...(apronBlocks && { apronBlocks }),
			};
			if (this.useSharedMemory && this.sharedMemoryPool && blocks instanceof Int32Array) {
				// the worker reads the blocks where they are written: no copy
				const sharedInputBuffer = this.sharedMemoryPool.writeChunkInput(
					requestId,
					blocks,
					...origin
				);
				worker.postMessage({ ...message, sharedInputBuffer });
			} else {
				const sent = blocksForWorker(blocks);
				worker.postMessage({ ...message, blocks: sent.blocks }, sent.transfer);
			}
		});
	}

	/**
	 * A chunk's geometry as raw buffers, for a caller that builds its own meshes. Blocks with connected textures
	 * (Fusion) have none in the palette: they are drawn per position from their neighbours, and come back as
	 * `connectedMeshes` (in schematic coordinates) when `schematicObject` is given to look the neighbours up in.
	 */
	public async getChunkGeometries(
		chunkData: {
			blocks: Array<number[]> | Int32Array;
			chunk_x: number;
			chunk_y: number;
			chunk_z: number;
			// the neighbouring chunks' blocks the faces on its seams cull against (never drawn)
			apronBlocks?: Int32Array;
		},
		renderingBounds?: {
			min: THREE.Vector3;
			max: THREE.Vector3;
			enabled?: boolean;
		},
		schematicObject?: SchematicObject
	): Promise<{
		geometries: ChunkGeometryData[];
		origin: number[];
		connectedMeshes: THREE.Object3D[];
	}> {
		const chunkId = chunkKey(chunkData.chunk_x, chunkData.chunk_y, chunkData.chunk_z);

		return this.withPalette(schematicObject, async (palette) => {
			const cache = palette.cache;
			if (!cache?.isReady) {
				throw new Error("Palette cache not ready. Call precomputePaletteGeometries() first.");
			}

			if (chunkData.blocks.length === 0)
				return { geometries: [], origin: [0, 0, 0], connectedMeshes: [] };

			// Filter blocks based on bounds
			const blocksToProcess = blocksInBounds(chunkData.blocks, renderingBounds);

			if (blocksToProcess.length === 0)
				return { geometries: [], origin: [0, 0, 0], connectedMeshes: [] };

			const connectedMeshes = schematicObject
				? await this.buildConnectedBlockMeshes(blocksToProcess, schematicObject)
				: [];

			const originX = chunkData.chunk_x * this.chunkSize;
			const originY = chunkData.chunk_y * this.chunkSize;
			const originZ = chunkData.chunk_z * this.chunkSize;

			// GPU Compute path
			if (this.useGPUCompute && this.computeMeshBuilder?.isReady) {
				try {
					const gpuResult = await this.computeMeshBuilder.buildChunk(
						blocksToProcess as Int32Array,
						[originX, originY, originZ],
						chunkId
					);

					if (gpuResult) {
						return {
							geometries: gpuResult.geometries,
							origin: gpuResult.origin,
							connectedMeshes,
						};
					}
				} catch (error) {
					console.warn("[WorldMeshBuilder] GPU compute failed, falling back to workers:", error);
					// Fall through to worker path
				}
			}

			// Worker fallback path
			const workerPromise = this.meshChunkInWorker(
				chunkId,
				blocksToProcess,
				[originX, originY, originZ],
				palette,
				schematicObject,
				chunkData.apronBlocks
			);

			try {
				const workerResult = await workerPromise;
				return {
					geometries: workerResult.meshes as ChunkGeometryData[],
					origin: workerResult.origin || [originX, originY, originZ],
					connectedMeshes,
				};
			} catch (error) {
				console.error("Error building chunk geometry:", error);
				return { geometries: [], origin: [0, 0, 0], connectedMeshes };
			}
		});
	}

	/**
	 * The faces of shown cells that hidden cells beside them covered (SchematicObject.setLayerRange,
	 * setHiddenGroups), as meshes like a batch's. `pieces` are the shown cells beside hidden ones in chunk-sized
	 * pieces ([x, y, z, paletteIndex, ...], schematic coordinates), each with the hidden cells beside them as its
	 * apron and the shown cells' groups. None without the WASM mesher.
	 */
	public async buildCaps(
		pieces: Array<{
			blocks: Int32Array;
			apron: Int32Array;
			cellGroups: Uint16Array;
			origin: [number, number, number];
		}>,
		// the schematic the pieces are of: they are meshed against its palette
		schematicObject?: SchematicObject
	): Promise<THREE.Mesh[]> {
		// the WASM workers hold the palette; the WebGPU path meshes without them
		return this.withPalette(schematicObject, async (palette) => {
			if (!this.canBuildCaps(schematicObject) || pieces.length === 0) return [];
			if (this.workers.length === 0) this.initializeWorkers();
			// none after dispose turned the wait down, as for caps in flight then
			const worker = await this.getFreeWorker().catch(() => null);
			if (!worker) return [];
			const requestId = this.nextCapsRequest++;
			const result = await new Promise<CapsResult>((resolve) => {
				this.capsRequests.set(requestId, resolve);
				worker.postMessage(
					{ type: "buildCaps", requestId, tiles: pieces, meshContextId: palette.contextId },
					pieces.flatMap((t) => [t.blocks.buffer, t.apron.buffer, t.cellGroups.buffer])
				);
			});
			// a category the pieces have blocks of but no cap faces in comes back empty
			const nonEmpty = {
				...result,
				meshes: (result.meshes ?? []).filter((m) => m.indices?.length),
			};
			const materials = palette.cache?.globalMaterials ?? [];
			return this.createMeshesFromBatchResult(nonEmpty, materials).map((mesh) => {
				mesh.name = `cell_caps_${mesh.name}`;
				return mesh;
			});
		});
	}

	/** A schematic's palette's entries with connected textures (Fusion), meshed per position. */
	public connectingPaletteOf(schematicObject: SchematicObject): ReadonlySet<number> {
		return this.paletteFor(schematicObject).connecting;
	}

	/**
	 * Meshes of a schematic's connected-texture blocks ([x, y, z, paletteIndex] each) as a chunk's are made, with the
	 * cells `hiddenAt` says taken as air: what a cell filter shows of them (SchematicObject.connectedCapsFor).
	 */
	public buildConnectedMeshes(
		blocks: number[][],
		schematicObject: SchematicObject,
		hiddenAt: (x: number, y: number, z: number) => boolean
	): Promise<THREE.Object3D[]> {
		return this.buildConnectedBlockMeshes(blocks, schematicObject, hiddenAt);
	}

	/** How many entries a schematic's palette has (paletteFor; 0 before one is built). */
	public getPaletteSize(schematicObject?: SchematicObject): number {
		return this.paletteFor(schematicObject).cache?.palette.length ?? 0;
	}

	/**
	 * Whether processChunksBatched can build: only the WASM mesher's workers take a batch (startBatch, finishBatch).
	 * The JavaScript mesher's ignore them, and a batched build with it waited for good.
	 */
	public canBuildBatched(): boolean {
		return this.useWasmMeshBuilder;
	}

	/** Whether buildCaps can for a schematic: its palette is built, in the WASM mesher's workers. */
	public canBuildCaps(schematicObject?: SchematicObject): boolean {
		return (
			!!this.paletteFor(schematicObject).cache?.isReady &&
			this.useWasmMeshBuilder &&
			!this.useGPUCompute
		);
	}

	/** A schematic's palette's air entries (no block, as the chunk iterator leaves them out). */
	public airPaletteIndices(schematicObject?: SchematicObject): Set<number> {
		const air = new Set<number>();
		this.paletteFor(schematicObject).cache?.palette.forEach(
			(entry: { name?: string }, i: number) => {
				if (isAir(String(entry?.name ?? ""))) air.add(i);
			}
		);
		return air;
	}

	/**
	 * Render sign block entities as standalone meshes, independent of the build mode.
	 *
	 * The `batched` and `instanced` build paths don't process block entities at all,
	 * and even the chunk path's tile-entity handling lacks the blockstate properties
	 * (facing/rotation) signs need. Signs require BOTH per-instance NBT (the text) and
	 * the blockstate (orientation), so we render them here once per schematic build and
	 * the caller adds the results to the schematic group. The greedy/palette paths emit
	 * nothing for signs (cubane returns empty when called without NBT), so there's no
	 * doubling.
	 */
	public async buildSignMeshes(schematicObject: SchematicObject): Promise<THREE.Object3D[]> {
		const beMap = schematicObject.getBlockEntitiesMap();
		if (beMap.size === 0) return [];

		const wrapper = schematicObject.schematicWrapper;
		const out: THREE.Object3D[] = [];
		// how the signs keep their text (SignRenderer.extractSignText): their NBT does not say
		let dataVersion: number | undefined;
		try {
			dataVersion = wrapper.getSourceDataVersion?.() ?? undefined;
		} catch {
			/* versionless */
		}

		for (const entity of beMap.values()) {
			const pos = entity.position;
			if (!pos) continue;

			// Resolve the blockstate (name + facing/rotation) at this position.
			let name: string | undefined;
			const props: Record<string, string> = {};
			try {
				const bs = wrapper.get_block_with_properties(pos[0], pos[1], pos[2]);
				if (bs) {
					name = bs.name();
					const p = bs?.properties();
					if (p && typeof p === "object") {
						for (const [k, v] of Object.entries(p)) props[k] = String(v);
					}
				}
			} catch {
				/* fall through */
			}
			if (!name || !name.includes("sign")) continue;

			const blockString = formatBlockString(name, props);
			const nbt =
				dataVersion !== undefined
					? { DataVersion: dataVersion, ...(entity.nbt || entity) }
					: entity.nbt || entity;

			try {
				const mesh = await this.cubane.getBlockMesh(blockString, "plains", false, nbt);
				if (!mesh) continue;
				// cubane builds block geometry centred on the integer coordinate (c/16 - 0.5),
				// so the sign (already centred [-0.5,0.5]) goes straight at the block position
				// to line up with the surrounding blocks.
				const off = mesh.position.clone();
				mesh.position.set(pos[0] + off.x, pos[1] + off.y, pos[2] + off.z);
				mesh.name = `sign_${name}_${pos[0]}_${pos[1]}_${pos[2]}`;
				// shown with its layer and cell group (SchematicObject.setLayerRange, setHiddenGroups)
				mesh.userData.layerY = pos[1];
				mesh.userData.cellGroup = schematicObject.cellGroupAt(pos[0], pos[1], pos[2]);
				out.push(mesh);
			} catch (e) {
				console.warn("[WorldMeshBuilder] sign build failed", blockString, e);
			}
		}

		return out;
	}

	public async getChunkMesh(
		chunkData: {
			blocks: Array<number[]> | Int32Array;
			chunk_x: number;
			chunk_y: number;
			chunk_z: number;
			// Neighbouring chunks' boundary blocks for cross-chunk face culling (occlusion only).
			apronBlocks?: Int32Array;
		},
		schematicObject: SchematicObject,
		renderingBounds?: {
			min: THREE.Vector3;
			max: THREE.Vector3;
			enabled?: boolean;
		},
		preFilteredEntities?: any[] // Optimization: entities already filtered by WASM
	): Promise<THREE.Object3D[]> {
		const chunkId = chunkKey(chunkData.chunk_x, chunkData.chunk_y, chunkData.chunk_z);

		return this.withPalette(schematicObject, async (palette) => {
			const cache = palette.cache;
			if (!cache?.isReady) {
				throw new Error("Palette cache not ready. Call precomputePaletteGeometries() first.");
			}

			if (chunkData.blocks.length === 0) return [];

			// Filter blocks based on bounds
			const blocksToProcess = blocksInBounds(chunkData.blocks, renderingBounds);

			if (blocksToProcess.length === 0) return [];

			// Identify tile entities separately - Optimized
			const tileEntityBlocks: any[] = [];
			// Optimization: Pass all blocks to worker directly. Worker filters invisible blocks.
			const workerBlocks = blocksToProcess;

			// Use cached map from SchematicObject instead of fetching all entities every chunk
			// If preFilteredEntities is provided (WASM optimized path), use that directly

			if (preFilteredEntities) {
				for (const entity of preFilteredEntities) {
					// With WASM getChunkData, we get entity ID but not the full block state string.
					// However, the block at this position determines the visual appearance.
					// We need to query the block state to handle rotation/variants properly.

					// Note: entity.position from getChunkData is [x, y, z]
					const pos = entity.position; // [x, y, z]

					// Bounds checking is already done by WASM, but double check against renderingBounds if needed
					// (WASM getChunkData cuts by chunk, but renderingBounds might be tighter)
					if (
						renderingBounds?.enabled &&
						!inRenderingBounds(renderingBounds, pos[0], pos[1], pos[2])
					)
						continue;

					const blockName = schematicObject.schematicWrapper.get_block(pos[0], pos[1], pos[2]);

					// Only blocks drawn with a built-in entity model (Cubane's blockEntityModels)
					// get a per-position mesh here; the rest, chests from a pack's blockstates
					// included, are already in the palette geometry. Signs are handled by the
					// mode-independent buildSignMeshes pass.
					if (blockName && this.cubane.isBlockEntityModel(blockName)) {
						tileEntityBlocks.push({
							x: pos[0],
							y: pos[1],
							z: pos[2],
							paletteIndex: -1,
							blockName: blockName,
							nbtData: entity, // The entity structure from WASM is compatible enough or we use it as is
						});
					}
				}
			} else {
				// Fallback: JS-side filtering using cached spatial index
				const blockEntityMap = schematicObject.getBlockEntitiesMap();

				// Only scan for entities if map is not empty and reasonably sized
				// For very large entity maps, skip to avoid O(E*C) complexity
				if (blockEntityMap.size > 0 && blockEntityMap.size < 10000) {
					// Use spatial cache if available, otherwise build it once
					let spatialCache = (schematicObject as any)._entitySpatialCache as
						Map<string, any[]> | undefined;

					if (!spatialCache) {
						spatialCache = new Map<string, any[]>();
						for (const [, entity] of blockEntityMap) {
							const pos = entity.position;
							const chunkKey = `${Math.floor(pos[0] / this.chunkSize)},${Math.floor(pos[1] / this.chunkSize)},${Math.floor(pos[2] / this.chunkSize)}`;
							if (!spatialCache.has(chunkKey)) {
								spatialCache.set(chunkKey, []);
							}
							spatialCache.get(chunkKey)!.push(entity);
						}
						(schematicObject as any)._entitySpatialCache = spatialCache;
					}

					// O(1) lookup for this chunk's entities
					const chunkEntities = spatialCache.get(
						chunkKey(chunkData.chunk_x, chunkData.chunk_y, chunkData.chunk_z)
					);

					if (chunkEntities && chunkEntities.length > 0) {
						for (const entity of chunkEntities) {
							const pos = entity.position;
							const blockName = schematicObject.schematicWrapper.get_block(pos[0], pos[1], pos[2]);

							// As above: built-in entity models only; signs have their own pass.
							if (blockName && this.cubane.isBlockEntityModel(blockName)) {
								tileEntityBlocks.push({
									x: pos[0],
									y: pos[1],
									z: pos[2],
									paletteIndex: -1,
									blockName: blockName,
									nbtData: entity,
								});
							}
						}
					}
				}
			}

			// Determine chunk origin
			const originX = chunkData.chunk_x * this.chunkSize;
			const originY = chunkData.chunk_y * this.chunkSize;
			const originZ = chunkData.chunk_z * this.chunkSize;

			const resultMeshes: THREE.Object3D[] = [];

			// Try GPU compute first, then fall back to workers
			let buildResult: { meshes: any[]; origin: number[] } | null = null;

			// GPU Compute path
			if (this.useGPUCompute && this.computeMeshBuilder?.isReady) {
				try {
					const gpuResult = await this.computeMeshBuilder.buildChunk(
						workerBlocks as Int32Array,
						[originX, originY, originZ],
						chunkId
					);

					if (gpuResult) {
						buildResult = {
							meshes: gpuResult.geometries,
							origin: gpuResult.origin,
						};
					}
				} catch (error) {
					console.warn("[WorldMeshBuilder] GPU compute failed, falling back to workers:", error);
					// Fall through to worker path
				}
			}

			// Worker fallback path
			if (!buildResult) {
				const answer = await this.meshChunkInWorker(
					chunkId,
					workerBlocks,
					[originX, originY, originZ],
					palette,
					schematicObject,
					chunkData.apronBlocks
				);
				buildResult = {
					meshes: answer.meshes,
					origin: answer.origin ?? [originX, originY, originZ],
				};
			}

			try {
				// Process build result (same for GPU and worker)
				const workerResult = buildResult;

				if (!workerResult) {
					console.warn("[WorldMeshBuilder] No build result available");
					return resultMeshes;
				}

				// Reconstruct meshes from worker buffers
				if (workerResult.meshes) {
					for (const meshData of workerResult.meshes) {
						const geometry = new THREE.BufferGeometry();

						// Handle quantized positions
						// Worker sends Int16Array, we load it as BufferAttribute
						if (meshData.positions) {
							// BufferAttribute(array, itemSize, normalized)
							// Int16Array with normalized=false sends raw integer values to shader, which are cast to float
							const posAttr = new THREE.BufferAttribute(meshData.positions, 3, false);
							geometry.setAttribute("position", posAttr);
						}

						if (meshData.normals) {
							// Convert Int8 normals to Float32 for WebGPU compatibility
							const float32Normals = convertInt8NormalsToFloat32(meshData.normals);
							const normAttr = new THREE.BufferAttribute(float32Normals, 3);
							geometry.setAttribute("normal", normAttr);
						}

						if (meshData.uvs) {
							// Float32Array for UVs to support tiling > 1.0
							const uvAttr = new THREE.BufferAttribute(meshData.uvs, 2);
							geometry.setAttribute("uv", uvAttr);
						}

						if (meshData.indices) {
							geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
						}

						// Groups
						if (meshData.groups) {
							for (const group of meshData.groups) {
								geometry.addGroup(group.start, group.count, group.materialIndex);
							}
							// the WASM mesher's layer runs: a range of layers is one index range per group
							const layerIndex = meshData.layers
								? layerIndexOf(meshData.groups, meshData.layers)
								: null;
							if (layerIndex) geometry.userData.layerIndex = layerIndex;
						}

						const mesh = new THREE.Mesh(geometry, cache.globalMaterials);
						mesh.name = `${meshData.category}_chunk`;

						// Apply de-quantization scale for position
						// 1.0 / POSITION_SCALE
						const scale = 1.0 / POSITION_SCALE;
						mesh.scale.setScalar(scale);

						// Apply chunk origin offset
						// The worker produces geometry relative to this origin
						if (workerResult.origin) {
							mesh.position.set(
								workerResult.origin[0],
								workerResult.origin[1],
								workerResult.origin[2]
							);
						}

						this.configureMeshForCategory(mesh, meshData.category as keyof ChunkMeshes);
						resultMeshes.push(mesh);
					}
				}

				// Process tile entities (Main Thread)
				if (tileEntityBlocks.length > 0) {
					// const palette = this.paletteCache.palette; // Not needed if we use blockName
					for (const tileBlock of tileEntityBlocks) {
						const { x, y, z, paletteIndex, blockName, nbtData } = tileBlock;

						// If we have direct blockName, use it. Otherwise look up via paletteIndex (legacy path)
						let blockString = "";
						if (blockName) {
							blockString = blockName;
							// Note: We might need properties. get_block returns just name?
							// get_block returns full state string "minecraft:chest[facing=north]" usually?
							// Actually nucleation get_block returns just name or state?
							// Let's assume we might need to fetch full state if get_block returns only "minecraft:chest"

							// Optimization: If needed, we can assume 'blockName' from the loop above is sufficient
							// or fetch properties if missing.
						} else if (paletteIndex >= 0) {
							const blockState = cache.palette[paletteIndex];
							blockString = this.createBlockStringFromPaletteEntry(blockState);
						}

						if (blockString) {
							try {
								// const blockString = this.createBlockStringFromPaletteEntry(blockState);
								const customMesh = await this.cubane.getBlockMesh(
									blockString,
									"plains",
									false,
									nbtData.nbt || nbtData
								);
								if (customMesh) {
									const currentOffset = customMesh.position.clone();
									customMesh.position.set(
										x + currentOffset.x,
										y + currentOffset.y,
										z + currentOffset.z
									);
									customMesh.name = `tile_entity_${blockString}_${x}_${y}_${z}`;
									// shown with its layer and cell group (SchematicObject.setLayerRange, setHiddenGroups)
									customMesh.userData.layerY = y;
									customMesh.userData.cellGroup = schematicObject.cellGroupAt(x, y, z);
									resultMeshes.push(customMesh);
								}
							} catch (e) {
								console.warn("Tile entity error", e);
							}
						}
					}
				}

				// Blocks with connected textures (Fusion), one mesh per position, tagged with their chunk as in a batch
				const connected = await this.buildConnectedBlockMeshes(blocksToProcess, schematicObject);
				for (const mesh of connected) mesh.userData.connectedChunk = chunkId;
				resultMeshes.push(...connected);
			} catch (error) {
				console.error("Error building chunk mesh:", error);
			}

			return resultMeshes;
		});
	}

	// Helper methods...
	/**
	 * Per-position meshes for the blocks of a chunk whose textures connect to their
	 * neighbours (Fusion connected textures). The palette geometry cannot hold them,
	 * so each gets Cubane's mesh for its own neighbourhood, read from the schematic
	 * (so a neighbour in the next chunk counts too).
	 */
	private async buildConnectedBlockMeshes(
		blocks: Int32Array | number[][],
		schematicObject: SchematicObject,
		// cells taken as air (hidden by a cell filter): the blocks beside them show the faces and tiles they would
		// with nothing there
		hiddenAt?: (x: number, y: number, z: number) => boolean
	): Promise<THREE.Object3D[]> {
		const { connecting, cache } = this.paletteFor(schematicObject);
		if (connecting.size === 0 || !cache) return [];
		const wrapper = schematicObject.schematicWrapper;
		const states = new Map<string, NeighborState | null>();
		const stateAt = (x: number, y: number, z: number): NeighborState | null => {
			const key = `${x},${y},${z}`;
			let state = states.get(key);
			if (state === undefined) {
				state = null;
				// a hidden cell is air
				if (!hiddenAt?.(x, y, z)) {
					try {
						const bs = wrapper.get_block_with_properties(x, y, z);
						const name: string | undefined = bs?.name();
						// cave and void air are air too (they were read as blocks here)
						if (name && !isAir(name)) {
							const properties: Record<string, string> = {};
							const p = bs?.properties();
							if (p && typeof p === "object") {
								for (const [k, v] of Object.entries(p)) properties[k] = String(v);
							}
							state = { name: name.includes(":") ? name : `minecraft:${name}`, properties };
						}
					} catch {
						// outside the schematic
					}
				}
				states.set(key, state);
			}
			return state;
		};

		const built: Array<{
			object: THREE.Object3D;
			category: keyof ChunkMeshes;
			layer: number;
			group: number;
		}> = [];
		const isInt32 = blocks instanceof Int32Array;
		const count = isInt32 ? blocks.length / 4 : blocks.length;
		for (let i = 0; i < count; i++) {
			const [x, y, z, paletteIndex] = isInt32
				? [blocks[i * 4], blocks[i * 4 + 1], blocks[i * 4 + 2], blocks[i * 4 + 3]]
				: (blocks as number[][])[i];
			if (!connecting.has(paletteIndex)) continue;
			const blockString = this.createBlockStringFromPaletteEntry(cache.palette[paletteIndex]);
			try {
				const mesh = await this.cubane.getConnectedBlockMesh(blockString, "plains", (dx, dy, dz) =>
					stateAt(x + dx, y + dy, z + dz)
				);
				if (!mesh) continue;
				const off = mesh.position.clone();
				mesh.position.set(x + off.x, y + off.y, z + off.z);
				const category = (cache.blockData[paletteIndex]?.category ?? "solid") as keyof ChunkMeshes;
				built.push({
					object: mesh,
					category,
					layer: y,
					group: schematicObject.cellGroupAt(x, y, z),
				});
			} catch (e) {
				console.warn("[WorldMeshBuilder] connected block failed", blockString, e);
			}
		}
		return this.mergeConnectedMeshes(built);
	}

	/**
	 * Merges the per-position connected-texture meshes of a chunk into one mesh per draw category, with a
	 * geometry group per shared material (the same MaterialRegistry materials the palette meshes use). A
	 * few draw calls a chunk instead of an object per block face, and the meshes are configured for their
	 * category like the palette's (glass draws in the transparent pass). The geometry is in schematic
	 * coordinates, like the palette meshes' blocks. A face with several materials stays as it is.
	 */
	private mergeConnectedMeshes(
		built: Array<{
			object: THREE.Object3D;
			category: keyof ChunkMeshes;
			layer: number;
			group: number;
		}>
	): THREE.Object3D[] {
		const out: THREE.Object3D[] = [];
		// category -> shared material -> geometries in schematic coordinates, with their block's layer and cell group
		type Placed = { geometry: THREE.BufferGeometry; layer: number; group: number };
		const buckets = new Map<keyof ChunkMeshes, Map<THREE.Material, Placed[]>>();
		// Each merged mesh holds a shared material once, and disposing it releases it once: so one registry
		// reference per category's mesh and material, not one per face (those were never released, and the
		// materials could never be disposed). The blocks' meshes are clones sharing a few source materials.
		const sharedOf = new Map<keyof ChunkMeshes, Map<THREE.Material, THREE.Material>>();
		const shared = (category: keyof ChunkMeshes, source: THREE.Material): THREE.Material => {
			let bySource = sharedOf.get(category);
			if (!bySource) sharedOf.set(category, (bySource = new Map()));
			let material = bySource.get(source);
			if (!material) {
				const known = MaterialRegistry.peekMaterial(source);
				material =
					known && buckets.get(category)?.has(known) ? known : MaterialRegistry.getMaterial(source);
				bySource.set(source, material);
			}
			return material;
		};
		for (const { object, category, layer, group } of built) {
			object.updateMatrixWorld(true);
			object.traverse((child) => {
				if (!(child instanceof THREE.Mesh) || !child.geometry?.attributes?.position) return;
				if (Array.isArray(child.material)) {
					const kept = child.clone();
					child.matrixWorld.decompose(kept.position, kept.quaternion, kept.scale);
					this.configureMeshForCategory(kept, category);
					// shown with its layer and cell group (SchematicObject.setLayerRange, setHiddenGroups)
					kept.userData.layerY = layer;
					kept.userData.cellGroup = group;
					out.push(kept);
					return;
				}
				const geometry = child.geometry.clone().applyMatrix4(child.matrixWorld);
				if (!geometry.index) {
					const n = geometry.attributes.position.count;
					geometry.setIndex(Array.from({ length: n }, (_, k) => k));
				}
				const material = shared(category, child.material);
				let byMaterial = buckets.get(category);
				if (!byMaterial) buckets.set(category, (byMaterial = new Map()));
				const list = byMaterial.get(material);
				if (list) list.push({ geometry, layer, group });
				else byMaterial.set(material, [{ geometry, layer, group }]);
			});
		}
		for (const [category, byMaterial] of buckets) {
			const materials: THREE.Material[] = [];
			const perMaterial: THREE.BufferGeometry[] = [];
			// each material's blocks by layer, then cell group, so what a filter shows is a few index ranges
			// (utils/layerRange.ts); mergeBufferGeometries keeps the inputs' order
			const pieces: Parameters<typeof layerIndexOfPieces>[0] = [];
			let at = 0;
			for (const [material, placed] of byMaterial) {
				placed.sort((a, b) => a.layer - b.layer || a.group - b.group);
				const materialIndex = materials.length;
				for (const { geometry, layer, group } of placed) {
					const count = geometry.index ? geometry.index.count : 0;
					pieces.push({ materialIndex, layer, group, start: at, count });
					at += count;
				}
				materials.push(material);
				perMaterial.push(mergeBufferGeometries(placed.map((p) => p.geometry)));
				for (const p of placed) p.geometry.dispose();
			}
			const merged = mergeBufferGeometries(perMaterial);
			const layerIndex: LayerIndex = layerIndexOfPieces(pieces);
			for (const g of layerIndex.groups)
				merged.addGroup(g.starts[0] ?? g.end, g.end - (g.starts[0] ?? g.end), g.materialIndex);
			for (const g of perMaterial) g.dispose();
			merged.userData.layerIndex = layerIndex;
			merged.computeBoundingSphere();
			const mesh = new THREE.Mesh(merged, materials);
			mesh.name = `connected_${category}`;
			// it took a registry reference to each of its materials, which disposing it gives back
			mesh.userData.holdsMaterialRefs = true;
			this.configureMeshForCategory(mesh, category);
			out.push(mesh);
		}
		return out;
	}

	/** A palette entry's block string, as every other block string of it (formatBlockString: one per state). */
	private createBlockStringFromPaletteEntry(blockState: any): string {
		return formatBlockString(
			namespacedId(blockState.name || "minecraft:stone"),
			blockState.properties ?? {}
		);
	}

	/** Leaves, vanilla's and mods' (oak_leaves, wilderwild:baobab_leaves, …), as a word of the id. */
	private static readonly LEAVES = /[:_]leaves(_|$)/;
	/** Glass and ice, as a word of the id: glass, red_stained_glass, glass_pane, packed_ice (not rice_bag). */
	private static readonly SEE_THROUGH = /[:_](glass|ice)(_|$)/;

	/** The fluid a block holds (faceCulling.ts FLUID_*): water for water and waterlogged blocks, lava for lava. */
	private fluidOf(name: string, properties?: Record<string, string>): number {
		const liquid = liquidOf(name);
		if (liquid === "lava") return FLUID_LAVA;
		if (liquid === "water" || isWaterlogged(name, properties)) return FLUID_WATER;
		return FLUID_NONE;
	}

	/** The fluid a geometry is, from its material (a waterlogged block's water cube), or FLUID_NONE. */
	private fluidOfMaterial(material: THREE.Material): number {
		const spec = this.cubane.faceMaterialSpec(material);
		const u = material.userData ?? {};
		if (spec?.isWater || u.isWater) return FLUID_WATER;
		if (spec?.isLava || u.isLava) return FLUID_LAVA;
		return FLUID_NONE;
	}

	private getBlockCategory(name: string, properties?: Record<string, string>): keyof ChunkMeshes {
		const blockName = namespacedId(name);
		// the liquids themselves (liquids.ts: not water_cauldron, lava_cauldron and the like)
		if (liquidOf(blockName)) return "water";
		// Waterlogged blocks carry a surrounding water cube, drawn in the water pass with
		// them. The category only sorts meshes: culling goes by cull key and fluid
		// (faceCulling.ts), so the water cube culls against neighbouring water while the
		// block's own faces cull as they would dry.
		if (isWaterlogged(blockName, properties)) return "water";
		if (
			WorldMeshBuilder.SEE_THROUGH.test(blockName) ||
			WorldMeshBuilder.LEAVES.test(blockName) ||
			blockName === "minecraft:barrier"
		)
			return "transparent";
		return "solid";
	}

	private configureMeshForCategory(mesh: THREE.Mesh, category: keyof ChunkMeshes): void {
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		mesh.frustumCulled = true;

		// Material properties are set by precomputePaletteGeometries (MaterialRegistry keys). Every category draws
		// at the same renderOrder: translucent materials sit in any of them (water, glass, slime among solids),
		// and a renderOrder by category would beat three.js's back-to-front sort of them.
		mesh.renderOrder = BLOCK_RENDER_ORDER;
		if (category === "redstone") mesh.userData.isDynamic = true;
	}

	private extractAllMeshData(rootCubaneObject: THREE.Object3D): ProcessedBlockGeometry[] {
		const allMeshData: ProcessedBlockGeometry[] = [];
		rootCubaneObject.updateMatrixWorld(true);

		rootCubaneObject.traverse((child) => {
			if (
				child instanceof THREE.Mesh &&
				child.geometry &&
				child.material &&
				child.visible &&
				child !== rootCubaneObject
			) {
				const material = Array.isArray(child.material) ? child.material[0] : child.material;
				if (!material || !(material instanceof THREE.Material)) return;

				const geometry = child.geometry.clone();
				const matrixRelativeToRoot = child.matrixWorld
					.clone()
					.multiply(new THREE.Matrix4().copy(rootCubaneObject.matrixWorld).invert());
				geometry.applyMatrix4(matrixRelativeToRoot);

				if (geometry.attributes.position.count > 0) {
					allMeshData.push({ geometry, material });
				} else {
					geometry.dispose();
				}
			}
		});
		return allMeshData;
	}

	private createFallbackObject3D(blockString: string): THREE.Object3D {
		const mesh = new THREE.Mesh(
			new THREE.BoxGeometry(0.7, 0.7, 0.7),
			new THREE.MeshBasicMaterial({
				color: 0xee00ee,
				wireframe: true,
				name: `fallback-mat-${blockString}`,
			})
		);
		mesh.name = `fallback-mesh-${blockString}`;
		const group = new THREE.Group();
		group.add(mesh);
		group.name = `fallback-object-${blockString}`;
		return group;
	}

	public getPaletteStats() {
		return {
			isReady: this.paletteCache?.isReady || false,
			paletteSize: this.paletteCache?.blockData.length || 0,
			uniqueMaterials: this.paletteCache?.globalMaterials.length || 0,
			memoryEstimate:
				this.paletteCache?.blockData.reduce((total, blockData) => {
					return (
						total +
						blockData.materialGroups.reduce((subtotal, group) => {
							return subtotal + (group.baseGeometry.attributes.position?.count || 0) * 3 * 4;
						}, 0)
					);
				}, 0) || 0,
		};
	}

	public enableInstancedRendering(group: THREE.Group, merged: boolean = false): void {
		this.useInstancedRendering = true;
		this.instancedRenderer = new InstancedBlockRenderer(group, this.paletteCache);

		if (merged) {
			this.instancedRenderer.initializeInstancedMeshesMerged();
		} else {
			this.instancedRenderer.initializeInstancedMeshes();
		}
	}

	public disableInstancedRendering(): void {
		this.useInstancedRendering = false;
		if (this.instancedRenderer) {
			this.instancedRenderer.disposeInstancedMeshes();
			this.instancedRenderer = null;
		}
	}

	public async renderSchematicInstanced(schematicObject: SchematicObject): Promise<void> {
		if (!this.useInstancedRendering || !this.instancedRenderer) {
			throw new Error("Instanced rendering not enabled. Call enableInstancedRendering() first.");
		}

		const schematic = schematicObject.schematicWrapper;

		const allBlockIndices = schematic.blocks_indices();

		const allBlocks: Array<{
			x: number;
			y: number;
			z: number;
			paletteIndex: number;
		}> = [];

		for (const blockData of allBlockIndices) {
			const [x, y, z, paletteIndex] = blockData;

			// max exclusive, as every other build path takes the bounds
			const renderingBounds = schematicObject.renderingBounds;
			if (renderingBounds?.enabled && !inRenderingBounds(renderingBounds, x, y, z)) continue;

			allBlocks.push({ x, y, z, paletteIndex });
		}

		this.instancedRenderer.renderBlocksInstanced(allBlocks);

		// Blocks with connected textures (Fusion) have no palette geometry to instance: they are drawn per position
		// from their neighbours, as in the chunked paths. Those of an earlier instanced render are replaced.
		const group = schematicObject.group;
		for (const old of group.children.filter((c) => c.userData.connectedBlocks)) {
			group.remove(old);
			// geometry and the registry references the merged meshes hold (holdsMaterialRefs): freeing only the
			// geometry kept one reference per material per instanced render
			disposeObject(old);
		}
		const connectingPalette = this.paletteFor(schematicObject).connecting;
		if (connectingPalette.size > 0) {
			const connecting = allBlocks.filter((b) => connectingPalette.has(b.paletteIndex));
			const blocks = connecting.map((b) => [b.x, b.y, b.z, b.paletteIndex]);
			for (const mesh of await this.buildConnectedBlockMeshes(blocks, schematicObject)) {
				mesh.userData.connectedBlocks = true;
				group.add(mesh);
			}
		}
	}

	public dispose(): void {
		const palettes = [...this.palettes.values()];
		for (const state of palettes) this.dropPalette(state);
		// Reject any pending requests before destroying workers
		this.pendingRequests.forEach((request, chunkId) => {
			request.reject(new Error(`Worker terminated before processing chunk ${chunkId}`));
		});
		this.pendingRequests.clear();
		// and the rest in flight: caps draw none, batches fail
		this.capsRequests.forEach((resolve, requestId) => resolve({ requestId, meshes: [] }));
		this.capsRequests.clear();
		const gone = () => new Error("WorldMeshBuilder disposed");
		for (const request of [...this.batchPendingChunks.values(), ...this.batchFinishes.values()])
			request.reject(gone());
		this.batchPendingChunks.clear();
		this.batchFinishes.clear();

		// Turn down this builder's waits for a worker, out of a queue other builders may share
		for (const [waiter, reject] of this.queuedWaiters) {
			const at = this.workerQueue.indexOf(waiter);
			if (at >= 0) this.workerQueue.splice(at, 1);
			reject(gone());
		}
		this.queuedWaiters.clear();
		this.workerQueue = [];

		if (this.paletteCache) {
			this.paletteCache.blockData.forEach((blockData) => {
				blockData.materialGroups.forEach((group) => {
					if (group.baseGeometry) {
						group.baseGeometry.dispose();
					}
				});
			});
			this.paletteCache = null;
		}

		// Dispose GPU compute resources
		if (this.computeMeshBuilder) {
			this.computeMeshBuilder.dispose();
			this.computeMeshBuilder = null;
		}
		this.useGPUCompute = false;
		this.gpuInitPromise = null;

		// Terminate workers only if we own them. A shared-context pool is owned by
		// the context (and terminated when it disposes), so a context-backed builder
		// must not terminate workers still used by sibling renderers.
		const context = this.schematicRenderer.options.context;
		if (!context) {
			this.workers.forEach((w) => w.terminate());
		} else {
			// The palettes requests in flight held: dropped in the shared workers now, as releaseHold would once the
			// last hold went (it posts to this.workers, empty by then). A worker takes its messages in order, so the
			// drop comes after what was queued for it.
			for (const state of palettes) if (state.dropped) this.dropInWorkers(state);
			// The workers this builder borrowed go back to the shared pool, a builder waiting for one first: the
			// requests they held were turned down above, so no returnWorker would give them back, and every
			// builder's getFreeWorker waited for good once all were gone. A reply to this builder's request that
			// reaches the next borrower is one it does not know, and it ignores it.
			for (const worker of this.lentWorkers) {
				worker.onmessage = null;
				const waiter = context.sharedWorkerQueue.shift();
				if (waiter) waiter(worker);
				else context.sharedFreeWorkers.push(worker);
			}
		}
		this.lentWorkers.clear();
		this.workers = [];
		this.freeWorkers = [];

		console.log("[WorldMeshBuilder] Disposed palette cache, GPU compute, and workers.");
	}
}
