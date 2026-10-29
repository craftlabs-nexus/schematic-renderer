// The palette's block shapes kept between visits (IndexedDB), so a palette is not built again from the pack's models
// each time: per block state, the geometry WorldMeshBuilder.buildPaletteCache makes from Cubane's mesh, what each
// geometry's material was made from (a FaceMaterialSpec: the material is made again from the session's atlas), its
// render category and its occlusion flags. Keyed by the packs (AssetLoader's content hash), the options that change
// a block's mesh and SHAPE_CACHE_VERSION; the shapes of the last MAX_PACK_SETS pack sets are kept.

import type * as THREE from "three";
import type { FaceMaterialSpec } from "./BlockMeshBuilder";
import type { TextureAlphaClass } from "./AssetLoader";
import { keptDatabase, transactionDone } from "../utils/idb";
import { idle } from "../utils/idle";

/** Raise when what the mesh code makes of a block changes: every shape kept before is then made again. */
// 2: occlusion flags follow the blockstate's x / y rotation (an upside-down stair no longer covers the block below)
// 3: an element drawn inside out (`from` past `to`) is centred on its midpoint (Wilder Wild's hollowed logs)
// 4: uvlock keeps textures fixed to the world; a shape keeps its cull key (see-through blocks hide the same block only)
// 5: a material's fingerprint holds its place in the atlas
// 6: a connected-texture block keeps its culling (it kept none, and hid none of its neighbours' faces)
export const SHAPE_CACHE_VERSION = 6;
const DB_NAME = "cubane-shape-cache";
// 2: each shape record carries its bytes, indexed (usage reads the index, not every shape's arrays); the shapes kept
// at 1 are dropped once, and made again
const DB_VERSION = 2;
const SHAPES = "shapes";
const SETS = "sets";
const MAX_PACK_SETS = 8;
/** Shapes saved per transaction: each is cloned on the main thread, so a palette's are saved a batch at a time. */
const PUT_BATCH = 200;

export interface CachedGeometry {
	attributes: Record<string, { array: Float32Array; itemSize: number }>;
	index: Uint16Array | Uint32Array | null;
	spec: FaceMaterialSpec;
	/** the material as it was drawn (materialFingerprint): one made again from `spec` must match it */
	fingerprint: string;
}

export interface CachedShape {
	/** a block with connected textures (meshed per position, no palette geometry) */
	connects: boolean;
	category: string;
	occlusionFlags: number;
	/** who its full sides hide (workers/faceCulling.ts) */
	cullKey: string;
	geometries: CachedGeometry[];
}

interface SetRecord {
	set: string;
	used: number;
	/** the textures' alpha classes (AssetLoader.readAlphaClass: reading a texture's pixels is slow) */
	alpha: Record<string, TextureAlphaClass>;
}

interface ShapeRecord {
	key: string;
	set: string;
	shape: CachedShape;
	/** the bytes of its geometry's arrays (indexed: usage sums them without reading the shapes) */
	bytes: number;
}

/** The bytes of a shape's geometry arrays. */
function shapeBytes(shape: CachedShape): number {
	let bytes = 0;
	for (const g of shape.geometries) {
		for (const a of Object.values(g.attributes)) bytes += a.array.byteLength;
		bytes += g.index?.byteLength ?? 0;
	}
	return bytes;
}

// the shape database, opened on first use (utils/idb.ts): none (a private window, blocked site data) or one another tab
// blocks means the shapes are made this time, and the next build tries again
const openDb = keptDatabase(DB_NAME, DB_VERSION, {
	upgrade: (db, _request, oldVersion) => {
		// version 1's records have no bytes: they go, and are made again
		if (oldVersion < 2) {
			for (const store of [SHAPES, SETS])
				if (db.objectStoreNames.contains(store)) db.deleteObjectStore(store);
		}
		if (!db.objectStoreNames.contains(SHAPES)) {
			const shapes = db.createObjectStore(SHAPES, { keyPath: "key" });
			shapes.createIndex("set", "set");
			shapes.createIndex("bytes", "bytes");
		}
		if (!db.objectStoreNames.contains(SETS)) db.createObjectStore(SETS, { keyPath: "set" });
	},
});

const done = transactionDone;

/** A material as drawn, in values that are the same in every session (no texture or material ids). */
export function materialFingerprint(m: THREE.Material): string {
	const u = m.userData ?? {};
	// a lit or basic material's colours (none on others)
	const lit = m as Partial<THREE.MeshStandardMaterial>;
	return JSON.stringify([
		m.type,
		lit.color?.toArray(),
		lit.emissive?.toArray(),
		m.transparent,
		m.opacity,
		m.alphaTest,
		m.depthWrite,
		m.side,
		lit.wireframe ?? false,
		u.useAtlas ?? null,
		u.texturePath ?? null,
		u.alphaClass ?? null,
		u.isWater ?? null,
		u.isLava ?? null,
		u.isLiquid ?? null,
		u.faceDirection ?? null,
		lit.map ? (u.useAtlas ? "atlas" : "own") : null,
		// where its texture sits in the atlas: a kept shape's UVs point there, so a material made again from an
		// atlas laid out differently (a new atlas format, other packing) does not match, and the block is made again
		u.useAtlas && u.atlasUV
			? [u.atlasUV.u, u.atlasUV.v, u.atlasUV.width, u.atlasUV.height].map(
					(n: number) => Math.round(n * 1e7) / 1e7
				)
			: null,
	]);
}

