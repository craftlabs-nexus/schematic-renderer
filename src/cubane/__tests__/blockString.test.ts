import { describe, it, expect } from "vitest";
import { formatBlockString, isAir, parseBlockString } from "../blockString";
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

describe("parseBlockString", () => {
	it("reads the namespace, the name and the properties", () => {
		expect(parseBlockString("minecraft:oak_stairs[facing=east,half=top]")).toEqual({
			namespace: "minecraft",
			name: "oak_stairs",
			properties: { facing: "east", half: "top" },
		});
		expect(parseBlockString("stone")).toEqual({
			namespace: "minecraft",
			name: "stone",
			properties: {},
		});
	});

	it("keeps a property value holding a colon or an equals sign whole", () => {
		// the whole string was split at every ':', and this value was lost
		expect(parseBlockString("mymod:thing[target=minecraft:stone,expr=a=b]").properties).toEqual({
			target: "minecraft:stone",
			expr: "a=b",
		});
	});

	it("reads back what formatBlockString writes", () => {
		const properties = { facing: "north", waterlogged: "true" };
		expect(parseBlockString(formatBlockString("minecraft:oak_slab", properties))).toEqual({
			namespace: "minecraft",
			name: "oak_slab",
			properties,
		});
	});
});

describe("isAir", () => {
	it("is the game's three airs, with or without the namespace, and nothing else", () => {
		for (const id of ["air", "minecraft:air", "minecraft:cave_air", "void_air"])
			expect(isAir(id)).toBe(true);
		for (const id of ["minecraft:stone", "mymod:air", "minecraft:air_block"])
			expect(isAir(id)).toBe(false);
	});
});
