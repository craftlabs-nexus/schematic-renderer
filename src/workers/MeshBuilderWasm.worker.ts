/**
 * WASM-based Mesh Builder Worker
 *
 * Uses Rust/WASM for high-performance geometry merging with face culling.
 * Supports SharedArrayBuffer for zero-copy data transfer when available.
 */

// Import the WASM module - Vite will handle the bundling
// @ts-ignore - WASM imports are handled specially
import initWasm, { MeshBuilder, get_version } from "../wasm/mesh_builder_wasm.js";
// @ts-ignore - WASM binary import
import wasmBase64 from "../wasm/mesh_builder_wasm_bg.wasm?inline";
import { CHUNK_INPUT_HEADER_SIZE } from "./SharedMemoryManager";

// Types
type PaletteGeometryData = {
	index: number;
	occlusionFlags: number;
	category?: string;
	geometries: Array<{
		positions: Float32Array;
		normals: Float32Array;
		uvs: Float32Array;
		indices: Uint16Array | Uint32Array;
		materialIndex: number;
	}>;
};

type ChunkBuildRequest = {
	chunkId: string;
	blocks: number[][] | Int32Array;
	chunkOrigin?: [number, number, number];
	// SharedArrayBuffer support
	sharedInputBuffer?: SharedArrayBuffer;
	// Neighbouring chunks' boundary blocks (flat [x, y, z, paletteIndex, …], world
	// coords) for cross-chunk face culling. Occlusion lookup only — never rendered.
	apronBlocks?: Int32Array;
	// Identifies which view's palette to mesh against (shared worker pools). Absent → default.
	meshContextId?: string;
	// Each block's cell group (SchematicObject.setHiddenGroups), one per block; absent: all in group 0.
	cellGroups?: Uint16Array;
	// The chunk's coordinates, for a batch to say which of its vertices are of which chunk (utils/batchChunks.ts).
	chunk?: [number, number, number];
};

// Reused empty apron so chunks with no neighbour data don't allocate.
const EMPTY_APRON = new Int32Array(0);
const NO_GROUPS = new Uint16Array(0);

// State. Mesh builders and batch accumulators are namespaced by `meshContextId`
// so several renderers can share one worker pool without their palettes
// colliding — one WASM MeshBuilder per view. Single-instance use stays on the
// `DEFAULT_CTX` id, so behavior is unchanged when no id is supplied.
const DEFAULT_CTX = "default";
const meshBuilders = new Map<string, MeshBuilder>();
let isInitialized = false;
let initPromise: Promise<void> | null = null;
let useGreedyMeshing = false; // Enable greedy meshing optimization

/** Get (or lazily create) the WASM MeshBuilder for a mesh context. WASM must be initialized first. */
function getMeshBuilder(meshContextId: string = DEFAULT_CTX): MeshBuilder {
	let mb = meshBuilders.get(meshContextId);
	if (!mb) {
		mb = new MeshBuilder();
		meshBuilders.set(meshContextId, mb);
	}
	return mb;
}

// Batch mode state - accumulates all chunks before returning
// Uses Float32 for positions to avoid Int16 overflow with world coordinates
// @ts-expect-error State tracking variable used internally
let _batchMode = false;
type Accumulator = {
	positions: number[]; // Will become Float32Array (world coordinates, not quantized)
	normals: number[]; // Will become Int8Array
	uvs: number[]; // Will become Float32Array
	indices: number[];
	groups: Array<{ start: number; count: number; materialIndex: number }>;
	// the chunks' runs, flat [layer, group, start, count, ...] in the merged index buffer (WASM build_chunk);
	// null once a mesh without them came in
	layers: number[] | null;
	// the chunks accumulated, flat [chunkX, chunkY, chunkZ, firstVertex, ...]: each chunk's vertices run from its
	// first to the next chunk's (utils/batchChunks.ts)
	chunks: number[];
	vertexOffset: number;
};
const newAccumulator = (): Accumulator => ({
	positions: [],
	normals: [],
	uvs: [],
	indices: [],
	groups: [],
	layers: [],
	chunks: [],
	vertexOffset: 0,
});
const batchAccumulators: Map<string, Accumulator> = new Map();

// Performance tracking
let buildCount = 0;
let totalBuildTime = 0;
let totalDataTransferTime = 0;

/**
 * Initialize the WASM module
 */
