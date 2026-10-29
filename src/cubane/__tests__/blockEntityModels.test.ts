import { describe, it, expect } from "vitest";
import { Cubane } from "../Cubane";

// Which blocks Cubane draws with its built-in entity models rather than the pack's block models.
describe("blockEntityModels", () => {
	it("builds shulker boxes in by default", () => {
		const c = new Cubane();
		expect(c.isBlockEntityModel("minecraft:red_shulker_box[facing=up]")).toBe(true);
		expect(c.isBlockEntityModel("minecraft:shulker_box")).toBe(false);
		// built in until a pack is found to draw them
		expect(c.isBlockEntityModel("minecraft:chest[facing=north]")).toBe(true);
	});

	it("draws an id mapped to null from the pack, and builds in one mapped to a model", () => {
		const c = new Cubane({
			blockEntityModels: { "minecraft:red_shulker_box": null, "minecraft:chest": "chest" },
		});
		expect(c.isBlockEntityModel("minecraft:red_shulker_box[facing=up]")).toBe(false);
		expect(c.isBlockEntityModel("minecraft:blue_shulker_box[facing=up]")).toBe(true);
		expect(c.isBlockEntityModel("minecraft:chest[facing=north]")).toBe(true);
	});

	it("leaves out the built-in parts of an id mapped to null", () => {
		const parts = (c: Cubane) =>
			(c as unknown as { hybridBlockConfig: Record<string, unknown> }).hybridBlockConfig;
		expect(parts(new Cubane())["minecraft:lectern"]).toBeTruthy();
		const c = new Cubane({ blockEntityModels: { "minecraft:lectern": null } });
		expect(parts(c)["minecraft:lectern"]).toBeUndefined();
		expect(parts(c)["minecraft:bell"]).toBeTruthy();
	});

	// a Cubane whose pack holds `files` (pack paths with the namespace, as AssetLoader asks for them)
	function withPack(
		files: Record<string, unknown>,
		options?: ConstructorParameters<typeof Cubane>[0]
	) {
		const c = new Cubane({ autoRestore: false, ...options });
		const internals = c as unknown as {
			initialized: boolean;
			assetLoader: { getResourceString: (path: string) => Promise<string | undefined> };
		};
		internals.initialized = true;
		internals.assetLoader.getResourceString = async (path) =>
			path in files ? JSON.stringify(files[path]) : undefined;
		return c;
	}
	const chestState = {
		variants: { "facing=north,type=single": { model: "minecraft:block/chest" } },
	};

	it("builds chests in while the pack draws nothing for them (vanilla's block/chest has no elements)", async () => {
		const c = withPack({
			"blockstates/minecraft:chest.json": chestState,
			"models/minecraft:block/chest.json": { textures: { particle: "minecraft:block/oak_planks" } },
		});
		await c.prepareBlockEntityModels();
		expect(c.isBlockEntityModel("minecraft:chest[facing=north]")).toBe(true);
		expect(c.isBlockEntityModel("minecraft:ender_chest[facing=north]")).toBe(true); // no blockstate at all
	});

	it("draws chests from a pack whose blockstate names a model with faces", async () => {
		const c = withPack({
			"blockstates/minecraft:chest.json": chestState,
			"models/minecraft:block/chest.json": {
				elements: [{ from: [1, 0, 1], to: [15, 14, 15], faces: { up: { texture: "#lid" } } }],
			},
		});
		await c.prepareBlockEntityModels();
		expect(c.isBlockEntityModel("minecraft:chest[facing=north]")).toBe(false);
		expect(c.isBlockEntityModel("minecraft:trapped_chest[facing=north]")).toBe(true);
	});

	it("keeps to the option for a chest it names", async () => {
		const c = withPack(
			{ "blockstates/minecraft:chest.json": chestState },
			{ blockEntityModels: { "minecraft:chest": null } }
		);
		await c.prepareBlockEntityModels();
		expect(c.isBlockEntityModel("minecraft:chest[facing=north]")).toBe(false);
	});
	it("keeps the answer for the packs loaded now when they change while the old packs are asked", async () => {
		const c = withPack({});
		// the old packs draw no chest and answer slowly; the new ones draw every chest
		let packs = "old";
		(c as unknown as { packDrawsBlock: (id: string) => Promise<boolean> }).packDrawsBlock =
			async () => {
				if (packs === "new") return true;
				await new Promise((res) => setTimeout(res, 20));
				return false;
			};
		const first = c.prepareBlockEntityModels();
		packs = "new";
		c.clearMeshCaches(); // the packs change
		await Promise.all([first, c.prepareBlockEntityModels()]);
		// the old packs' answer came last and was written over the new one: the chest stayed built in
		expect(c.isBlockEntityModel("minecraft:chest[facing=north]")).toBe(false);
	});
});
