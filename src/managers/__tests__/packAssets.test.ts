import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { ResourcePackManager } from "../ResourcePackManager";

// A pack's assets are listed as resource locations, namespace and all: the same path in two namespaces is two assets,
// not a conflict, and a mod's asset can be passed back to getAssetSource.
async function pack(id: string, priority: number, files: string[]) {
	const zip = new JSZip();
	for (const f of files) zip.file(f, "{}");
	const data = await zip.generateAsync({ type: "uint8array" });
	return { id, name: id, priority, enabled: true, data };
}

async function manager(...packs: Awaited<ReturnType<typeof pack>>[]) {
	const m = Object.create(ResourcePackManager.prototype) as any;
	m.packs = new Map(packs.map((p) => [p.id, p]));
	return m as ResourcePackManager;
}

describe("ResourcePackManager pack assets", () => {
	it("lists the game's assets without a namespace and a mod's with one", async () => {
		const m = await manager(
			await pack("a", 0, [
				"assets/minecraft/textures/block/stone.png",
				"assets/create/textures/block/stone.png",
				"assets/create/blockstates/cogwheel.json",
				"assets/create/models/block/cogwheel.json",
				"pack.mcmeta",
			])
		);
		const assets = await m.getPackAssets("a");
		expect(assets.textures.sort()).toEqual(["block/stone", "create:block/stone"]);
		expect(assets.blockstates).toEqual(["create:cogwheel"]);
		expect(assets.models).toEqual(["create:block/cogwheel"]);
	});

	it("does not take the same path in two namespaces for a conflict, and keeps a mod's path whole", async () => {
		const m = await manager(
			await pack("vanilla", 0, ["assets/minecraft/textures/block/stone.png"]),
			await pack("mod", 1, [
				"assets/create/textures/block/stone.png",
				"assets/create/textures/block/andesite.png",
			]),
			await pack("mod-retexture", 2, ["assets/create/textures/block/andesite.png"])
		);
		const conflicts = await m.getAssetConflicts();
		expect(conflicts.map((c) => [c.type, c.assetPath])).toEqual([
			["texture", "create:block/andesite"],
		]);
		expect(conflicts[0].providers.map((p) => p.packId)).toEqual(["mod", "mod-retexture"]);
	});
});
