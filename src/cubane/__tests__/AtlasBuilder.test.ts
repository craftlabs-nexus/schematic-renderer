import { describe, it, expect } from "vitest";
import { AtlasBuilder } from "../AtlasBuilder";

const textures = (count: number, size: number) =>
	Array.from({ length: count }, (_, i) => ({ path: `block/t${i}`, width: size, height: size }));

describe("AtlasBuilder sizing", () => {
	// 64 px textures with 1 px padding: 31 x 31 = 961 fit a 2048 atlas, 63 x 63 = 3969 a 4096 one
	it("picks the smallest of 2048, 4096 and 8192 that holds every texture", () => {
		expect(new AtlasBuilder().atlasSizeFor(textures(1, 16))).toBe(2048);
		expect(new AtlasBuilder().atlasSizeFor(textures(900, 64))).toBe(2048);
		expect(new AtlasBuilder().atlasSizeFor(textures(1500, 64))).toBe(4096);
		expect(new AtlasBuilder().atlasSizeFor(textures(5000, 64))).toBe(8192);
	});

	it("throws, naming the textures, instead of dropping what does not fit", () => {
		expect(() =>
			new AtlasBuilder().atlasSizeFor([{ path: "block/strip", width: 9000, height: 16 }])
		).toThrow(/1 of 1 textures do not fit a 8192x8192 atlas.*block\/strip \(9000x16\)/);
		expect(() => new AtlasBuilder(2048).atlasSizeFor(textures(1500, 64))).toThrow(/2048x2048/);
		expect(() => new AtlasBuilder("auto", 1, 4096).atlasSizeFor(textures(5000, 64))).toThrow(
			/4096x4096/
		);
	});
});
