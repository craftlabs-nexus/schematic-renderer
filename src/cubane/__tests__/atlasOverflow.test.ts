import { describe, it, expect, vi, afterEach } from "vitest";
import { AssetLoader } from "../AssetLoader";
import { AtlasBuilder } from "../AtlasBuilder";
import { ResourcePackManager } from "../ResourcePackManager";

// Packs whose textures do not fit an atlas: the pack change still takes, the meshes are rebuilt (from the blocks' own
// textures), the failure is reported, and the same packs are not decoded again only to fail again.
describe("a texture atlas that does not fit", () => {
	afterEach(() => vi.restoreAllMocks());

	it("still rebuilds the meshes and reports the error, without rejecting the pack change", async () => {
		const rpm = Object.create(ResourcePackManager.prototype) as any;
		const events: Array<[string, unknown]> = [];
		rpm.emit = (type: string, payload: unknown) => events.push([type, payload]);
		rpm.getEnabledPacks = () => [];
		let meshesRebuilt = 0;
		rpm.onAtlasRebuildNeeded = async () => {
			throw new Error("Texture atlas: 3 of 9000 textures do not fit");
		};
		rpm.onMeshRebuildNeeded = () => meshesRebuilt++;
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(rpm.triggerRebuild("pack added")).resolves.toBeUndefined();
		expect(meshesRebuilt).toBe(1);
		const error = events.find(([type]) => type === "error")?.[1] as {
			error: Error;
			context: string;
		};
		expect(error.context).toBe("atlas");
		expect(error.error.message).toContain("do not fit");
	});

	it("remembers the failure for the same packs, and tries again for others", async () => {
		const build = vi
			.spyOn(AtlasBuilder.prototype, "buildAtlas")
			.mockRejectedValue(new Error("does not fit"));
		const loader = new AssetLoader(false) as any;
		loader.loadColormaps = async () => {};
		loader.getOrderedPacks = () => [];
		loader.resourcePackHash = "packs-a";

		await expect(loader.buildTextureAtlas()).rejects.toThrow("does not fit");
		await expect(loader.buildTextureAtlas()).rejects.toThrow("does not fit");
		expect(build).toHaveBeenCalledTimes(1);

		loader.resourcePackHash = "packs-b";
		await expect(loader.buildTextureAtlas()).rejects.toThrow("does not fit");
		expect(build).toHaveBeenCalledTimes(2);
	});
});
