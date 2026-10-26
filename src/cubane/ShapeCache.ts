// The palette's block shapes kept between visits (IndexedDB), so a palette is not built again from the pack's models
// each time: per block state, the geometry WorldMeshBuilder.buildPaletteCache makes from Cubane's mesh, what each
// geometry's material was made from (a FaceMaterialSpec: the material is made again from the session's atlas), its
// render category and its occlusion flags. Keyed by the packs (AssetLoader's content hash), the options that change
// a block's mesh and SHAPE_CACHE_VERSION; the shapes of the last MAX_PACK_SETS pack sets are kept.

import type { FaceMaterialSpec } from "./BlockMeshBuilder";

/** Raise when what the mesh code makes of a block changes: every shape kept before is then made again. */
export const SHAPE_CACHE_VERSION = 1;
const DB_NAME = "cubane-shape-cache";
const DB_VERSION = 1;
const SHAPES = "shapes";
const SETS = "sets";
const MAX_PACK_SETS = 8;

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
	geometries: CachedGeometry[];
}

interface SetRecord {
	set: string;
	used: number;
	/** the textures' alpha classes (AssetLoader.readAlphaClass: reading a texture's pixels is slow) */
	alpha: Record<string, string>;
}

interface ShapeRecord {
	key: string;
	set: string;
	shape: CachedShape;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve) => {
		if (typeof indexedDB === "undefined") return resolve(null);
		let request: IDBOpenDBRequest;
		try {
			request = indexedDB.open(DB_NAME, DB_VERSION);
		} catch {
			return resolve(null);
		}
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(SHAPES)) {
				db.createObjectStore(SHAPES, { keyPath: "key" }).createIndex("set", "set");
			}
			if (!db.objectStoreNames.contains(SETS)) db.createObjectStore(SETS, { keyPath: "set" });
		};
		request.onsuccess = () => resolve(request.result);
		// no storage (a private window, blocked site data): shapes are made every time, as before
		request.onerror = () => resolve(null);
		request.onblocked = () => resolve(null);
	});
	return dbPromise;
}

const done = (tx: IDBTransaction) =>
	new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});

/** A material as drawn, in values that are the same in every session (no texture or material ids). */
export function materialFingerprint(m: any): string {
	const u = m?.userData ?? {};
	return JSON.stringify([
		m?.type,
		m?.color?.toArray?.(),
		m?.emissive?.toArray?.(),
		m?.transparent,
		m?.opacity,
		m?.alphaTest,
		m?.depthWrite,
		m?.side,
		m?.wireframe ?? false,
		u.useAtlas ?? null,
		u.texturePath ?? null,
		u.alphaClass ?? null,
		u.isWater ?? null,
		u.isLava ?? null,
		u.isLiquid ?? null,
		u.faceDirection ?? null,
		m?.map ? (u.useAtlas ? "atlas" : "own") : null,
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
	private touchSet(tx: IDBTransaction, alpha?: Record<string, string>): Promise<SetRecord> {
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
	): Promise<{ shapes: Map<string, CachedShape>; alpha: Record<string, string> }> {
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
	async putMany(shapes: Map<string, CachedShape>, alpha?: Record<string, string>): Promise<void> {
		if (shapes.size === 0 && !alpha) return;
		const tx = this.db.transaction([SHAPES, SETS], "readwrite");
		const store = tx.objectStore(SHAPES);
		for (const [s, shape] of shapes)
			store.put({ key: this.keyOf(s), set: this.set, shape } as ShapeRecord);
		void this.touchSet(tx, alpha);
		await done(tx);
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

	/** How many pack sets and shapes are kept, and their bytes (the geometry's arrays). */
	static async usage(): Promise<{ sets: number; count: number; bytes: number }> {
		const db = await openDb();
		if (!db) return { sets: 0, count: 0, bytes: 0 };
		const tx = db.transaction([SHAPES, SETS], "readonly");
		const sets = await new Promise<number>((resolve) => {
			const req = tx.objectStore(SETS).count();
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => resolve(0);
		});
		return new Promise((resolve) => {
			let count = 0,
				bytes = 0;
			const req = tx.objectStore(SHAPES).openCursor();
			req.onsuccess = () => {
				const cursor = req.result;
				if (!cursor) return resolve({ sets, count, bytes });
				count++;
				for (const g of (cursor.value as ShapeRecord).shape.geometries) {
					for (const a of Object.values(g.attributes)) bytes += a.array.byteLength;
					bytes += g.index?.byteLength ?? 0;
				}
				cursor.continue();
			};
			req.onerror = () => resolve({ sets, count, bytes });
		});
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
