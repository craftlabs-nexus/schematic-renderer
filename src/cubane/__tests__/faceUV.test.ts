import { describe, it, expect } from "vitest";
import { defaultFaceUV, withFaceUV } from "../faceUV";

// Minecraft's BlockElement.uvsByFace: a face with no UV shows the part of the texture where it sits on its element.
describe("defaultFaceUV", () => {
	it("is the whole texture for a full cube", () => {
		for (const d of ["down", "up", "north", "south", "west", "east"]) {
			expect(defaultFaceUV({ from: [0, 0, 0], to: [16, 16, 16] }, d)).toEqual([0, 0, 16, 16]);
		}
	});

	it("projects a small element's faces onto the texture as the game does", () => {
		// a hopper's funnel: from [4, 4, 4] to [12, 10, 12]
		const e = { from: [4, 4, 4], to: [12, 10, 12] };
		expect(defaultFaceUV(e, "up")).toEqual([4, 4, 12, 12]);
		expect(defaultFaceUV(e, "down")).toEqual([4, 4, 12, 12]);
		expect(defaultFaceUV(e, "north")).toEqual([4, 6, 12, 12]);
		expect(defaultFaceUV(e, "south")).toEqual([4, 6, 12, 12]);
		// a rim along the west edge: from [0, 10, 0] to [2, 16, 16]
		const rim = { from: [0, 10, 0], to: [2, 16, 16] };
		expect(defaultFaceUV(rim, "west")).toEqual([0, 0, 16, 6]);
		expect(defaultFaceUV(rim, "east")).toEqual([0, 0, 16, 6]);
		expect(defaultFaceUV(rim, "north")).toEqual([14, 0, 16, 6]);
		expect(defaultFaceUV(rim, "south")).toEqual([0, 0, 2, 6]);
		expect(defaultFaceUV(rim, "up")).toEqual([0, 0, 2, 16]);
		expect(defaultFaceUV(rim, "down")).toEqual([0, 0, 2, 16]);
	});

	it("keeps a face's own UV and leaves the model's face alone", () => {
		const own = { uv: [1, 2, 3, 4], texture: "#t" };
		expect(withFaceUV(own, { from: [4, 4, 4], to: [12, 10, 12] }, "up")).toBe(own);
		const bare: { texture: string; uv?: number[] } = { texture: "#t" };
		const drawn = withFaceUV(bare, { from: [4, 4, 4], to: [12, 10, 12] }, "up");
		expect(drawn.uv).toEqual([4, 4, 12, 12]);
		expect(bare.uv).toBeUndefined();
	});
});
