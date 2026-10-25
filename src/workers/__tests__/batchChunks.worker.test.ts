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
		build_caps() {
			return { meshes: [] };
		}
		update_palette() {}
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
		await send({ type: "updatePalette", paletteData: [], meshContextId: "c" });
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

describe("a request for a palette the WASM worker does not have", () => {
	// never sent, or dropped: meshed with no palette, every block would come back as nothing
	it("is answered with an error, before its palette is sent and after it is dropped", async () => {
		const posted: any[] = [];
		vi.spyOn(self, "postMessage").mockImplementation(((message: unknown) => {
			posted.push(message);
		}) as typeof self.postMessage);
		vi.spyOn(console, "error").mockImplementation(() => {});
		await import("../MeshBuilderWasm.worker");
		const send = (data: object) =>
			(self.onmessage as (e: MessageEvent) => Promise<void>)({ data } as MessageEvent);
		const requests = async () => {
			posted.length = 0;
			const blocks = () => new Int32Array([0, 0, 0, 1]);
			await send({ type: "buildChunk", chunkId: "0,0,0", blocks: blocks(), meshContextId: "p" });
			await send({ type: "buildChunkBatched", chunkId: "b", blocks: blocks(), meshContextId: "p" });
			const tiles = [{ blocks: blocks(), apron: new Int32Array(0), origin: [0, 0, 0] }];
			await send({ type: "buildCaps", requestId: 7, tiles, meshContextId: "p" });
			return posted.map((m) => m.type);
		};
		expect(await requests()).toEqual(["error", "error", "error"]);
		expect(posted.map((m) => m.chunkId ?? m.requestId)).toEqual(["0,0,0", "b", 7]);
		await send({ type: "updatePalette", paletteData: [], meshContextId: "p" });
		expect(await requests()).toEqual(["chunkBuilt", "chunkAccumulated", "capsBuilt"]);
		await send({ type: "dropPalette", meshContextId: "p" });
		expect(await requests()).toEqual(["error", "error", "error"]);
	});
});
