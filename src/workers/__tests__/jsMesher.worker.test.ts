import { describe, it, expect, vi } from "vitest";

// The JavaScript mesher (MeshBuilder.worker.ts, the WASM one turned off) keeps each palette by its mesh context, as
// the WASM mesher does: it kept one map for every palette sent, and two schematics of different palettes meshed
// against whichever was sent last.

/** A quad facing +y on the block's top face, in one material. */
const top = (materialIndex: number) => ({
	positions: new Float32Array([-0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5]),
	normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
	uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
	indices: new Uint16Array([0, 2, 1, 0, 3, 2]),
	materialIndex,
});

describe("the JavaScript mesher's palettes", () => {
	it("are kept per mesh context, and a chunk is meshed with its own", async () => {
		const posted: any[] = [];
		vi.spyOn(self, "postMessage").mockImplementation(((message: unknown) => {
			posted.push(message);
		}) as typeof self.postMessage);
		await import("../MeshBuilder.worker");
		const send = (data: object) =>
			(self.onmessage as (e: MessageEvent) => void)({ data } as MessageEvent);
		// palette index 0 is a block with a top face, of material 1 in context "a" and material 2 in "b"
		for (const [context, material] of [
			["a", 1],
			["b", 2],
		] as const)
			send({
				type: "updatePalette",
				meshContextId: context,
				paletteData: [
					{ index: 0, occlusionFlags: 0, category: "solid", geometries: [top(material)] },
				],
			});
		const materialsOf = (context: string) => {
			posted.length = 0;
			send({
				type: "buildChunk",
				chunkId: `chunk-${context}`,
				blocks: new Int32Array([0, 0, 0, 0]),
				chunkOrigin: [0, 0, 0],
				meshContextId: context,
			});
			const built = posted.find((m) => m.type === "chunkBuilt");
			return built.meshes.flatMap((m: any) => m.groups.map((g: any) => g.materialIndex));
		};
		expect(materialsOf("a")).toEqual([1]);
		expect(materialsOf("b")).toEqual([2]);
		// a palette dropped meshes nothing more
		send({ type: "dropPalette", meshContextId: "a" });
		expect(materialsOf("a")).toEqual([]);
	});
});
