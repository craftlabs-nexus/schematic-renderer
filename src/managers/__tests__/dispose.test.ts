import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

vi.mock("nucleation", () => ({ default: vi.fn(), SchematicWrapper: class {} }));

import { SchematicObject } from "../SchematicObject";

// SchematicObject.dispose on a stand-in: a schematic with a running property watcher, a build in flight, a cell grid
// and a cached cap. Removing a schematic used to leave its watcher timer running, which kept it and all it held alive.
function setup(ownsWrapper: boolean) {
	let finishBuild = () => {};
	const free = vi.fn();
	const cap = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
	const so = Object.create(SchematicObject.prototype) as any;
	Object.assign(so, {
		disposed: false,
		ownsWrapper,
		schematicWrapper: { free },
		builds: new Promise<void>((res) => (finishBuild = res)),
		meshes: [new THREE.Mesh()],
		chunkMeshes: new Map([["0,0,0", []]]),
		group: new THREE.Group(),
		shownCaps: [],
		capsCache: new Map([["k", [cap]]]),
		cellGrid: new Uint16Array(8),
		cellGridBox: { min: [0, 0, 0], max: [1, 1, 1] },
		cellGroupData: new Uint16Array(8),
		groupCells: new Map(),
		shownBoxCache: null,
		blockEntitiesMap: new Map(),
		_propertyWatcherTimer: setTimeout(() => {}, 100000),
	});
	return { so, free, cap, finishBuild: () => finishBuild() };
}

describe("SchematicObject.dispose", () => {
	it("stops the watcher, lets go of its data and frees its schematic once the build in flight is over", async () => {
		const { so, free, cap, finishBuild } = setup(true);
		const disposeCap = vi.spyOn(cap.geometry, "dispose");
		so.dispose();
		expect(so.isDisposed()).toBe(true);
		expect(so._propertyWatcherTimer).toBeNull();
		expect([so.meshes.length, so.chunkMeshes.size, so.capsCache.size]).toEqual([0, 0, 0]);
		expect([so.cellGrid, so.cellGroupData, so.blockEntitiesMap]).toEqual([null, null, null]);
		expect(disposeCap).toHaveBeenCalled();
		// the build still running uses the wrapper: freed only when it is over
		await Promise.resolve();
		expect(free).not.toHaveBeenCalled();
		finishBuild();
		await new Promise((res) => setTimeout(res, 0));
		expect(free).toHaveBeenCalledTimes(1);
		// a filter after removal does nothing
		expect(await so.setLayerRange({ minY: 0, maxY: 1 })).toBe(false);
	});

	it("leaves a wrapper the caller passed in to the caller", async () => {
		const { so, free, finishBuild } = setup(false);
		so.dispose();
		finishBuild();
		await new Promise((res) => setTimeout(res, 0));
		expect(free).not.toHaveBeenCalled();
	});
});
