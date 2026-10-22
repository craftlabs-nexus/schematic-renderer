import { describe, it, expect } from "vitest";
import { TintManager } from "../TintManager";

describe("TintManager redstone tint", () => {
	const tints = new TintManager();
	const rgb = (properties: Record<string, string>) => {
		const c = tints.getTint("minecraft:redstone_wire", properties);
		return [c.r, c.g, c.b].map((v) => Math.round(v * 1000) / 1000);
	};

	// RedStoneWireBlock's colour table: f = power / 15, r = 0.6 f + (f > 0 ? 0.4 : 0.3),
	// g = clamp(0.7 f² - 0.5), b = clamp(0.6 f² - 0.7)
	it("is the game's dark red when unpowered", () => {
		expect(rgb({ power: "0" })).toEqual([0.3, 0, 0]);
		expect(rgb({})).toEqual([0.3, 0, 0]);
	});

	it("brightens with power up to the game's orange-red at 15", () => {
		expect(rgb({ power: "8" })).toEqual([0.72, 0, 0]);
		expect(rgb({ power: "15" })).toEqual([1, 0.2, 0]);
	});
});
