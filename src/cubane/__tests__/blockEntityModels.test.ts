import { describe, it, expect } from "vitest";
import { Cubane } from "../Cubane";

// Which blocks Cubane draws with its built-in entity models rather than the pack's block models.
describe("blockEntityModels", () => {
	it("builds shulker boxes in by default", () => {
		const c = new Cubane();
		expect(c.isBlockEntityModel("minecraft:red_shulker_box[facing=up]")).toBe(true);
		expect(c.isBlockEntityModel("minecraft:shulker_box")).toBe(false);
		expect(c.isBlockEntityModel("minecraft:chest[facing=north]")).toBe(false);
	});

	it("draws an id mapped to null from the pack, and builds in one mapped to a model", () => {
		const c = new Cubane({
			blockEntityModels: { "minecraft:red_shulker_box": null, "minecraft:chest": "chest" },
		});
		expect(c.isBlockEntityModel("minecraft:red_shulker_box[facing=up]")).toBe(false);
		expect(c.isBlockEntityModel("minecraft:blue_shulker_box[facing=up]")).toBe(true);
		expect(c.isBlockEntityModel("minecraft:chest[facing=north]")).toBe(true);
	});

	it("leaves out the built-in parts of an id mapped to null", () => {
		const parts = (c: Cubane) =>
			(c as unknown as { hybridBlockConfig: Record<string, unknown> }).hybridBlockConfig;
		expect(parts(new Cubane())["minecraft:lectern"]).toBeTruthy();
		const c = new Cubane({ blockEntityModels: { "minecraft:lectern": null } });
		expect(parts(c)["minecraft:lectern"]).toBeUndefined();
		expect(parts(c)["minecraft:bell"]).toBeTruthy();
	});
});
