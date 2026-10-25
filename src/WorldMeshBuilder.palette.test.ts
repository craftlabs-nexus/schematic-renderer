import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

// The same stand-ins as WorldMeshBuilder.test.ts, so the module loads without WASM, workers or a renderer.
vi.mock("./wasm/minecraft_schematic_utils_bg.wasm", () => ({ default: "mock-utils-wasm" }));
vi.mock("nucleation", () => ({
	default: vi.fn().mockResolvedValue(undefined),
	SchematicWrapper: class {},
}));
vi.mock("./workers/MeshBuilder.worker?worker&inline", () => ({
	default: class MockWorker {
		postMessage() {}
		terminate() {}
		onmessage = null;
	},
}));
vi.mock("./SchematicRenderer");
vi.mock("./cubane", () => ({ Cubane: class {} }));
vi.mock("./managers/SchematicObject");
vi.mock("./MaterialRegistry", () => ({
	MaterialRegistry: { getMaterial: (m: THREE.Material) => m, peekMaterial: () => undefined },
}));
vi.mock("./InstancedBlockRenderer");

import { WorldMeshBuilder } from "./WorldMeshBuilder";

// A mesh builder whose Cubane makes a box for every block, slowly enough for two palette builds to overlap; the
// messages its workers get are recorded.
function builder() {
	const wmb = Object.create(WorldMeshBuilder.prototype) as any;
	const posted: any[] = [];
	Object.assign(wmb, {
		schematicRenderer: { options: {} },
		paletteCache: null,
		paletteKey: "",
		palettePending: null,
		connectingPalette: new Set(),
		gpuInitPromise: null,
		useGPUCompute: false,
		useWasmMeshBuilder: true,
		meshContextId: "mctx-test",
		workers: [{ postMessage: (m: any) => posted.push(m) }],
		initializeWorkers() {},
		cubane: {
			prepareBlockEntityModels: async () => {},
			isConnectingBlock: async (block: string) => block.includes("glass"),
			getBlockMesh: async () => {
				await new Promise((res) => setTimeout(res, 5));
				return new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
			},
			getBlockOptimizationData: async () => null,
		},
	});
	return { wmb, posted };
}

const palette = (...names: string[]) => names.map((name) => ({ name, properties: {} }));

describe("the palette cache", () => {
	it("is the palette asked for when two builds of the same palette overlap", async () => {
		const { wmb } = builder();
		const first = palette("minecraft:air", "minecraft:stone");
		const second = palette("minecraft:air", "minecraft:dirt", "minecraft:glass");
		await wmb.precomputePaletteGeometries(first);
		const a = wmb.precomputePaletteGeometries(second);
		// a second build of the same palette while the first is still at it
		await wmb.precomputePaletteGeometries(second);
		expect(wmb.paletteCache.palette).toBe(second);
		expect([...wmb.connectingPalette]).toEqual([2]);
		await a;
		expect(wmb.paletteCache.palette).toBe(second);
	});
});
