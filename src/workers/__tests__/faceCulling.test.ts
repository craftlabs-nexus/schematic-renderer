import { describe, it, expect } from "vitest";
import {
	isOnBlockBoundary,
	faceHiddenBy,
	SOLID_CULL_KEY,
	FLUID_NONE,
	FLUID_WATER,
	FLUID_LAVA,
	type CullInfo,
} from "../faceCulling";

// The blocks as WorldMeshBuilder.computeCulling describes them (bit 0 west … 5 south; side 0 is a neighbour's west).
const ALL = 63;
const stone: CullInfo = { occlusionFlags: ALL, cullKey: SOLID_CULL_KEY, fluid: FLUID_NONE };
const glass: CullInfo = { occlusionFlags: ALL, cullKey: "minecraft:glass", fluid: FLUID_NONE };
const redGlass: CullInfo = {
	occlusionFlags: ALL,
	cullKey: "minecraft:red_stained_glass",
	fluid: FLUID_NONE,
};
const slime: CullInfo = {
	occlusionFlags: ALL,
	cullKey: "minecraft:slime_block",
	fluid: FLUID_NONE,
};
const leaves: CullInfo = { occlusionFlags: 0, cullKey: "minecraft:oak_leaves", fluid: FLUID_NONE };
const water: CullInfo = { occlusionFlags: 0, cullKey: "minecraft:water", fluid: FLUID_WATER };
const lava: CullInfo = { occlusionFlags: 0, cullKey: "minecraft:lava", fluid: FLUID_LAVA };
// a waterlogged bottom slab: its bottom is a full opaque side, its west side only half
const wetSlab: CullInfo = { occlusionFlags: 1 << 2, cullKey: SOLID_CULL_KEY, fluid: FLUID_WATER };

describe("faceHiddenBy", () => {
	it("hides any face against an opaque full side", () => {
		for (const self of [stone, glass, slime, leaves, wetSlab])
			expect(faceHiddenBy(self, FLUID_NONE, stone, 0)).toBe(true);
		expect(faceHiddenBy(water, FLUID_WATER, stone, 0)).toBe(true);
	});

	it("lets a see-through block hide only the same block's face", () => {
		expect(faceHiddenBy(glass, FLUID_NONE, glass, 0)).toBe(true);
		expect(faceHiddenBy(slime, FLUID_NONE, slime, 0)).toBe(true);
		// glass beside other glass, leaves or slime keeps its face, and so does stone beside glass or slime
		expect(faceHiddenBy(glass, FLUID_NONE, redGlass, 0)).toBe(false);
		expect(faceHiddenBy(leaves, FLUID_NONE, glass, 0)).toBe(false);
		expect(faceHiddenBy(glass, FLUID_NONE, leaves, 0)).toBe(false);
		expect(faceHiddenBy(stone, FLUID_NONE, glass, 0)).toBe(false);
		expect(faceHiddenBy(stone, FLUID_NONE, slime, 0)).toBe(false);
	});

	it("never hides a face against leaves, even another leaf's", () => {
		expect(faceHiddenBy(leaves, FLUID_NONE, leaves, 0)).toBe(false);
	});

	it("hides a fluid's face against the same fluid, a waterlogged block's water included", () => {
		expect(faceHiddenBy(water, FLUID_WATER, water, 0)).toBe(true);
		expect(faceHiddenBy(water, FLUID_WATER, wetSlab, 0)).toBe(true);
		expect(faceHiddenBy(wetSlab, FLUID_WATER, water, 0)).toBe(true);
		expect(faceHiddenBy(water, FLUID_WATER, lava, 0)).toBe(false);
		expect(faceHiddenBy(water, FLUID_WATER, glass, 0)).toBe(false);
	});

	it("keeps a waterlogged block's own faces beside water", () => {
		// the slab's side next to water was culled when every waterlogged block claimed all six sides
		expect(faceHiddenBy(wetSlab, FLUID_NONE, water, 0)).toBe(false);
		expect(faceHiddenBy(wetSlab, FLUID_NONE, wetSlab, 0)).toBe(false); // its half-high side covers nothing
		expect(faceHiddenBy(wetSlab, FLUID_NONE, wetSlab, 2)).toBe(true); // its full bottom does
	});
});

describe("isOnBlockBoundary", () => {
	it("takes a face at +-0.5 on its normal's side for one on the block's boundary", () => {
		expect(isOnBlockBoundary(0.5, 1)).toBe(true);
		expect(isOnBlockBoundary(-0.5, -1)).toBe(true);
		expect(isOnBlockBoundary(0.495, 1)).toBe(true);
	});

	it("does not take a face in the block's middle plane for a boundary one", () => {
		// a repeater torch spanning pixels 8..10 has its west face at x = 0 (block-centred): the stone beside the
		// repeater used to cull it, and the torch showed a see-through side
		expect(isOnBlockBoundary(0, -1)).toBe(false);
		expect(isOnBlockBoundary(0, 1)).toBe(false);
	});

	it("ignores the far side and positions outside the block", () => {
		expect(isOnBlockBoundary(-0.5, 1)).toBe(false);
		expect(isOnBlockBoundary(0.5, -1)).toBe(false);
		expect(isOnBlockBoundary(1, 1)).toBe(false);
		expect(isOnBlockBoundary(0.5, 0)).toBe(false);
	});
});
