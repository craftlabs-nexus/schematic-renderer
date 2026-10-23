import { describe, it, expect } from "vitest";
import { ALPHA_CLASS_SETTINGS, classifyAlpha } from "../AssetLoader";

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
