import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

// The shape cache's store (ShapeCache) on an in-memory IndexedDB, a fresh one per test: what it keeps per pack set,
// the alpha classes it merges, which sets it lets go of, its batched saves, its usage and its upgrade.

let ShapeCache: typeof import("../ShapeCache").ShapeCache;
let SHAPE_CACHE_VERSION: number;

beforeEach(async () => {
	vi.stubGlobal("indexedDB", new IDBFactory());
	vi.stubGlobal("IDBKeyRange", IDBKeyRange);
	vi.resetModules(); // the module keeps its connection
	({ ShapeCache, SHAPE_CACHE_VERSION } = await import("../ShapeCache"));
});
afterEach(() => vi.unstubAllGlobals());

/** A shape whose one geometry has `vertices` vertices and a triangle. */
function shape(vertices = 3) {
	return {
		connects: false,
		category: "solid",
		occlusionFlags: 63,
		cullKey: "solid",
		geometries: [
			{
				attributes: { position: { array: new Float32Array(vertices * 3), itemSize: 3 } },
				index: new Uint16Array([0, 1, 2]),
				spec: { texturePath: "block/stone" } as any,
				fingerprint: "f",
			},
		],
	};
}
const bytesOf = (vertices: number) => vertices * 3 * 4 + 3 * 2;

describe("the shape cache's store", () => {
	it("gives back a pack set's shapes, and none of another's", async () => {
		const a = (await ShapeCache.open("packs-a"))!;
		const b = (await ShapeCache.open("packs-b"))!;
		await a.putMany(new Map([["minecraft:stone", shape()]]));
		const fromA = await a.getMany(["minecraft:stone", "minecraft:dirt"]);
		expect([...fromA.shapes.keys()]).toEqual(["minecraft:stone"]);
		expect(fromA.shapes.get("minecraft:stone")!.geometries[0].index).toEqual(
			new Uint16Array([0, 1, 2])
		);
		expect((await b.getMany(["minecraft:stone"])).shapes.size).toBe(0);
	});

	it("keys its shapes by the cache version too, so a new version makes them again", async () => {
		const cache = (await ShapeCache.open("packs"))!;
		await cache.putMany(new Map([["minecraft:stone", shape()]]));
		const db = await new Promise<IDBDatabase>((resolve) => {
			const req = indexedDB.open("cubane-shape-cache");
			req.onsuccess = () => resolve(req.result);
		});
		const keys = await new Promise<IDBValidKey[]>((resolve) => {
			const req = db.transaction("shapes").objectStore("shapes").getAllKeys();
			req.onsuccess = () => resolve(req.result);
		});
		db.close();
		expect(keys).toEqual([`v${SHAPE_CACHE_VERSION}|packs|minecraft:stone`]);
	});

	it("merges the alpha classes each save brings, and gives them back with the shapes", async () => {
		const cache = (await ShapeCache.open("packs"))!;
		await cache.putMany(new Map(), { "atlas:block/stone": "opaque" });
		await cache.putMany(new Map([["minecraft:glass", shape()]]), { "atlas:block/glass": "cutout" });
		expect((await cache.getMany([])).alpha).toEqual({
			"atlas:block/stone": "opaque",
			"atlas:block/glass": "cutout",
		});
	});

	it("keeps the last 8 pack sets used, and lets go of the oldest with their shapes", async () => {
		let now = 1000;
		vi.spyOn(Date, "now").mockImplementation(() => now++);
		const caches = [];
		for (let i = 0; i < 9; i++) {
			const cache = (await ShapeCache.open(`packs-${i}`))!;
			caches.push(cache);
			await cache.putMany(new Map([["minecraft:stone", shape()]]));
		}
		const usage = await ShapeCache.usage();
		expect(usage.sets).toBe(8);
		expect(usage.count).toBe(8);
		// the first set, the least recently used, went (reading it marks it used again, so this comes last)
		expect((await caches[8].getMany(["minecraft:stone"])).shapes.size).toBe(1);
		expect((await caches[0].getMany(["minecraft:stone"])).shapes.size).toBe(0);
	});

	it("saves a large palette whole, a batch at a time, and counts its bytes from the index", async () => {
		const cache = (await ShapeCache.open("packs"))!;
		const many = new Map(Array.from({ length: 450 }, (_, i) => [`mod:block_${i}`, shape(4)]));
		await cache.putMany(many);
		expect((await cache.getMany([...many.keys()])).shapes.size).toBe(450);
		expect(await ShapeCache.usage()).toEqual({ sets: 1, count: 450, bytes: 450 * bytesOf(4) });
	});

	it("lets go of everything when cleared", async () => {
		const cache = (await ShapeCache.open("packs"))!;
		await cache.putMany(new Map([["minecraft:stone", shape()]]));
		await ShapeCache.clear();
		expect(await ShapeCache.usage()).toEqual({ sets: 0, count: 0, bytes: 0 });
	});

	it("drops the records of its first version, which have no bytes, when it opens", async () => {
		// a database as version 1 left it: a shape without its bytes
		await new Promise<void>((resolve) => {
			const req = indexedDB.open("cubane-shape-cache", 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				db.createObjectStore("shapes", { keyPath: "key" }).createIndex("set", "set");
				db.createObjectStore("sets", { keyPath: "set" });
				req.transaction!.objectStore("shapes").put({ key: "old", set: "old", shape: shape() });
			};
			req.onsuccess = () => {
				req.result.close();
				resolve();
			};
		});
		expect(await ShapeCache.usage()).toEqual({ sets: 0, count: 0, bytes: 0 });
	});
});
