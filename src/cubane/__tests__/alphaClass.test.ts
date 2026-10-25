import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { ALPHA_CLASS_SETTINGS, AssetLoader, classifyAlpha, rgbaRegion } from "../AssetLoader";

// RGBA pixels with the given alphas (colour does not matter)
const pixels = (alphas: number[]) => {
	const out = new Uint8ClampedArray(alphas.length * 4);
	alphas.forEach((a, i) => (out[i * 4 + 3] = a));
	return out;
};
const many = (n: number, a: number) => Array.from({ length: n }, () => a);

describe("classifyAlpha", () => {
	it("is opaque when every pixel is solid", () => {
		expect(classifyAlpha(pixels(many(256, 255)))).toBe("opaque");
	});

	it("is cutout when pixels are solid or clear (glass, leaves)", () => {
		expect(classifyAlpha(pixels([...many(200, 255), ...many(56, 0)]))).toBe("cutout");
	});

	it("stays cutout with a few soft edge pixels", () => {
		expect(classifyAlpha(pixels([...many(200, 255), ...many(52, 0), ...many(4, 128)]))).toBe(
			"cutout"
		);
	});

	it("is translucent when partly see-through pixels are more than a few (stained glass)", () => {
		expect(classifyAlpha(pixels(many(256, 140)))).toBe("translucent");
		expect(classifyAlpha(pixels([...many(230, 255), ...many(26, 100)]))).toBe("translucent");
	});
});

describe("ALPHA_CLASS_SETTINGS", () => {
	it("draws opaque and cutout textures in the opaque pass, translucent ones blended without depth writes", () => {
		expect(ALPHA_CLASS_SETTINGS.opaque).toMatchObject({
			transparent: false,
			alphaTest: 0,
			depthWrite: true,
		});
		expect(ALPHA_CLASS_SETTINGS.cutout.transparent).toBe(false);
		expect(ALPHA_CLASS_SETTINGS.cutout.alphaTest).toBeGreaterThan(0);
		expect(ALPHA_CLASS_SETTINGS.translucent).toMatchObject({
			transparent: true,
			depthWrite: false,
		});
	});
});

describe("textureAlphaClass", () => {
	it("reads a DataTexture's own pixels: the missing-texture checkerboard is opaque", () => {
		const loader = new AssetLoader(false) as any;
		const missing = loader.createMissingTexture() as THREE.DataTexture;
		expect(loader.textureAlphaClass("mymod:block/nowhere", missing, null)).toBe("opaque");
	});

	it("reads only the region it is given", () => {
		// 4 × 2: the left half solid, the right half clear
		const data = new Uint8ClampedArray(4 * 2 * 4);
		for (const [x, y] of [
			[0, 0],
			[1, 0],
			[0, 1],
			[1, 1],
		])
			data[(y * 4 + x) * 4 + 3] = 255;
		expect(classifyAlpha(rgbaRegion(data, 4, 0, 0, 2, 2))).toBe("opaque");
		expect(classifyAlpha(rgbaRegion(data, 4, 1, 0, 2, 2))).toBe("cutout");
		const texture = new THREE.DataTexture(data, 4, 2);
		const loader = new AssetLoader(false);
		expect(loader.textureAlphaClass("a", texture, { u: 0, v: 0, width: 0.5, height: 1 })).toBe(
			"opaque"
		);
	});

	it("draws a texture it cannot read translucent, and reads it again later", () => {
		const loader = new AssetLoader(false);
		const texture = new THREE.Texture(); // no image yet
		expect(loader.textureAlphaClass("block/later", texture, null)).toBe("translucent");
		texture.image = { data: new Uint8ClampedArray(4).fill(255), width: 1, height: 1 };
		expect(loader.textureAlphaClass("block/later", texture, null)).toBe("opaque");
	});

	it("does not keep a material whose texture could not be read", async () => {
		const loader = new AssetLoader(false) as any;
		const texture = new THREE.Texture(); // no image yet
		loader.getTexture = async () => texture;
		loader.animatedTextureManager.isAnimated = async () => false;
		const first = await loader.getMaterial("block/later", { useAtlas: false });
		expect(first.depthWrite).toBe(ALPHA_CLASS_SETTINGS.translucent.depthWrite);
		texture.image = { data: new Uint8ClampedArray(4).fill(255), width: 1, height: 1 };
		const second = await loader.getMaterial("block/later", { useAtlas: false });
		expect(second).not.toBe(first);
		expect(second.depthWrite).toBe(ALPHA_CLASS_SETTINGS.opaque.depthWrite);
	});
});
