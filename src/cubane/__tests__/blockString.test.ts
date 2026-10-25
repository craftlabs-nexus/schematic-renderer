import { describe, it, expect } from "vitest";
import { formatBlockString } from "../blockString";
import { Cubane } from "../Cubane";

describe("formatBlockString", () => {
	it("writes a state as parseBlockString reads it, with its properties sorted", () => {
		expect(formatBlockString("minecraft:stone")).toBe("minecraft:stone");
		expect(formatBlockString("minecraft:stone", {})).toBe("minecraft:stone");
		const pane = { west: "false", north: "true", east: "true", south: "false" };
		const s = formatBlockString("minecraft:glass_pane", pane);
		expect(s).toBe("minecraft:glass_pane[east=true,north=true,south=false,west=false]");
		const block = Cubane.prototype.parseBlockString.call(null, s);
		expect(block).toEqual({ namespace: "minecraft", name: "glass_pane", properties: pane });
	});
});
