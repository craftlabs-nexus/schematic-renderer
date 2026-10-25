import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { AssetLoader } from "../AssetLoader";
import {
	countPackAssets,
	listPackAssets,
	normalizeResourceLocation,
	packAssetFromFilePath,
	packPathForAsset,
	parseResourceLocation,
	resolveAssetFilePath,
	scanPackAssets,
} from "../ResourceLocation";

describe("ResourceLocation", () => {
	it("parses and formats namespaced ids", () => {
		expect(parseResourceLocation("storagedrawers:block/foo")).toEqual({
			namespace: "storagedrawers",
			path: "block/foo",
		});
		expect(parseResourceLocation("block/stone")).toEqual({
			namespace: "minecraft",
			path: "block/stone",
		});
		expect(normalizeResourceLocation("minecraft:block/stone", { omitDefaultNamespace: true })).toBe(
			"block/stone"
		);
		expect(normalizeResourceLocation("block/stone")).toBe("minecraft:block/stone");
	});

	it("maps a resource path to its file in the pack", () => {
		expect(resolveAssetFilePath("blockstates/storagedrawers:oak_full_drawers_1.json")).toBe(
			"assets/storagedrawers/blockstates/oak_full_drawers_1.json"
		);
		expect(resolveAssetFilePath("textures/block/stone.png")).toBe(
			"assets/minecraft/textures/block/stone.png"
		);
		expect(
			resolveAssetFilePath(
				"textures/connectedglass:scratched_glass/scratched_glass_lime.png.mcmeta"
			)
		).toBe("assets/connectedglass/textures/scratched_glass/scratched_glass_lime.png.mcmeta");
		expect(packPathForAsset("waystones:block/waystone", "model")).toBe(
			"assets/waystones/models/block/waystone.json"
		);
	});

	it("reads a pack file's namespace and type back", () => {
		expect(packAssetFromFilePath("assets/farmersdelight/textures/block/stove_front.png")).toEqual({
			namespace: "farmersdelight",
			directory: "textures",
			type: "texture",
			path: "block/stove_front",
		});
		expect(packAssetFromFilePath("assets/minecraft/lang/en_us.json")).toBeNull();
	});

	it("scans a pack's zip for its assets, skipping directories and other files", () => {
		const zip = new JSZip();
		zip.file("pack.mcmeta", "{}");
		zip.file("assets/minecraft/textures/block/stone.png", new Uint8Array([1]));
		zip.file("assets/minecraft/textures/block/stone.png.mcmeta", "{}");
		zip.file("assets/minecraft/blockstates/stone.json", "{}");
		zip.file("assets/minecraft/models/block/stone.json", "{}");
		zip.file("assets/create/models/block/stone.json", "{}");
		zip.file("assets/minecraft/lang/en_us.json", "{}");
		zip.folder("assets/minecraft/models/item.json");

		expect(scanPackAssets(zip, "model").map((a) => `${a.namespace}:${a.path}`)).toEqual([
			"minecraft:block/stone",
			"create:block/stone",
		]);
		expect(scanPackAssets(zip)).toHaveLength(4);
		expect(countPackAssets(zip)).toEqual({ textures: 1, blockstates: 1, models: 2 });
		expect(listPackAssets(zip)).toEqual({
			textures: ["block/stone"],
			blockstates: ["stone"],
			models: ["block/stone", "create:block/stone"],
		});
	});
});

describe("AssetLoader with a namespaced pack", () => {
	// vanilla and a mod both define a "chest"; the mod's model inherits a vanilla parent
	async function loader(): Promise<AssetLoader> {
		const zip = new JSZip();
		zip.file(
			"assets/minecraft/blockstates/chest.json",
			JSON.stringify({ variants: { "": { model: "minecraft:block/chest" } } })
		);
		zip.file(
			"assets/minecraft/models/block/cube_all.json",
			JSON.stringify({
				textures: { particle: "#all" },
				elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: "#all" } } }],
			})
		);
		zip.file(
			"assets/storagedrawers/blockstates/chest.json",
			JSON.stringify({ variants: { "": { model: "storagedrawers:block/chest" } } })
		);
		zip.file(
			"assets/storagedrawers/models/block/chest.json",
			JSON.stringify({
				parent: "minecraft:block/cube_all",
				textures: { all: "storagedrawers:block/chest_side" },
			})
		);
		zip.file("assets/storagedrawers/textures/block/chest_side.png", new Uint8Array([1, 2, 3]));
		const assets = new AssetLoader(false);
		await assets.loadResourcePack(await zip.generateAsync({ type: "blob" }));
		return assets;
	}

	it("keeps a mod's block apart from vanilla's of the same name", async () => {
		const assets = await loader();
		expect(await assets.getBlockState("storagedrawers:chest")).toEqual({
			variants: { "": { model: "storagedrawers:block/chest" } },
		});
		expect(await assets.getBlockState("minecraft:chest")).toEqual({
			variants: { "": { model: "minecraft:block/chest" } },
		});
		expect(await assets.getBlockState("chest")).toEqual({
			variants: { "": { model: "minecraft:block/chest" } },
		});
	});

	it("merges a mod model with its vanilla parent and keeps the texture's namespace", async () => {
		const assets = await loader();
		const model = await assets.getModel("storagedrawers:block/chest");
		expect(model.elements).toHaveLength(1);
		expect(assets.resolveTexture("#all", model)).toBe("storagedrawers:block/chest_side");
		expect(assets.resolveTexture("#particle", model)).toBe("storagedrawers:block/chest_side");
	});

	it("finds a mod texture's bytes", async () => {
		const assets = await loader();
		const blob = await assets.getResourceBlob("textures/storagedrawers:block/chest_side.png");
		expect(blob?.size).toBe(3);
	});
});
