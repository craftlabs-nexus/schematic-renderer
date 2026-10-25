import { describe, it, expect } from "vitest";
import { blocksInBounds, inRenderingBounds } from "../renderingBounds";

const bounds = (enabled = true) => ({
	min: { x: 0, y: 1, z: 0 },
	max: { x: 2, y: 3, z: 2 },
	enabled,
});

describe("rendering bounds", () => {
	it("hold the cells from min to max, max left out on every axis", () => {
		expect(inRenderingBounds(bounds(), 0, 1, 0)).toBe(true);
		expect(inRenderingBounds(bounds(), 1, 2, 1)).toBe(true);
		expect(inRenderingBounds(bounds(), 2, 2, 1)).toBe(false);
		expect(inRenderingBounds(bounds(), 1, 3, 1)).toBe(false);
		expect(inRenderingBounds(bounds(), 1, 2, 2)).toBe(false);
		expect(inRenderingBounds(bounds(), 1, 0, 1)).toBe(false);
	});

	it("keep a chunk's blocks inside them, flat or one array each, and all of them when off", () => {
		const flat = Int32Array.from([0, 1, 0, 7, 2, 1, 0, 8, 1, 2, 1, 9]);
		expect(Array.from(blocksInBounds(flat, bounds()))).toEqual([0, 1, 0, 7, 1, 2, 1, 9]);
		const each = [
			[0, 0, 0, 1],
			[1, 1, 1, 2],
		];
		expect(blocksInBounds(each, bounds())).toEqual([[1, 1, 1, 2]]);
		expect(blocksInBounds(flat, bounds(false))).toBe(flat);
		expect(blocksInBounds(flat, undefined)).toBe(flat);
	});
});