async function initialize(): Promise<void> {
	if (isInitialized) return;
	if (initPromise) return initPromise;

	initPromise = (async () => {
		try {
			// Initialize WASM - use new API format to avoid deprecation warning
			await initWasm({ module_or_path: wasmBase64 });

			// Mesh builders are created lazily per mesh context (see getMeshBuilder).
			isInitialized = true;
		} catch (error) {
			console.error("[MeshBuilderWasm Worker] Failed to initialize:", error);
			throw error;
		}
	})();

	return initPromise;
}

// Initialize immediately when worker loads
initialize().catch(console.error);

/**
 * Handle messages from main thread
 */
self.onmessage = async (event: MessageEvent) => {
	const { type, ...payload } = event.data;

	try {
		// Ensure WASM is initialized before processing
		await initialize();

		switch (type) {
			case "updatePalette":
				updatePalette(payload.paletteData, payload.meshContextId ?? DEFAULT_CTX);
				break;
			case "dropPalette":
				dropPalette(payload.meshContextId ?? DEFAULT_CTX);
				break;
			case "buildChunk":
				buildChunk(payload as unknown as ChunkBuildRequest);
				break;
			case "startBatch":
				startBatch(payload.meshContextId ?? DEFAULT_CTX);
				break;
			case "finishBatch":
				finishBatch(payload.meshContextId ?? DEFAULT_CTX);
				break;
			case "buildChunkBatched":
				buildChunkBatched(payload as unknown as ChunkBuildRequest);
				break;
			case "buildCaps":
				buildCaps(payload as unknown as CapsBuildRequest);
				break;
			case "setGreedyMeshing":
				useGreedyMeshing = payload.enabled;
				self.postMessage({ type: "greedyMeshingSet", enabled: useGreedyMeshing });
				break;
			default:
				console.warn(`[MeshBuilderWasm Worker] Unknown message type: ${type}`);
		}
	} catch (error: any) {
		console.error("[MeshBuilderWasm Worker] Error:", error);
		// with what it answers (a chunk, a caps request), so the caller waiting for it hears of the failure
		self.postMessage({
			type: "error",
			error: error.message,
			chunkId: payload.chunkId,
			requestId: payload.requestId,
		});
	}
};

/**
 * Start batch mode - chunks will be accumulated instead of returned
 */
// Batch accumulators are keyed by `${meshContextId}\0${category}` so concurrent
// batches from different views (sharing the pool) don't mix.
const ACC_DELIM = "\u0000";
const accKey = (meshContextId: string, category: string) =>
	`${meshContextId}${ACC_DELIM}${category}`;

function startBatch(meshContextId: string) {
	_batchMode = true;
	// Clear only this context's accumulators (other views may be mid-batch).
	for (const key of [...batchAccumulators.keys()]) {
		if (key.startsWith(meshContextId + ACC_DELIM)) batchAccumulators.delete(key);
	}
	self.postMessage({ type: "batchStarted" });
}

/**
 * Finish batch mode - return all accumulated geometry as merged buffers
 * Uses Float32 for positions (no quantization) to support world-space coordinates
 */
/** An accumulator's geometry as one mesh of typed arrays (world Float32 positions), its buffers listed to transfer. */
function finishAccumulator(category: string, acc: Accumulator, transferables: Transferable[]) {
	const positions = new Float32Array(acc.positions);
	const normals = new Int8Array(acc.normals);
	const uvs = new Float32Array(acc.uvs);
	const indices =
		acc.vertexOffset > 65535 ? new Uint32Array(acc.indices) : new Uint16Array(acc.indices);
	const layers = acc.layers ? new Int32Array(acc.layers) : undefined;
	const chunks = acc.chunks.length ? new Int32Array(acc.chunks) : undefined;
	transferables.push(positions.buffer, normals.buffer, uvs.buffer, indices.buffer);
	if (layers) transferables.push(layers.buffer);
	if (chunks) transferables.push(chunks.buffer);
	return {
		category,
		positions,
		normals,
		uvs,
		indices,
		groups: acc.groups,
		layers,
		chunks,
		vertexCount: acc.vertexOffset,
		isFloat32Positions: true, // Flag to tell main thread not to de-quantize
	};
}

