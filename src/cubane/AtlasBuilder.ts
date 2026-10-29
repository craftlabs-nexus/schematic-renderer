import { keptDatabase } from "../utils/idb";
import { TextureInfo, PackedTexture, AtlasNode } from "./types";

// IndexedDB-based atlas cache for better performance
const ATLAS_CACHE_DB_NAME = "cubane-atlas-cache";
const ATLAS_CACHE_STORE_NAME = "atlases";
// 2: indexes by time (the oldest go past MAX_CACHED_ATLASES) and by size (counted without reading the pixels)
const ATLAS_CACHE_VERSION = 2;
/** Atlases kept (one per pack set, the newest): each is its raw pixels, 16 to 256 MB. */
const MAX_CACHED_ATLASES = 4;

// the atlas database, opened on first use (utils/idb.ts); one another tab blocks is skipped this time
const atlasCacheDb = keptDatabase(ATLAS_CACHE_DB_NAME, ATLAS_CACHE_VERSION, {
	upgrade: (db, request) => {
		const store = db.objectStoreNames.contains(ATLAS_CACHE_STORE_NAME)
			? request.transaction!.objectStore(ATLAS_CACHE_STORE_NAME)
			: db.createObjectStore(ATLAS_CACHE_STORE_NAME, { keyPath: "cacheKey" });
		if (!store.indexNames.contains("timestamp")) store.createIndex("timestamp", "timestamp");
		if (!store.indexNames.contains("size")) store.createIndex("size", ["width", "height"]);
	},
});

/** The atlas database; throws when there is none (every caller does without it then). */
async function openAtlasCacheDb(): Promise<IDBDatabase> {
	const db = await atlasCacheDb();
	if (!db) throw new Error("no atlas cache (IndexedDB unavailable, or blocked by another tab)");
	return db;
}

export interface AtlasCacheData {
	cacheKey: string;
	// Store raw ImageData instead of base64 PNG for speed
	imageData: Uint8ClampedArray;
	width: number;
	height: number;
	uvMap: Record<string, { u: number; v: number; width: number; height: number }>;
	packingEfficiency: number;
	timestamp: number;
	textureCount: number;
}

export class AtlasBuilder {
	/** The sizes tried in order when the atlas is sized automatically. */
	public static readonly SIZES = [2048, 4096, 8192];

	private atlasSize: number;
	private readonly autoSize: boolean;
	private readonly maxAtlasSize: number;
	private padding: number;

	/**
	 * @param atlasSize a fixed size in pixels, or "auto" (the default): the smallest of
	 *   2048, 4096 and 8192, up to `maxAtlasSize`, that holds every texture. A texture
	 *   that fits none is an error (buildAtlas rejects), never a silent drop.
	 * @param padding pixels between textures
	 * @param maxAtlasSize the largest size "auto" may pick; WebGL guarantees 2048 and
	 *   desktop GPUs 8192 or more (check MAX_TEXTURE_SIZE for less)
	 */
	constructor(
		atlasSize: number | "auto" = "auto",
		padding: number = 1,
		maxAtlasSize: number = 8192
	) {
		this.autoSize = atlasSize === "auto";
		this.atlasSize = atlasSize === "auto" ? AtlasBuilder.SIZES[0] : atlasSize;
		this.maxAtlasSize = maxAtlasSize;
		this.padding = padding;
	}

