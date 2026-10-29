import { describe, it, expect, beforeAll, vi } from "vitest";
import * as THREE from "three";
import { loadNucleation, schematicFor } from "./schematicHarness";

// An incremental build with rendering bounds. A chunk's apron (its neighbours, for culling the faces on its seams)
// was made from all the blocks while the chunk itself was cut to the bounds: a face beside a neighbour the bounds cut
// off was culled against a block that is not drawn, and the cut showed a hole.
beforeAll(loadNucleation);

describe("an incremental build with rendering bounds", () => {
	it("culls a chunk's seam only against neighbours the bounds keep", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		// stone either side of the seam between chunks 0 and 1; the bounds end at x 16, so the second is not drawn
		const { so, meshed } = schematicFor(
			[
				[15, 0, 0, "minecraft:stone"],
				[16, 0, 0, "minecraft:stone"],
			],
			"incremental"
		);
		so.renderingBounds = {
			enabled: true,
			min: new THREE.Vector3(0, 0, 0),
			max: new THREE.Vector3(16, 16, 16),
		};
		await so.buildSchematicMeshesIncremental(so, so.chunkDimensions);
		const chunk0 = meshed.find((c) => c.chunk_x === 0);
		expect(chunk0).toBeDefined();
		// the stone at x 16 lay in chunk 0's apron and hid the face of the stone at x 15
		expect(Array.from(chunk0.apronBlocks ?? [])).toEqual([]);
	});

	it("still culls against a neighbour the bounds keep", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { so, meshed, wrapper } = schematicFor(
			[
				[15, 0, 0, "minecraft:stone"],
				[16, 0, 0, "minecraft:stone"],
			],
			"incremental"
		);
		so.renderingBounds = {
			enabled: true,
			min: new THREE.Vector3(0, 0, 0),
			max: new THREE.Vector3(17, 16, 16),
		};
		await so.buildSchematicMeshesIncremental(so, so.chunkDimensions);
		const chunk0 = meshed.find((c) => c.chunk_x === 0);
		const stone = wrapper
			.get_all_palettes()
			.default.findIndex((b: any) => b.name === "minecraft:stone");
		expect(Array.from(chunk0.apronBlocks ?? [])).toEqual([16, 0, 0, stone]);
	});
});