function finishBatch(meshContextId: string) {
	const startTime = performance.now();
	const meshes: any[] = [];
	const transferables: Transferable[] = [];

	const prefix = meshContextId + ACC_DELIM;
	for (const [key, acc] of batchAccumulators) {
		if (!key.startsWith(prefix)) continue;
		if (acc.vertexOffset === 0) continue;
		meshes.push(finishAccumulator(key.slice(prefix.length), acc, transferables));
	}

	const elapsed = performance.now() - startTime;

	_batchMode = false;
	for (const key of [...batchAccumulators.keys()]) {
		if (key.startsWith(prefix)) batchAccumulators.delete(key);
	}

	(self as unknown as Worker).postMessage(
		{
			type: "batchFinished",
			meshes,
			origin: [0, 0, 0],
			timings: { finalize: elapsed },
		},
		{ transfer: transferables }
	);
}

/**
 * Build chunk in batch mode - accumulates results instead of returning
 */
function buildChunkBatched(request: ChunkBuildRequest) {
	if (!isInitialized) {
		throw new Error("WASM not initialized");
	}

	const { chunkId, blocks, chunkOrigin, sharedInputBuffer, apronBlocks } = request;
	const meshContextId = request.meshContextId ?? DEFAULT_CTX;
	const mb = getMeshBuilder(meshContextId);
	const startTime = performance.now();

	let blocksArray: Int32Array;
	let originX: number;
	let originY: number;
	let originZ: number;

	// Get blocks data (same logic as buildChunk)
	if (sharedInputBuffer) {
		const view = new DataView(sharedInputBuffer);
		const blockCount = view.getUint32(0, true);
		originX = view.getInt32(4, true);
		originY = view.getInt32(8, true);
		originZ = view.getInt32(12, true);
		blocksArray = new Int32Array(sharedInputBuffer, CHUNK_INPUT_HEADER_SIZE, blockCount * 4);
	} else if (blocks instanceof Int32Array) {
		blocksArray = blocks;
		originX = chunkOrigin?.[0] ?? 0;
		originY = chunkOrigin?.[1] ?? 0;
		originZ = chunkOrigin?.[2] ?? 0;
	} else {
		// Acknowledge even empty chunks in batch mode
		self.postMessage({ type: "chunkAccumulated", chunkId });
		return;
	}

	if (blocksArray.length === 0) {
		self.postMessage({ type: "chunkAccumulated", chunkId });
		return;
	}

	// Build chunk with WASM - use chunk's min position as origin
	// Use greedy meshing if enabled for better vertex reduction
	const apron = apronBlocks ?? EMPTY_APRON;
	const result = useGreedyMeshing
		? mb.build_chunk_greedy(blocksArray, originX, originY, originZ, apron)
		: mb.build_chunk(
				blocksArray,
				originX,
				originY,
				originZ,
				apron,
				request.cellGroups ?? NO_GROUPS
			);

	// Accumulate results into batch buffers
	for (const mesh of result.meshes || []) {
		const category = mesh.category || "solid";

		// Get or create accumulator for this context + category
		const key = accKey(meshContextId, category);
		let acc = batchAccumulators.get(key);
		if (!acc) batchAccumulators.set(key, (acc = newAccumulator()));
		if (request.chunk) acc.chunks.push(...request.chunk, acc.vertexOffset);
		accumulate(acc, mesh, originX, originY, originZ);
	}

	const elapsed = performance.now() - startTime;
	buildCount++;
	totalBuildTime += elapsed;

	// Acknowledge chunk processed (no data returned in batch mode)
	self.postMessage({
		type: "chunkAccumulated",
		chunkId,
		timings: { total: elapsed },
	});
}

type CapsBuildRequest = {
	requestId: number;
	// shown cells beside hidden ones, in pieces small enough for the WASM's quantized positions (a chunk each),
	// with the hidden cells beside them as each piece's apron, and the shown cells' groups
	tiles: Array<{
		blocks: Int32Array;
		apron: Int32Array;
		origin: [number, number, number];
		cellGroups?: Uint16Array;
	}>;
	meshContextId?: string;
};

/**
 * The faces of shown cells that hidden cells beside them covered (WASM build_caps), merged per category like a
 * batch: what a viewer that hides some layers or cell groups draws on the cells it shows next to them.
 */
function buildCaps(request: CapsBuildRequest) {
	const mb = getMeshBuilder(request.meshContextId ?? DEFAULT_CTX);
	const accs = new Map<string, Accumulator>();
	for (const { blocks, apron, origin, cellGroups } of request.tiles) {
		if (blocks.length === 0) continue;
		const [ox, oy, oz] = origin;
		const result = mb.build_caps(blocks, ox, oy, oz, apron, cellGroups ?? NO_GROUPS);
		for (const mesh of result.meshes || []) {
			const category = mesh.category || "solid";
			let acc = accs.get(category);
			if (!acc) accs.set(category, (acc = newAccumulator()));
			accumulate(acc, mesh, ox, oy, oz);
		}
	}
	const transferables: Transferable[] = [];
	const meshes = [...accs].map(([category, acc]) =>
		finishAccumulator(category, acc, transferables)
	);
	(self as unknown as Worker).postMessage(
		{ type: "capsBuilt", requestId: request.requestId, meshes },
		{ transfer: transferables }
	);
}

