import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AtlasBuilder } from "../AtlasBuilder";
import { AssetLoader } from "../AssetLoader";

// stand-ins for decoded images: the packer reads only their size
const textures = (count: number, size: number) =>
	Array.from({ length: count }, (_, i) => ({
		path: `block/t${i}`,
		image: { width: size, height: size } as unknown as ImageBitmap,
	}));

describe("AtlasBuilder sizing", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const context = { imageSmoothingEnabled: true, clearRect: vi.fn(), drawImage: vi.fn() };
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
	});
	afterEach(() => vi.restoreAllMocks());

	const atlasSize = async (builder: AtlasBuilder, t: ReturnType<typeof textures>) => {
		const { atlas, uvMap } = await builder.buildAtlas(t);
		expect(uvMap.size).toBe(t.length);
		return atlas.width;
	};

	// 64 px textures with 1 px padding: 31 x 31 = 961 fit a 2048 atlas, 63 x 63 = 3969 a 4096 one
	it("picks the smallest of 2048, 4096 and 8192 that holds every texture", async () => {
		expect(await atlasSize(new AtlasBuilder(), textures(1, 16))).toBe(2048);
		expect(await atlasSize(new AtlasBuilder(), textures(900, 64))).toBe(2048);
		expect(await atlasSize(new AtlasBuilder(), textures(1500, 64))).toBe(4096);
		expect(await atlasSize(new AtlasBuilder(), textures(5000, 64))).toBe(8192);
	});

	it("rejects, naming the textures, instead of dropping what does not fit", async () => {
		const strip = [
			{ path: "block/strip", image: { width: 9000, height: 16 } as unknown as ImageBitmap },
		];
		await expect(new AtlasBuilder().buildAtlas(strip)).rejects.toThrow(
			/1 of 1 textures do not fit a 8192x8192 atlas.*block\/strip \(9000x16\)/
		);
		await expect(new AtlasBuilder(2048).buildAtlas(textures(1500, 64))).rejects.toThrow(
			/2048x2048/
		);
		await expect(new AtlasBuilder("auto", 1, 4096).buildAtlas(textures(5000, 64))).rejects.toThrow(
			/4096x4096/
		);
	});
});

describe("AssetLoader.invalidateCache", () => {
	afterEach(() => vi.restoreAllMocks());

	it("deletes the cached atlas of the packs loaded now", async () => {
		const remove = vi.spyOn(AtlasBuilder, "deleteCachedAtlas").mockResolvedValue();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const loader = new AssetLoader(false) as any;

		await loader.invalidateCache();
		expect(remove).not.toHaveBeenCalled(); // no packs, no cache entry

		loader.resourcePackHash = "packs-a";
		await loader.invalidateCache();
		expect(remove).toHaveBeenCalledWith("packs-a:atlas2");
	});
});
