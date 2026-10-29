import { describe, it, expect, vi, afterEach } from "vitest";
import { openDatabase, openExisting, keptDatabase } from "../idb";

// The one way the renderer opens its IndexedDB databases, against a stand-in for indexedDB whose requests the test
// answers: what a blocked open does, that a database is not made just to be read, and a kept connection's reopening.
type Request = {
	result?: any;
	transaction?: { abort: () => void };
	onsuccess?: () => void;
	onerror?: () => void;
	onblocked?: () => void;
	onupgradeneeded?: (event: { oldVersion: number }) => void;
};
function stubIndexedDB(existing: string[] = []) {
	const requests: Request[] = [];
	vi.stubGlobal("indexedDB", {
		open: () => {
			const request: Request = {};
			requests.push(request);
			return request;
		},
		databases: async () => existing.map((name) => ({ name })),
	});
	return requests;
}
const database = () => ({ close: vi.fn(), onversionchange: null as null | (() => void) });
afterEach(() => vi.unstubAllGlobals());

describe("openDatabase", () => {
	it("gives up on an open another tab blocks, or waits for it, as asked", async () => {
		const requests = stubIndexedDB();
		const givenUp = openDatabase("cache", 1, { whenBlocked: "give up" });
		requests[0].onblocked!();
		expect(await givenUp).toBeNull();

		const waited = openDatabase("packs", 1, { whenBlocked: "wait" });
		requests[1].onblocked!();
		const db = database();
		requests[1].result = db;
		requests[1].onsuccess!(); // the other tab let go
		expect(await waited).toBe(db);
	});

	it("closes its connection for another tab's newer version, and says so", async () => {
		const requests = stubIndexedDB();
		const onClose = vi.fn();
		const opening = openDatabase("cache", 1, { onClose });
		const db = database();
		requests[0].result = db;
		requests[0].onsuccess!();
		await opening;
		db.onversionchange!();
		expect(db.close).toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
	});

	it("makes the stores of a new or older database", async () => {
		const requests = stubIndexedDB();
		const upgrade = vi.fn();
		const opening = openDatabase("cache", 2, { upgrade });
		const db = database();
		requests[0].result = db;
		requests[0].onupgradeneeded!({ oldVersion: 1 });
		requests[0].onsuccess!();
		await opening;
		expect(upgrade).toHaveBeenCalledWith(db, requests[0], 1);
	});
});

describe("openExisting", () => {
	it("opens nothing when there is no such database, and makes none", async () => {
		const requests = stubIndexedDB(["other"]);
		expect(await openExisting("cubane-resource-packs")).toBeNull();
		expect(requests).toHaveLength(0);
	});

	it("opens one that exists as it is", async () => {
		const requests = stubIndexedDB(["cubane-resource-packs"]);
		const opening = openExisting("cubane-resource-packs");
		await vi.waitFor(() => expect(requests).toHaveLength(1));
		// its stores are not made or changed: an upgrade asked for is turned down
		const abort = vi.fn();
		requests[0].transaction = { abort };
		requests[0].onupgradeneeded!({ oldVersion: 0 });
		expect(abort).toHaveBeenCalled();
		requests[0].onerror!();
		expect(await opening).toBeNull();
	});
});

describe("keptDatabase", () => {
	it("keeps one connection, and opens it again once it closed", async () => {
		const requests = stubIndexedDB();
		const get = keptDatabase("cache", 1);
		const first = get();
		expect(get()).toBe(first); // asked twice, opened once
		const db = database();
		requests[0].result = db;
		requests[0].onsuccess!();
		expect(await first).toBe(db);
		db.onversionchange!();
		get();
		expect(requests).toHaveLength(2);
	});
});
