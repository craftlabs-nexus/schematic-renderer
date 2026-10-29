import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { Blob as NodeBlob } from "node:buffer";

// The atlas cache's store (AtlasBuilder) on an in-memory IndexedDB, a fresh one per test, with the browser's PNG
// encoder and decoder stood in for: an atlas is kept as a PNG once the page is idle (its raw pixels were read back on
// the main thread, up to 256 MB, as the renderer became usable), read back from it, the newest 4 kept, and the
// raw-pixel records of the earlier versions dropped.

let AtlasBuilder: typeof import("../AtlasBuilder").AtlasBuilder;
const encoded: Blob[] = [];
const decoded: Array<{ image: Blob; options: unknown }> = [];

beforeEach(async () => {
	vi.stubGlobal("indexedDB", new IDBFactory());
	vi.stubGlobal("IDBKeyRange", IDBKeyRange);
	// a Blob IndexedDB can keep, as a browser's: the test DOM's does not survive the copy it makes
	vi.stubGlobal("Blob", NodeBlob);
	vi.spyOn(console, "log").mockImplementation(() => {});
	const context = { imageSmoothingEnabled: true, clearRect: vi.fn(), drawImage: vi.fn() };
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
	// a PNG of a few bytes for each atlas encoded
	vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
		this: HTMLCanvasElement,
		done
	) {
		const blob = new Blob([new Uint8Array(100 + this.width / 64)], { type: "image/png" });
		encoded.push(blob);
		done(blob);
	});
	vi.stubGlobal("createImageBitmap", async (image: Blob, options: unknown) => {
		decoded.push({ image, options });
		return { close() {} };
	});
	encoded.length = 0;
	decoded.length = 0;
	vi.resetModules(); // the module keeps its connection
	({ AtlasBuilder } = await import("../AtlasBuilder"));
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const textures = (count: number) =>
	Array.from({ length: count }, (_, i) => ({
		path: `block/t${i}`,
		image: { width: 16, height: 16 } as unknown as ImageBitmap,
	}));

/** Builds an atlas under `key` and waits for its save (not awaited by buildAtlas: done once the page is idle). */
async function buildAndKeep(key: string, count = 3) {
	const before = (await AtlasBuilder.cacheUsage()).count;
	await new AtlasBuilder().buildAtlas(textures(count), key);
	await vi.waitFor(async () => {
		const { count: now } = await AtlasBuilder.cacheUsage();
		if (now === before) throw new Error("not saved yet");
	});
}

describe("the atlas cache's store", () => {
	it("keeps an atlas as a PNG, and reads it back from it", async () => {
		await buildAndKeep("packs-a");
		expect(encoded).toHaveLength(1);
		const cached = await new AtlasBuilder().loadCachedAtlas("packs-a");
		expect(cached).not.toBeNull();
		expect([...cached!.uvMap.keys()]).toEqual(["block/t0", "block/t1", "block/t2"]);
		expect(cached!.atlas.width).toBe(2048);
		// decoded as written: no colour management, the alpha as stored
		expect(decoded).toHaveLength(1);
		expect(decoded[0].image.size).toBe(encoded[0].size);
		expect(decoded[0].options).toEqual({ premultiplyAlpha: "none", colorSpaceConversion: "none" });
	});

	it("says a miss is none, not an error", async () => {
		expect(await new AtlasBuilder().loadCachedAtlas("never-built")).toBeNull();
	});

	it("counts its atlases by their PNGs' sizes, and keeps the newest 4", async () => {
		for (let i = 0; i < 4; i++) await buildAndKeep(`packs-${i}`);
		expect(await AtlasBuilder.cacheUsage()).toEqual({
			count: 4,
			bytes: encoded.reduce((n, b) => n + b.size, 0),
		});
		// a fifth: the oldest goes
		let now = Date.now() + 1000;
		vi.spyOn(Date, "now").mockImplementation(() => now++);
		await new AtlasBuilder().buildAtlas(textures(3), "packs-4");
		await vi.waitFor(async () => {
			if (!(await new AtlasBuilder().loadCachedAtlas("packs-4"))) throw new Error("not saved yet");
		});
		expect((await AtlasBuilder.cacheUsage()).count).toBe(4);
		expect(await new AtlasBuilder().loadCachedAtlas("packs-0")).toBeNull();
	});

	it("drops the raw-pixel atlases an earlier version kept when it opens", async () => {
		// a database as version 2 left it: an atlas as its raw pixels
		await new Promise<void>((resolve) => {
			const req = indexedDB.open("cubane-atlas-cache", 2);
			req.onupgradeneeded = () => {
				const store = req.result.createObjectStore("atlases", { keyPath: "cacheKey" });
				store.createIndex("timestamp", "timestamp");
				store.createIndex("size", ["width", "height"]);
				store.put({
					cacheKey: "old",
					imageData: new Uint8ClampedArray(16),
					width: 2,
					height: 2,
					uvMap: {},
					packingEfficiency: 1,
					timestamp: Date.now(),
					textureCount: 1,
				});
			};
			req.onsuccess = () => {
				req.result.close();
				resolve();
			};
		});
		expect(await AtlasBuilder.cacheUsage()).toEqual({ count: 0, bytes: 0 });
		expect(await new AtlasBuilder().loadCachedAtlas("old")).toBeNull();
	});
});