/** The shapes of one pack set (`set`: a key of the packs and the mesh options). */
export class ShapeCache {
	private constructor(
		private db: IDBDatabase,
		private set: string
	) {}

	/** The cache of `set`, or null where there is no IndexedDB. */
	static async open(set: string): Promise<ShapeCache | null> {
		const db = await openDb();
		return db ? new ShapeCache(db, `v${SHAPE_CACHE_VERSION}|${set}`) : null;
	}

	private keyOf(blockString: string) {
		return `${this.set}|${blockString}`;
	}

	/** The set's record, marked used now (the last to go when there are too many), with `alpha` merged into it. */
	private touchSet(
		tx: IDBTransaction,
		alpha?: Record<string, TextureAlphaClass>
	): Promise<SetRecord> {
		const sets = tx.objectStore(SETS);
		return new Promise((resolve, reject) => {
			const req = sets.get(this.set);
			req.onsuccess = () => {
				const rec: SetRecord = req.result ?? { set: this.set, used: 0, alpha: {} };
				rec.used = Date.now();
				if (alpha) rec.alpha = { ...rec.alpha, ...alpha };
				sets.put(rec);
				resolve(rec);
			};
			req.onerror = () => reject(req.error);
		});
	}

	/** The kept shapes of these block states (those it has), and the textures' alpha classes. One transaction. */
	async getMany(
		blockStrings: string[]
	): Promise<{ shapes: Map<string, CachedShape>; alpha: Record<string, TextureAlphaClass> }> {
		const shapes = new Map<string, CachedShape>();
		const tx = this.db.transaction([SHAPES, SETS], "readwrite");
		const store = tx.objectStore(SHAPES);
		for (const s of blockStrings) {
			const req = store.get(this.keyOf(s));
			req.onsuccess = () => {
				const rec = req.result as ShapeRecord | undefined;
				if (rec) shapes.set(s, rec.shape);
			};
		}
		const set = this.touchSet(tx);
		await done(tx);
		return { shapes, alpha: (await set).alpha ?? {} };
	}

	/** Keeps these shapes and alpha classes, then lets go of the oldest pack sets beyond MAX_PACK_SETS. */
	async putMany(
		shapes: Map<string, CachedShape>,
		alpha?: Record<string, TextureAlphaClass>
	): Promise<void> {
		if (shapes.size === 0 && !alpha) return;
		// a batch a transaction, the page let run between them: one transaction for a palette's shapes cloned all
		// their arrays in one go on the main thread
		const entries = [...shapes];
		for (let start = 0; start < entries.length || start === 0; start += PUT_BATCH) {
			if (start > 0) await idle();
			const last = start + PUT_BATCH >= entries.length;
			const tx = this.db.transaction([SHAPES, SETS], "readwrite");
			const store = tx.objectStore(SHAPES);
			for (const [s, shape] of entries.slice(start, start + PUT_BATCH))
				store.put({
					key: this.keyOf(s),
					set: this.set,
					shape,
					bytes: shapeBytes(shape),
				} as ShapeRecord);
			// with the last batch: a failure fails the transaction, which putMany reports (done), not a rejection
			// left unhandled
			if (last) this.touchSet(tx, alpha).catch(() => {});
			await done(tx);
			if (last) break;
		}
		await this.evict();
	}

	private async evict(): Promise<void> {
		const tx = this.db.transaction([SHAPES, SETS], "readwrite");
		const sets = tx.objectStore(SETS);
		const all = await new Promise<SetRecord[]>((resolve, reject) => {
			const req = sets.getAll();
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		const old = all.sort((a, b) => b.used - a.used).slice(MAX_PACK_SETS);
		const shapes = tx.objectStore(SHAPES).index("set");
		for (const { set } of old) {
			sets.delete(set);
			const req = shapes.openKeyCursor(IDBKeyRange.only(set));
			req.onsuccess = () => {
				const cursor = req.result;
				if (!cursor) return;
				tx.objectStore(SHAPES).delete(cursor.primaryKey);
				cursor.continue();
			};
		}
		await done(tx);
	}

	/**
	 * How many pack sets and shapes are kept, and their bytes (the geometry's arrays), from the bytes index: no
	 * shape is read (each holds its arrays, and reading them all was most of what usage cost).
	 */
	static async usage(): Promise<{ sets: number; count: number; bytes: number }> {
		const db = await openDb();
		if (!db) return { sets: 0, count: 0, bytes: 0 };
		const tx = db.transaction([SHAPES, SETS], "readonly");
		const count = (store: string) =>
			new Promise<number>((resolve) => {
				const req = tx.objectStore(store).count();
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => resolve(0);
			});
		const bytes = new Promise<number>((resolve) => {
			let sum = 0;
			const req = tx.objectStore(SHAPES).index("bytes").openKeyCursor();
			req.onsuccess = () => {
				const cursor = req.result;
				if (!cursor) return resolve(sum);
				sum += cursor.key as number;
				cursor.continue();
			};
			req.onerror = () => resolve(sum);
		});
		const [sets, shapes, total] = await Promise.all([count(SETS), count(SHAPES), bytes]);
		return { sets, count: shapes, bytes: total };
	}

	/** Every kept shape goes (all pack sets). */
	static async clear(): Promise<void> {
		const db = await openDb();
		if (!db) return;
		const tx = db.transaction([SHAPES, SETS], "readwrite");
		tx.objectStore(SHAPES).clear();
		tx.objectStore(SETS).clear();
		await done(tx);
	}
}
