import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { Blob as NodeBlob } from "node:buffer";

// Cubane's own pack manager, kept in the browser (persistPacks), on an in-memory IndexedDB: a pack's bytes are written
// once. Every save wrote every pack again, so removing all of them one by one wrote what was left each time.

let ResourcePackManager: typeof import("../ResourcePackManager").ResourcePackManager;

beforeEach(async () => {
	vi.stubGlobal("indexedDB", new IDBFactory());
	vi.stubGlobal("IDBKeyRange", IDBKeyRange);
	vi.stubGlobal("Blob", NodeBlob); // a Blob IndexedDB keeps, as a browser's
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.resetModules();
	({ ResourcePackManager } = await import("../ResourcePackManager"));
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** A manager holding `count` packs (as loading them leaves it), and the pack writes it makes. */
async function managerWith(count: number) {
	const manager = new ResourcePackManager() as any;
	await manager.initPromise;
	for (let i = 0; i < count; i++) {
		const id = `pack-${i}`;
		manager.packs.set(id, {
			blob: new Blob([`pack ${i}`]),
			info: { id, name: id, priority: i, enabled: true },
		});
		manager.packOrder.push(id);
	}
	const put = vi.spyOn(manager, "dbPut");
	const packWrites = () => put.mock.calls.filter(([store]) => store === "packBlobs").length;
	return { manager, packWrites };
}

describe("Cubane's pack store", () => {
	it("writes a pack's bytes once, however often its state is saved", async () => {
		const { manager, packWrites } = await managerWith(3);
		await manager.saveState();
		await manager.saveState();
		await manager.saveState();
		expect(packWrites()).toBe(3);
	});

	it("writes a pack added later, and only it", async () => {
		const { manager, packWrites } = await managerWith(2);
		await manager.saveState();
		manager.packs.set("pack-new", {
			blob: new Blob(["new"]),
			info: { id: "pack-new", name: "new", priority: 9, enabled: true },
		});
		manager.packOrder.push("pack-new");
		await manager.saveState();
		expect(packWrites()).toBe(3);
	});

	it("writes no pack again as the packs are removed one by one", async () => {
		const { manager, packWrites } = await managerWith(4);
		await manager.saveState();
		for (const id of ["pack-0", "pack-1", "pack-2", "pack-3"]) {
			manager.packs.delete(id);
			manager.packOrder.splice(manager.packOrder.indexOf(id), 1);
			await manager.saveState(); // as Cubane saves on each packRemoved
		}
		// 4 + 3 + 2 + 1 more before
		expect(packWrites()).toBe(4);
	});
});