/**
 * Appends one WASM mesh (quantized Int16 positions relative to the origin passed) to an accumulator, in world
 * Float32 coordinates, its indices, groups and layer runs offset to where they land.
 */
function accumulate(
	acc: Accumulator,
	mesh: any,
	originX: number,
	originY: number,
	originZ: number
) {
	const invScale = 1.0 / 1024; // WASM POSITION_SCALE
	const baseVertex = acc.vertexOffset;

	// Positions: de-quantized and moved by the origin, to world Float32
	if (mesh.positions) {
		for (let i = 0; i < mesh.positions.length; i += 3) {
			acc.positions.push(
				mesh.positions[i] * invScale + originX,
				mesh.positions[i + 1] * invScale + originY,
				mesh.positions[i + 2] * invScale + originZ
			);
		}
	}
	// Normals (Int8) and UVs as they are
	if (mesh.normals) for (let i = 0; i < mesh.normals.length; i++) acc.normals.push(mesh.normals[i]);
	if (mesh.uvs) for (let i = 0; i < mesh.uvs.length; i++) acc.uvs.push(mesh.uvs[i]);

	// Indices with the vertex offset; groups and layer runs with the index offset
	if (mesh.indices) {
		const indexStart = acc.indices.length;
		for (let i = 0; i < mesh.indices.length; i++) acc.indices.push(mesh.indices[i] + baseVertex);
		for (const group of mesh.groups ?? []) {
			acc.groups.push({
				start: indexStart + group.start,
				count: group.count,
				materialIndex: group.materialIndex,
			});
		}
		// a mesh without layer runs (greedy meshing) leaves the whole accumulator without them
		if (mesh.layers && acc.layers) {
			const runs = mesh.layers as Int32Array;
			for (let i = 0; i < runs.length; i += 4)
				acc.layers.push(runs[i], runs[i + 1], indexStart + runs[i + 2], runs[i + 3]);
		} else if (mesh.indices.length > 0) {
			acc.layers = null;
		}
	}

	acc.vertexOffset += mesh.positions ? mesh.positions.length / 3 : 0;
}

/** Frees a mesh context's WASM MeshBuilder (a palette no schematic draws with any more) and its batch's geometry. */
function dropPalette(meshContextId: string) {
	meshBuilders.get(meshContextId)?.free();
	meshBuilders.delete(meshContextId);
	for (const key of [...batchAccumulators.keys()]) {
		if (key.startsWith(meshContextId + ACC_DELIM)) batchAccumulators.delete(key);
	}
}

/**
 * Update palette geometry data in WASM
 */
function updatePalette(paletteData: PaletteGeometryData[], meshContextId: string = DEFAULT_CTX) {
	if (!isInitialized) {
		throw new Error("WASM not initialized");
	}
	const mb = getMeshBuilder(meshContextId);

	// Convert palette data to format expected by WASM
	// The WASM module expects: { index, occlusionFlags, category, geometries: [...] }
	const wasmPaletteData = paletteData.map((item) => ({
		index: item.index,
		occlusionFlags: item.occlusionFlags || 0,
		category: item.category || "solid",
		geometries: item.geometries.map((geom) => ({
			positions: geom.positions,
			normals: geom.normals,
			uvs: geom.uvs,
			indices: geom.indices instanceof Uint16Array ? new Uint32Array(geom.indices) : geom.indices,
			materialIndex: geom.materialIndex,
		})),
	}));

	mb.update_palette(wasmPaletteData);

	self.postMessage({ type: "paletteUpdated", count: paletteData.length });
}

/**
 * Build chunk mesh using WASM
 * Supports both SharedArrayBuffer (zero-copy) and regular transfers
 */
