import { describe, it, expect } from "vitest";
import { isOnBlockBoundary } from "../faceCulling";

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
