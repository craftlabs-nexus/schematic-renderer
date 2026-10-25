import { describe, it, expect, vi } from "vitest";

// The WASM worker's batch on a stand-in mesher: each chunk comes back as one triangle of as many vertices.
vi.mock("../../wasm/mesh_builder_wasm.js", () => ({
	default: async () => {},
	get_version: () => "test",
	MeshBuilder: class {
		build_chunk() {
			return {
				meshes: [
					{
						category: "solid",
						positions: new Int16Array(9),
						normals: new Int8Array(9),
						uvs: new Float32Array(6),
						indices: new Uint16Array([0, 1, 2]),
						groups: [{ start: 0, count: 3, materialIndex: 0 }],
						layers: Int32Array.from([0, 0, 0, 3]),
					},
				],
			};
		}
		free() {}
	},
}));
vi.mock("../../wasm/mesh_builder_wasm_bg.wasm?inline", () => ({ default: "" }));

describe("a batch from the WASM worker", () => {
	it("says where each chunk's vertices begin", async () => {
		const posted: any[] = [];
		vi.spyOn(self, "postMessage").mockImplementation(((message: unknown) => {
			posted.push(message);
		}) as typeof self.postMessage);
		await import("../MeshBuilderWasm.worker");
		const send = (data: object) =>
			(self.onmessage as (e: MessageEvent) => Promise<void>)({ data } as MessageEvent);
		await send({ type: "startBatch", meshContextId: "c" });
		for (const chunk of [
			[0, 0, 0],
			[1, 0, 0],
		])
			await send({
				type: "buildChunkBatched",
				chunkId: `batch_${chunk.join("_")}`,
				blocks: new Int32Array([chunk[0] * 16, 0, 0, 1]),
				chunkOrigin: [chunk[0] * 16, 0, 0],
				meshContextId: "c",
				chunk,
			});
		await send({ type: "finishBatch", meshContextId: "c" });
		const finished = posted.find((m) => m.type === "batchFinished");
		expect(Array.from(finished.meshes[0].chunks)).toEqual([0, 0, 0, 0, 1, 0, 0, 3]);
	});
});
