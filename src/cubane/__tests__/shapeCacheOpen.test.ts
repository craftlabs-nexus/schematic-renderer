import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The shape cache's database connection (ShapeCache.open), against a stand-in for indexedDB.open whose requests the
// test answers. A connection held for the page's life kept another tab's newer version, or clearAssetCaches'
// deleteDatabase, waiting; and an open blocked once left the cache off for good.
type Request = {
	result?: any;
	onsuccess?: () => void;
	onerror?: () => void;
	onblocked?: () => void;
	onupgradeneeded?: () => void;
};
let requests: Request[];

beforeEach(() => {
	vi.resetModules(); // the module keeps its connection: a fresh one per test
	requests = [];
	vi.stubGlobal("indexedDB", {
		open: () => {
			const request: Request = {};
			requests.push(request);
			return request;
		},
	});
});
afterEach(() => vi.unstubAllGlobals());

const database = () => ({ close: vi.fn(), onversionchange: null as null | (() => void) });

describe("the shape cache's database", () => {
	it("is tried again after an open another tab blocked", async () => {
		const { ShapeCache } = await import("../ShapeCache");
		const first = ShapeCache.open("set");
		requests[0].onblocked!();
		expect(await first).toBeNull(); // made without the cache this time
		// the other tab lets go: the connection opened late is not kept for nothing
		const late = database();
		requests[0].result = late;
		requests[0].onsuccess!();
		expect(late.close).toHaveBeenCalled();
		// the next build opens it again
		const second = ShapeCache.open("set");
		expect(requests).toHaveLength(2);
		requests[1].result = database();
		requests[1].onsuccess!();
		expect(await second).not.toBeNull();
	});

	it("closes its connection for a newer version or a delete, and opens it again when next used", async () => {
		const { ShapeCache } = await import("../ShapeCache");
		const opening = ShapeCache.open("set");
		const db = database();
		requests[0].result = db;
		requests[0].onsuccess!();
		await opening;
		db.onversionchange!();
		expect(db.close).toHaveBeenCalled();
		ShapeCache.open("set");
		expect(requests).toHaveLength(2);
	});
});