function buildChunk(request: ChunkBuildRequest) {
	if (!isInitialized) {
		throw new Error("WASM not initialized");
	}

	const { chunkId, blocks, chunkOrigin, sharedInputBuffer, apronBlocks } = request;
	const mb = getMeshBuilder(request.meshContextId ?? DEFAULT_CTX);
	const startTime = performance.now();
	let dataTransferStart = startTime;

	let blocksArray: Int32Array;
	let originX: number;
	let originY: number;
	let originZ: number;

	// Check if using SharedArrayBuffer (zero-copy path)
	if (sharedInputBuffer) {
		// Read directly from shared memory - NO COPY!
		const view = new DataView(sharedInputBuffer);
		const blockCount = view.getUint32(0, true);
		originX = view.getInt32(4, true);
		originY = view.getInt32(8, true);
		originZ = view.getInt32(12, true);

		// Create view into shared buffer - NO COPY!
		blocksArray = new Int32Array(sharedInputBuffer, CHUNK_INPUT_HEADER_SIZE, blockCount * 4);

		const dataTransferTime = performance.now() - dataTransferStart;
		totalDataTransferTime += dataTransferTime;
	} else {
		// Traditional path - data was copied via postMessage
		dataTransferStart = performance.now();

		if (blocks instanceof Int32Array) {
			blocksArray = blocks;
		} else if (Array.isArray(blocks)) {
			// Convert array of [x, y, z, paletteIndex] to flat Int32Array
			blocksArray = new Int32Array(blocks.length * 4);
			for (let i = 0; i < blocks.length; i++) {
				const block = blocks[i];
				blocksArray[i * 4] = block[0];
				blocksArray[i * 4 + 1] = block[1];
				blocksArray[i * 4 + 2] = block[2];
				blocksArray[i * 4 + 3] = block[3];
			}
		} else {
			self.postMessage({ type: "chunkBuilt", chunkId, meshes: [], origin: [0, 0, 0] });
			return;
		}

		// Calculate origin if not provided
		originX = chunkOrigin?.[0] ?? 0;
		originY = chunkOrigin?.[1] ?? 0;
		originZ = chunkOrigin?.[2] ?? 0;

		if (!chunkOrigin) {
			// Auto-detect origin from block positions
			let minX = Infinity,
				minY = Infinity,
				minZ = Infinity;
			for (let i = 0; i < blocksArray.length; i += 4) {
				minX = Math.min(minX, blocksArray[i]);
				minY = Math.min(minY, blocksArray[i + 1]);
				minZ = Math.min(minZ, blocksArray[i + 2]);
			}
			originX = minX;
			originY = minY;
			originZ = minZ;
		}
	}

	if (blocksArray.length === 0) {
		self.postMessage({ type: "chunkBuilt", chunkId, meshes: [], origin: [0, 0, 0] });
		return;
	}

	const wasmStart = performance.now();

	// Call WASM build_chunk (with or without greedy meshing)
	const apron = apronBlocks ?? EMPTY_APRON;
	const result = useGreedyMeshing
		? mb.build_chunk_greedy(blocksArray, originX, originY, originZ, apron)
		: mb.build_chunk(
				blocksArray,
				originX,
				originY,
				originZ,
				apron,
				request.cellGroups ?? NO_GROUPS
			);

	const wasmTime = performance.now() - wasmStart;
	const elapsed = performance.now() - startTime;

	// Track performance
	buildCount++;
	totalBuildTime += elapsed;

	// Log performance periodically
	if (buildCount % 50 === 0) {
		const avgTime = totalBuildTime / buildCount;
		const avgDataTime = totalDataTransferTime / buildCount;
		const memMode = sharedInputBuffer ? "SharedArrayBuffer" : "postMessage copy";
		console.log(
			`[MeshBuilderWasm Stats] Avg total: ${avgTime.toFixed(2)}ms, data: ${avgDataTime.toFixed(3)}ms (${memMode})`
		);
	}

	// Extract transferable buffers (still need to transfer output data)
	const transferables: Transferable[] = [];
	const meshes = result.meshes || [];

	for (const mesh of meshes) {
		if (mesh.positions?.buffer) transferables.push(mesh.positions.buffer);
		if (mesh.normals?.buffer) transferables.push(mesh.normals.buffer);
		if (mesh.uvs?.buffer) transferables.push(mesh.uvs.buffer);
		if (mesh.indices?.buffer) transferables.push(mesh.indices.buffer);
		if (mesh.layers?.buffer) transferables.push(mesh.layers.buffer);
	}

	self.postMessage(
		{
			type: "chunkBuilt",
			chunkId,
			meshes,
			origin: result.origin || [originX, originY, originZ],
			timings: {
				total: elapsed,
				wasm: wasmTime,
				dataTransfer: sharedInputBuffer ? 0 : elapsed - wasmTime,
			},
		},
		{ transfer: transferables }
	);
}
