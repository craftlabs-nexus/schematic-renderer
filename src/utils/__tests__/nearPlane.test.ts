import { describe, it, expect } from "vitest";
import { frustumCornerStretch, nearestCellDistance, nearFor, NEAR_MIN } from "../nearPlane";

describe("the near plane fitted to the nearest block", () => {
	const blocks = (...cells: [number, number, number][]) => {
		const set = new Set(cells.map((c) => c.join(",")));
		let looks = 0;
		const isSolid = (x: number, y: number, z: number) => {
			looks++;
			return set.has(`${x},${y},${z}`);
		};
		return { isSolid, looks: () => looks };
	};

	it("measures to the nearest face of the nearest block", () => {
		expect(nearestCellDistance({ x: 0, y: 3, z: 0 }, blocks([0, 0, 0]).isSolid, 6)).toBeCloseTo(
			2.5
		);
		expect(nearestCellDistance({ x: 2, y: 2, z: 0 }, blocks([0, 0, 0]).isSolid, 6)).toBeCloseTo(
			Math.hypot(1.5, 1.5)
		);
		// the nearer of two, whichever shell it is in
		expect(
			nearestCellDistance({ x: 0.4, y: 0, z: 0 }, blocks([3, 0, 0], [0, 0, -2]).isSolid, 6)
		).toBeCloseTo(1.5);
		// inside a block: no distance at all
		expect(nearestCellDistance({ x: 1.2, y: 0, z: 0 }, blocks([1, 0, 0]).isSolid, 6)).toBe(0);
	});

	it("gives the search radius when nothing is that close, and stops once nothing nearer can follow", () => {
		expect(nearestCellDistance({ x: 0, y: 0, z: 0 }, blocks().isSolid, 6)).toBe(6);
		const w = blocks([0, -1, 0]);
		expect(nearestCellDistance({ x: 0, y: 0, z: 0 }, w.isSolid, 6)).toBeCloseTo(0.5);
		expect(w.looks()).toBeLessThan(27); // the first shell, not the whole 13 × 13 × 13 cube
	});

	it("sits a little short of the block, and never under the minimum", () => {
		expect(nearFor(5)).toBeCloseTo(4.5);
		expect(nearFor(0)).toBe(NEAR_MIN);
		expect(nearFor(0.01)).toBe(NEAR_MIN);
	});

	it("sits short of a block's depth at the corners of the view, where depth is least", () => {
		// fov 90, 16:9: a corner ray is sqrt(1 + 1 + (16/9)²) ≈ 2.27 times as long as its depth
		const stretch = frustumCornerStretch(90, 16 / 9);
		expect(stretch).toBeCloseTo(Math.sqrt(2 + (16 / 9) ** 2));
		const d = 4;
		expect(nearFor(d, stretch)).toBeLessThan(d / stretch);
		expect(nearFor(d, stretch)).toBeCloseTo((d * 0.9) / stretch);
		// a degenerate camera (no size yet) keeps the plain distance
		expect(frustumCornerStretch(60, NaN)).toBe(1);
	});
});