	/**
	 * Pack every texture, trying the sizes allowed from the smallest up and, at each,
	 * the five sort strategies; the first size that holds them all wins, with its most
	 * efficient strategy. Leaves `atlasSize` at the chosen size.
	 */
	private packAll(textureInfos: TextureInfo[]): {
		size: number;
		strategy: string;
		packedTextures: PackedTexture[];
		efficiency: number;
	} {
		const sortedTextures = this.sortTexturesForPacking(textureInfos);
		const strategies = Object.keys(sortedTextures);
		const sizes = this.autoSize
			? AtlasBuilder.SIZES.filter((s) => s <= this.maxAtlasSize)
			: [this.atlasSize];
		if (sizes.length === 0) sizes.push(Math.min(AtlasBuilder.SIZES[0], this.maxAtlasSize));

		let fullest: { packedTextures: PackedTexture[] } | null = null;
		for (const size of sizes) {
			this.atlasSize = size;
			const results = strategies.map((strategy) => {
				const packedTextures = this.packTextures(sortedTextures[strategy]);
				return {
					strategy,
					packedTextures,
					efficiency: this.calculatePackingEfficiency(packedTextures),
				};
			});
			const complete = results.filter((r) => r.packedTextures.length === textureInfos.length);
			if (complete.length > 0) {
				const best = complete.reduce((a, b) => (b.efficiency > a.efficiency ? b : a));
				return { size, ...best };
			}
			fullest = results.reduce((a, b) =>
				b.packedTextures.length > a.packedTextures.length ? b : a
			);
		}

		const packed = new Set(fullest!.packedTextures.map((t) => t.path));
		const missing = textureInfos.filter((t) => !packed.has(t.path));
		const examples = missing
			.slice(0, 5)
			.map((t) => `${t.path} (${t.width}x${t.height})`)
			.join(", ");
		throw new Error(
			`Texture atlas: ${missing.length} of ${textureInfos.length} textures do not fit a ` +
				`${this.atlasSize}x${this.atlasSize} atlas, the largest allowed (e.g. ${examples}). ` +
				`Load fewer resource packs or allow a larger atlas.`
		);
	}

	/**
	 * Build texture atlas with caching support
	 */
	public async buildAtlas(
		textures: { path: string; image: HTMLImageElement | ImageBitmap | HTMLCanvasElement }[],
		cacheKey?: string
	): Promise<{
		atlas: HTMLCanvasElement;
		uvMap: Map<string, { u: number; v: number; width: number; height: number }>;
		packingEfficiency: number;
		fromCache: boolean;
	}> {
		console.log(`🔧 Starting atlas building with ${textures.length} textures`);

		// Try to load from cache first if cache key provided
		if (cacheKey) {
			const cachedResult = await this.loadFromCache(cacheKey, textures.length);
			if (cachedResult) {
				console.log(`✅ Loaded atlas from cache`);
				return { ...cachedResult, fromCache: true };
			}
		}

		if (textures.length === 0) {
			throw new Error("buildAtlas: no textures to pack (loadCachedAtlas looks in the cache alone)");
		}

		// Build new atlas
		const result = await this.buildNewAtlas(textures);

		// Save to cache if cache key provided (don't await - do it in background)
		if (cacheKey) {
			this.saveToCache(cacheKey, result, textures.length)
				.then(() => {
					console.log(`💾 Saved atlas to cache`);
				})
				.catch((err) => {
					console.warn(`⚠️ Failed to save atlas to cache:`, err);
				});
		}

		return { ...result, fromCache: false };
	}

	/**
	 * The atlas cached under `cacheKey`, or null when there is none (or no IndexedDB). A miss is an answer, not an
	 * error: it was asked as buildAtlas([], key), which threw "No cache found", and the caller took any failure for
	 * a miss.
	 */
	public loadCachedAtlas(cacheKey: string): Promise<{
		atlas: HTMLCanvasElement;
		uvMap: Map<string, { u: number; v: number; width: number; height: number }>;
		packingEfficiency: number;
	} | null> {
		return this.loadFromCache(cacheKey, 0);
	}

