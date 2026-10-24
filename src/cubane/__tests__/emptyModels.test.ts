import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { AssetLoader, isMissingModel } from "../AssetLoader";
import { BlockMeshBuilder } from "../BlockMeshBuilder";

// A model with no elements draws nothing, as in the game: the vanilla block/air model, which Macaw's doors name for an
// open portcullis's middle, was drawn as the purple placeholder. Only a model that cannot be found gets that.
describe("empty and missing models", () => {
	const files: Record<string, unknown> = {
		"models/minecraft:block/air.json": { textures: { particle: "minecraft:missingno" } },
		"models/minecraft:block/orphan.json": {
			parent: "minecraft:block/not_there",
			textures: { all: "minecraft:block/stone" },
		},
		"models/minecraft:block/entity_item.json": {
			parent: "minecraft:builtin/entity",
			textures: { particle: "minecraft:block/oak_planks" },
		},
		"models/minecraft:block/cube_stone.json": {
			elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: {} }],
		},
	};
	function loader() {
		const l = new AssetLoader(false) as any;
		l.getResourceString = async (path: string) => {
			const hit = files[path] ?? files[path.replace("models/", "models/minecraft:")];
			return hit ? JSON.stringify(hit) : undefined;
		};
		return l as AssetLoader;
	}

	it("tells a model that is empty on purpose from one that is missing", async () => {
		const l = loader();
		expect(isMissingModel(await l.getModel("minecraft:block/air"))).toBe(false);
		expect(isMissingModel(await l.getModel("minecraft:block/nowhere"))).toBe(true);
		expect(isMissingModel(await l.getModel("minecraft:block/orphan"))).toBe(true); // its parent is missing
		expect(isMissingModel(await l.getModel("minecraft:block/entity_item"))).toBe(false); // builtin/ has no file
		expect(isMissingModel(await l.getModel("minecraft:block/cube_stone"))).toBe(false);
	});

	it("draws nothing for an empty model and the placeholder only for a missing one", async () => {
		const l = loader();
		const builder = new BlockMeshBuilder(l, { showUnknownBlocks: true });
		const air = await builder.createBlockMeshNoWater(await l.getModel("minecraft:block/air"));
		expect(air).toBeInstanceOf(THREE.Group);
		expect(air.children).toHaveLength(0);
		const missing = await builder.createBlockMeshNoWater(
			await l.getModel("minecraft:block/nowhere")
		);
		expect((missing as THREE.Mesh).isMesh).toBe(true);
		expect(((missing as THREE.Mesh).material as THREE.MeshStandardMaterial).wireframe).toBe(true);
		// without debug placeholders a missing model draws nothing too
		const quiet = await new BlockMeshBuilder(l).createBlockMeshNoWater(
			await l.getModel("minecraft:block/nowhere")
		);
		expect(quiet.children).toHaveLength(0);
	});
});