	/**
	 * Try to load atlas from IndexedDB cache (fast path)
	 */
	private async loadFromCache(
		cacheKey: string,
		expectedTextureCount: number
	): Promise<{
		atlas: HTMLCanvasElement;
		uvMap: Map<string, { u: number; v: number; width: number; height: number }>;
		packingEfficiency: number;
	} | null> {
		const startTime = performance.now();

		try {
			// Try IndexedDB first (fast path)
			const db = await openAtlasCacheDb();
			const cacheData = await new Promise<AtlasCacheData | null>((resolve) => {
				const transaction = db.transaction(ATLAS_CACHE_STORE_NAME, "readonly");
				const store = transaction.objectStore(ATLAS_CACHE_STORE_NAME);
				const request = store.get(cacheKey);

				request.onsuccess = () => resolve(request.result || null);
				request.onerror = () => resolve(null);
			});

			if (cacheData) {
				// Validate cache
				if (expectedTextureCount > 0 && cacheData.textureCount !== expectedTextureCount) {
					console.log(
						`⚠️ Cache texture count mismatch: expected ${expectedTextureCount}, got ${cacheData.textureCount}`
					);
					return null;
				}

				// Check if cache is too old (1 week)
				const maxAge = 7 * 24 * 60 * 60 * 1000;
				if (Date.now() - cacheData.timestamp > maxAge) {
					console.log(`⚠️ Cache expired`);
					await AtlasBuilder.deleteCachedAtlas(cacheKey);
					return null;
				}

				// Fast reconstruction from raw ImageData
				const canvas = document.createElement("canvas");
				canvas.width = cacheData.width;
				canvas.height = cacheData.height;
				const ctx = canvas.getContext("2d")!;

				// the record is a fresh copy (IndexedDB clones it out): its pixels are used as they are, not copied again
				const imageData = new ImageData(
					cacheData.imageData as Uint8ClampedArray<ArrayBuffer>,
					cacheData.width,
					cacheData.height
				);
				ctx.putImageData(imageData, 0, 0);

				// Reconstruct UV map
				const uvMap = new Map<string, { u: number; v: number; width: number; height: number }>();
				Object.entries(cacheData.uvMap).forEach(([path, uv]) => {
					uvMap.set(path, uv);
				});

				const loadTime = performance.now() - startTime;
				console.log(
					`📊 IndexedDB cache hit: ${uvMap.size} textures, ${cacheData.packingEfficiency.toFixed(1)}% efficiency (${loadTime.toFixed(0)}ms)`
				);

				return {
					atlas: canvas,
					uvMap,
					packingEfficiency: cacheData.packingEfficiency,
				};
			}

			return null;
		} catch (error) {
			console.warn(`⚠️ Failed to load from cache:`, error);
			return null;
		}
	}

	/**
	 * Save atlas to IndexedDB cache (fast)
	 */
	private async saveToCache(
		cacheKey: string,
		result: {
			atlas: HTMLCanvasElement;
			uvMap: Map<string, { u: number; v: number; width: number; height: number }>;
			packingEfficiency: number;
		},
		textureCount: number
	): Promise<void> {
		try {
			const ctx = result.atlas.getContext("2d")!;
			const imageData = ctx.getImageData(0, 0, result.atlas.width, result.atlas.height);

			// Convert map to plain object
			const uvMapObject: Record<string, { u: number; v: number; width: number; height: number }> =
				{};
			result.uvMap.forEach((value, key) => {
				uvMapObject[key] = value;
			});

			const cacheData: AtlasCacheData = {
				cacheKey,
				imageData: imageData.data,
				width: result.atlas.width,
				height: result.atlas.height,
				uvMap: uvMapObject,
				packingEfficiency: result.packingEfficiency,
				timestamp: Date.now(),
				textureCount,
			};

			const db = await openAtlasCacheDb();
			await new Promise<void>((resolve, reject) => {
				const transaction = db.transaction(ATLAS_CACHE_STORE_NAME, "readwrite");
				const store = transaction.objectStore(ATLAS_CACHE_STORE_NAME);
				const request = store.put(cacheData);
				request.onerror = () => reject(request.error);
				// the oldest past MAX_CACHED_ATLASES go (by the time index: no pixels read)
				request.onsuccess = () => {
					const keys = store.index("timestamp").getAllKeys();
					keys.onsuccess = () => {
						const old = keys.result.slice(0, Math.max(0, keys.result.length - MAX_CACHED_ATLASES));
						for (const key of old) store.delete(key);
					};
				};
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error);
			});

			const sizeEstimate = imageData.data.length + JSON.stringify(uvMapObject).length;
			console.log(`💾 Cached atlas to IndexedDB: ~${(sizeEstimate / 1024 / 1024).toFixed(1)}MB`);
		} catch (error) {
			console.warn(`⚠️ Failed to save to IndexedDB cache:`, error);
		}
	}

	/** How many atlases are cached and their bytes (from the size index: no pixels read). */
	public static async cacheUsage(): Promise<{ count: number; bytes: number }> {
		try {
			const db = await openAtlasCacheDb();
			return await new Promise((resolve) => {
				const request = db
					.transaction(ATLAS_CACHE_STORE_NAME)
					.objectStore(ATLAS_CACHE_STORE_NAME)
					.index("size")
					.openKeyCursor();
				let count = 0,
					bytes = 0;
				request.onsuccess = () => {
					const cursor = request.result;
					if (!cursor) return resolve({ count, bytes });
					const [w, h] = cursor.key as [number, number];
					count++;
					bytes += w * h * 4;
					cursor.continue();
				};
				request.onerror = () => resolve({ count, bytes });
			});
		} catch {
			return { count: 0, bytes: 0 };
		}
	}

	/** Deletes one cached atlas from IndexedDB (a missing entry or no IndexedDB is not an error). */
	public static async deleteCachedAtlas(cacheKey: string): Promise<void> {
		try {
			const db = await openAtlasCacheDb();
			await new Promise<void>((resolve) => {
				const transaction = db.transaction(ATLAS_CACHE_STORE_NAME, "readwrite");
				const store = transaction.objectStore(ATLAS_CACHE_STORE_NAME);
				store.delete(cacheKey);
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => resolve();
			});
		} catch {
			// Ignore errors
		}
	}

	/**
	 * Build a new atlas (original logic)
	 * Supports both HTMLImageElement and ImageBitmap for flexibility
	 */
	private async buildNewAtlas(
		textures: { path: string; image: HTMLImageElement | ImageBitmap | HTMLCanvasElement }[]
	): Promise<{
		atlas: HTMLCanvasElement;
		uvMap: Map<string, { u: number; v: number; width: number; height: number }>;
		packingEfficiency: number;
	}> {
		// Prepare texture info with dimensions
		const textureInfos: TextureInfo[] = textures.map(({ path, image }) => ({
			path,
			image: image as HTMLImageElement, // Cast for compatibility with existing types
			width: image.width,
			height: image.height,
			area: image.width * image.height,
		}));

		// The smallest size that holds every texture, with its best strategy (throws when none does)
		const bestResult = this.packAll(textureInfos);

		console.log(
			`📊 Best packing strategy: ${bestResult.strategy} with ${bestResult.efficiency.toFixed(1)}% efficiency in a ${bestResult.size}x${bestResult.size} atlas`
		);
		console.log(`📦 Packed ${bestResult.packedTextures.length}/${textures.length} textures`);

		// Create the final atlas
		const { canvas, uvMap } = this.createAtlasCanvas(bestResult.packedTextures);

		return {
			atlas: canvas,
			uvMap,
			packingEfficiency: bestResult.efficiency,
		};
	}

	/** Clears the atlas cache (and any atlas an upstream version kept in localStorage, which nothing reads now). */
	public static async clearAllCaches(): Promise<void> {
		try {
			const db = await openAtlasCacheDb();
			await new Promise<void>((resolve) => {
				const transaction = db.transaction(ATLAS_CACHE_STORE_NAME, "readwrite");
				transaction.objectStore(ATLAS_CACHE_STORE_NAME).clear();
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => resolve();
			});
			console.log("🗑️ Cleared IndexedDB atlas cache");
		} catch (error) {
			console.warn("⚠️ Failed to clear IndexedDB cache:", error);
		}
		try {
			for (const key of Object.keys(localStorage))
				if (key.startsWith("atlas_")) localStorage.removeItem(key);
		} catch {
			// no localStorage here (a worker, blocked site data)
		}
	}

	/**
	 * The cached atlases, for debugging: their keys, sizes, ages and texture counts. Read one record at a time (a
	 * cursor): each holds its atlas's pixels, 16 to 256 MB, and getAll() read every one into memory at once.
	 */
	public static async getCacheInfo(): Promise<
		{ key: string; size: string; age: string; textureCount: number; storage: string }[]
	> {
		const results: {
			key: string;
			size: string;
			age: string;
			textureCount: number;
			storage: string;
		}[] = [];
		try {
			const db = await openAtlasCacheDb();
			await new Promise<void>((resolve) => {
				const request = db
					.transaction(ATLAS_CACHE_STORE_NAME, "readonly")
					.objectStore(ATLAS_CACHE_STORE_NAME)
					.openCursor();
				request.onsuccess = () => {
					const cursor = request.result;
					if (!cursor) return resolve();
					const entry = cursor.value as AtlasCacheData;
					const size = entry.width * entry.height * 4;
					const age = Math.round((Date.now() - entry.timestamp) / (1000 * 60 * 60));
					results.push({
						key: entry.cacheKey,
						size: `${(size / 1024 / 1024).toFixed(1)}MB`,
						age: `${age}h`,
						textureCount: entry.textureCount,
						storage: "IndexedDB",
					});
					cursor.continue();
				};
				request.onerror = () => resolve();
			});
		} catch {
			// no IndexedDB: nothing cached
		}
		return results;
	}

	private sortTexturesForPacking(textures: TextureInfo[]): Record<string, TextureInfo[]> {
		return {
			"largest-first": [...textures].sort((a, b) => {
				const aMax = Math.max(a.width, a.height);
				const bMax = Math.max(b.width, b.height);
				if (bMax !== aMax) return bMax - aMax;
				return b.area - a.area;
			}),
			"area-first": [...textures].sort((a, b) => b.area - a.area),
			"height-first": [...textures].sort((a, b) => {
				if (b.height !== a.height) return b.height - a.height;
				return b.width - a.width;
			}),
			"width-first": [...textures].sort((a, b) => {
				if (b.width !== a.width) return b.width - a.width;
				return b.height - a.height;
			}),
			"perimeter-first": [...textures].sort((a, b) => b.width + b.height - (a.width + a.height)),
		};
	}

	private packTextures(textures: TextureInfo[]): PackedTexture[] {
		const root: AtlasNode = {
			x: 0,
			y: 0,
			width: this.atlasSize,
			height: this.atlasSize,
			used: false,
		};

		const packedTextures: PackedTexture[] = [];

		for (const texture of textures) {
			const node = this.findNode(root, texture.width + this.padding, texture.height + this.padding);

			if (node) {
				const fit = this.splitNode(
					node,
					texture.width + this.padding,
					texture.height + this.padding
				);
				packedTextures.push({
					...texture,
					x: fit.x,
					y: fit.y,
				});
			}
			// a texture that does not fit is left out here; packAll tries the next size or throws
		}

		return packedTextures;
	}

	private findNode(root: AtlasNode, width: number, height: number): AtlasNode | null {
		if (root.used) {
			return this.findNode(root.right!, width, height) || this.findNode(root.down!, width, height);
		} else if (width <= root.width && height <= root.height) {
			return root;
		} else {
			return null;
		}
	}

	private splitNode(node: AtlasNode, width: number, height: number): AtlasNode {
		node.used = true;

		node.down = {
			x: node.x,
			y: node.y + height,
			width: node.width,
			height: node.height - height,
			used: false,
		};

		node.right = {
			x: node.x + width,
			y: node.y,
			width: node.width - width,
			height: height,
			used: false,
		};

		return node;
	}

	private calculatePackingEfficiency(packedTextures: PackedTexture[]): number {
		const totalTextureArea = packedTextures.reduce((sum, tex) => sum + tex.area, 0);
		const atlasArea = this.atlasSize * this.atlasSize;
		return (totalTextureArea / atlasArea) * 100;
	}

	private createAtlasCanvas(packedTextures: PackedTexture[]): {
		canvas: HTMLCanvasElement;
		uvMap: Map<string, { u: number; v: number; width: number; height: number }>;
	} {
		const canvas = document.createElement("canvas");
		canvas.width = this.atlasSize;
		canvas.height = this.atlasSize;

		const ctx = canvas.getContext("2d")!;
		ctx.imageSmoothingEnabled = false;
		ctx.clearRect(0, 0, this.atlasSize, this.atlasSize);

		const uvMap = new Map<string, { u: number; v: number; width: number; height: number }>();

		for (const texture of packedTextures) {
			ctx.drawImage(texture.image, texture.x, texture.y);

			const u = texture.x / this.atlasSize;
			const v = texture.y / this.atlasSize;
			const width = texture.width / this.atlasSize;
			const height = texture.height / this.atlasSize;

			uvMap.set(texture.path, { u, v, width, height });
		}

		return { canvas, uvMap };
	}

	public visualizePacking(packedTextures: PackedTexture[]): HTMLCanvasElement {
		const canvas = document.createElement("canvas");
		canvas.width = this.atlasSize;
		canvas.height = this.atlasSize;

		const ctx = canvas.getContext("2d")!;
		ctx.fillStyle = "rgba(200, 200, 200, 0.3)";
		ctx.fillRect(0, 0, this.atlasSize, this.atlasSize);

		packedTextures.forEach((texture, index) => {
			const hue = (index * 137.508) % 360;
			ctx.strokeStyle = `hsl(${hue}, 70%, 50%)`;
			ctx.lineWidth = 1;
			ctx.strokeRect(texture.x, texture.y, texture.width, texture.height);

			if (texture.width > 50 && texture.height > 20) {
				ctx.fillStyle = `hsl(${hue}, 70%, 30%)`;
				ctx.font = "10px monospace";
				ctx.fillText(texture.path.split("/").pop() || texture.path, texture.x + 2, texture.y + 12);
			}
		});

		return canvas;
	}
}
