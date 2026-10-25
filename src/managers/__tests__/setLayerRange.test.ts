import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

vi.mock("nucleation", () => ({ default: vi.fn(), SchematicWrapper: class {} }));

import { SchematicObject } from "../SchematicObject";
import { sortByLayer } from "../../utils/layerRange";

// SchematicObject's cell filter on a stand-in: a schematic 3 × 3 × 1 (x, y, z) with a column of three blocks at x 0
// (group 0) and one block at (1, 0, 0) in cell group 7. Its merged mesh has a run for each; a sign hangs on (1, 0, 0);
// the mesh builder records the pieces it is asked to cap and makes a cap for each call.
function setup({ indexed = true } = {}) {
	// [layer, group, start, count]: (x 0, y 0), (1, 0) in group 7, (0, 1), (0, 2): material 0, three indices each
	const sorted = sortByLayer(
		Uint32Array.from({ length: 12 }, (_, i) => i),
		[{ start: 0, count: 12, materialIndex: 0 }],
		[0, 0, 0, 3, 0, 7, 3, 3, 1, 0, 6, 3, 2, 0, 9, 3]
	);
	const geometry = new THREE.BufferGeometry();
	geometry.setIndex(new THREE.BufferAttribute(sorted.indices, 1));
	for (const g of sorted.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
	if (indexed) geometry.userData.layerIndex = sorted.layerIndex;
	const mesh = new THREE.Mesh(geometry, [new THREE.MeshBasicMaterial()]);
	const sign = new THREE.Group();
	Object.assign(sign.userData, { layerY: 0, cellGroup: 7 });
	sign.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));

	const box = { min: [0, 0, 0], max: [2, 2, 0] };
	// Sponge order over the box: (y * 1 + z) * 3 + x; palette index + 1 (stone is palette 4)
	const grid = new Uint16Array(9);
	const groups = new Uint16Array(9);
	for (const [x, y] of [
		[0, 0],
		[1, 0],
		[0, 1],
		[0, 2],
	])
		grid[y * 3 + x] = 5;
	groups[1] = 7;

	const asked: Array<{ blocks: number[]; apron: number[]; cellGroups: number[] }> = [];
	// when set, each caps build waits for it to be called (a caps build in flight)
	const gate: { hold: Promise<void> | null } = { hold: null };
	const so = Object.create(SchematicObject.prototype) as any;
	Object.assign(so, {
		fadedMaterials: new Map(),
		baseMaterials: new WeakMap(),
		visible: true,
		meshes: [mesh, sign],
		group: new THREE.Group(),
		blocksVersion: 0,
		gridVersion: 0,
		chunkDimensions: { chunkWidth: 16, chunkHeight: 16, chunkLength: 16 },
		cellFilter: { range: null, hidden: null },
		shownCaps: [],
		capsCache: new Map(),
		capsPending: new Map(),
		filterCall: 0,
		cellGroupData: groups,
		cellGroupBox: box,
		groupCells: null,
		cellGrid: grid,
		cellGridBox: box,
		shownBoxCache: null,
		schematicWrapper: { get_bounding_box: () => box },
		worldMeshBuilder: {
			canBuildCaps: () => true,
			airPaletteIndices: () => new Set<number>(),
			buildCaps: async (pieces: any[]) => {
				for (const p of pieces)
					asked.push({
						blocks: Array.from(p.blocks),
						apron: Array.from(p.apron),
						cellGroups: Array.from(p.cellGroups),
					});
				const cap = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
				cap.name = `cap ${asked.length}`;
				if (gate.hold) await gate.hold;
				return pieces.length ? [cap] : [];
			},
		},
		schematicRenderer: { renderManager: { render() {} } },
		eventEmitter: { emit() {} },
		applyPropertiesToObjects() {},
	});
	so.group.add(mesh, sign);
	const caps = () =>
		so.group.children
			.filter((c: THREE.Object3D) => c.userData.layerCap)
			.map((c: THREE.Object3D) => c.name);
	// holds the next caps builds until the function returned is called
	const hold = () => {
		let open = () => {};
		gate.hold = new Promise<void>((res) => (open = res));
		return () => {
			gate.hold = null;
			open();
		};
	};
	return { so, mesh, sign, caps, asked, hold };
}

describe("SchematicObject.setLayerRange and setHiddenGroups", () => {
	it("draws the layers of a range and caps the cells under the layers left out", async () => {
		const { so, mesh, sign, caps, asked } = setup();
		expect(await so.setLayerRange({ minY: 0, maxY: 2 })).toBe(true);
		expect(mesh.geometry.groups).toEqual([{ start: 0, count: 9, materialIndex: 0 }]);
		expect(sign.visible).toBe(true);
		// (0, 1) is shown under the hidden (0, 2): its top face is a cap
		expect(asked).toEqual([{ blocks: [0, 1, 0, 4], apron: [0, 2, 0, 4], cellGroups: [0] }]);
		expect(caps()).toEqual(["cap 1"]);
	});

	it("hides a cell group's runs and objects, and caps its neighbours", async () => {
		const { so, mesh, sign, asked } = setup();
		expect(await so.setHiddenGroups([7])).toBe(true);
		expect(mesh.geometry.groups).toEqual([
			{ start: 0, count: 3, materialIndex: 0 },
			{ start: 6, count: 6, materialIndex: 0 },
		]);
		expect(sign.visible).toBe(false);
		// (0, 0) beside the hidden (1, 0): the face toward it
		expect(asked).toEqual([{ blocks: [0, 0, 0, 4], apron: [1, 0, 0, 4], cellGroups: [0] }]);
		expect(so.getHiddenGroups()).toEqual([7]);
	});

	it("keeps one filter's caps for the next time, until the blocks change", async () => {
		const { so, asked } = setup();
		await so.setLayerRange({ minY: 0, maxY: 2 });
		await so.setLayerRange({ minY: 0, maxY: 1 });
		await so.setLayerRange({ minY: 0, maxY: 2 });
		expect(asked).toHaveLength(2);
		so.gridVersion++;
		await so.setLayerRange({ minY: 0, maxY: 2 });
		expect(asked).toHaveLength(3);
	});

	it("caps a block edit from the edited grid, a filter applied before its chunk is meshed again included", async () => {
		const { so, asked } = setup();
		// setBlock: the schematic's blocks change (blocksVersion) before the chunk is meshed and its cells written
		so.blocksVersion++;
		await so.setLayerRange({ minY: 0, maxY: 2 });
		expect(asked[asked.length - 1].apron).toEqual([0, 2, 0, 4]); // the grid has the old block yet
		// the chunk meshed again: (0, 2, 0) is palette 6 now
		so.writeCellGrid({ x: 0, y: 0, z: 0 }, [
			[0, 0, 0, 4],
			[1, 0, 0, 4],
			[0, 1, 0, 4],
			[0, 2, 0, 6],
		]);
		await so.setLayerRange({ minY: 0, maxY: 2 });
		expect(asked[asked.length - 1].apron).toEqual([0, 2, 0, 6]);
	});

	it("shows everything again, with no caps, for every layer and no hidden group", async () => {
		const { so, mesh, sign, caps } = setup();
		await so.setHiddenGroups([7]);
		await so.setLayerRange({ minY: 1, maxY: 2 });
		await so.setHiddenGroups(null);
		await so.setLayerRange({ minY: 0, maxY: 3 }); // every layer: the same as null
		expect(so.getLayerRange()).toBeNull();
		expect(caps()).toEqual([]);
		expect(sign.visible).toBe(true);
		expect(mesh.geometry.groups).toEqual([{ start: 0, count: 12, materialIndex: 0 }]);
	});

	it("frames the cells shown", async () => {
		const { so } = setup();
		await so.setHiddenGroups([7]);
		await so.setLayerRange({ minY: 0, maxY: 2 });
		const box = so.getTightWorldBox();
		expect([box.min.toArray(), box.max.toArray()]).toEqual([
			[-0.5, -0.5, -0.5],
			[0.5, 1.5, 0.5],
		]);
		expect(so.isCellShown(0, 1, 0)).toBe(true);
		expect(so.isCellShown(1, 0, 0)).toBe(false);
		expect(so.isCellShown(0, 2, 0)).toBe(false);
	});

	it("says it cannot when a mesh has no runs", async () => {
		const { so, mesh } = setup({ indexed: false });
		expect(so.canShowLayerRange()).toBe(false);
		expect(await so.setHiddenGroups([7])).toBe(false);
		expect(mesh.geometry.groups).toEqual([{ start: 0, count: 12, materialIndex: 0 }]);
	});
});

describe("the layer range a schematic is made with", () => {
	// a schematic 3 × 3 × 1 made hidden (so nothing is built), with the range given
	const made = (layerRange: { minY: number; maxY: number }) => {
		const box = { min: [0, 0, 0], max: [2, 2, 0] };
		const renderer: any = {
			options: {},
			worldMeshBuilder: {},
			eventEmitter: { emit() {} },
			sceneManager: { add() {} },
		};
		const wrapper = {
			get_bounding_box: () => box,
			get_dimensions: () => [3, 3, 1],
			get_tight_dimensions: () => [3, 3, 1],
		};
		const so = new SchematicObject(renderer, "s", wrapper as any, { visible: false, layerRange });
		so.dispose(); // its watcher timer
		return so as any;
	};

	it("is taken as setLayerRange takes it: whole layers within the schematic's, or none for all of them", () => {
		expect(made({ minY: 0, maxY: Infinity }).getLayerRange()).toBeNull();
		expect(made({ minY: -Infinity, maxY: 3 }).getLayerRange()).toBeNull();
		expect(made({ minY: 0.5, maxY: 3 }).getLayerRange()).toBeNull();
		expect(made({ minY: 1, maxY: Infinity }).getLayerRange()).toEqual({ minY: 1, maxY: 3 });
		expect(made({ minY: 0.5, maxY: 1.5 }).getLayerRange()).toEqual({ minY: 0, maxY: 2 });
	});

	it("frames the cells shown in a range open at the top", () => {
		const so = made({ minY: 1, maxY: Infinity });
		Object.assign(so, {
			disposed: false,
			cellGrid: Uint16Array.from([0, 0, 0, 5, 0, 0, 5, 0, 0]),
			cellGridBox: { min: [0, 0, 0], max: [2, 2, 0] },
		});
		so.group.position.set(0, 0, 0); // schematic coordinates
		const box = so.getTightWorldBox();
		expect([box.min.toArray(), box.max.toArray()]).toEqual([
			[-0.5, 0.5, -0.5],
			[0.5, 2.5, 0.5],
		]);
	});
});

describe("a filter applied while the schematic is hidden", () => {
	it("leaves the objects and caps it shows visible, for when the schematic is shown again", async () => {
		const { so, sign } = setup();
		delete so.applyPropertiesToObjects; // the schematic's own, which sets up the caps
		Object.assign(so, { opacity: 1, visible: false });
		so.group.visible = false;
		await so.setHiddenGroups([7]);
		await so.setHiddenGroups(null);
		await so.setLayerRange({ minY: 0, maxY: 2 });
		expect(sign.visible).toBe(true);
		const caps = so.group.children.filter((c: THREE.Object3D) => c.userData.layerCap);
		expect(caps).toHaveLength(1);
		expect(caps[0].visible).toBe(true);
	});
});

describe("a filter call still building its caps", () => {
	it("leaves what is shown, framed and picked as it was until its caps are ready", async () => {
		const { so, mesh, caps, hold } = setup();
		await so.setHiddenGroups([7]);
		const shown = [...mesh.geometry.groups];
		const release = hold();
		const call = so.setLayerRange({ minY: 0, maxY: 1 });
		expect(so.getLayerRange()).toEqual({ minY: 0, maxY: 1 }); // what was asked for
		expect(so.isCellShown(0, 2, 0)).toBe(true);
		expect(so.getTightWorldBox().max.y).toBe(2.5);
		expect(mesh.geometry.groups).toEqual(shown);
		release();
		expect(await call).toBe(true);
		expect(so.isCellShown(0, 2, 0)).toBe(false);
		expect(so.getTightWorldBox().max.y).toBe(0.5);
		expect(caps()).toHaveLength(1);
	});

	it("adds no caps of the old blocks once a rebuild has started", async () => {
		const { so, caps, hold } = setup();
		Object.assign(so, {
			sceneManager: { schematicRenderer: { options: {} } },
			chunkMeshes: new Map(),
			visible: false, // the rebuild only clears the meshes
		});
		const release = hold();
		const call = so.setLayerRange({ minY: 0, maxY: 2 });
		const rebuild = so.rebuildMesh();
		release();
		await call;
		await rebuild;
		expect(caps()).toEqual([]);
	});

	it("adds nothing once the schematic is removed", async () => {
		const { so, caps, hold } = setup();
		Object.assign(so, { chunkMeshes: new Map(), builds: Promise.resolve() });
		const release = hold();
		const call = so.setLayerRange({ minY: 0, maxY: 2 });
		so.dispose();
		release();
		expect(await call).toBe(false);
		expect(caps()).toEqual([]);
	});
});

describe("the caps kept for going back to a filter", () => {
	it("stay within their budget, the least recently used dropped first, and off the GPU while not shown", async () => {
		const { so } = setup();
		const budget = SchematicObject.CAPS_CACHE_BYTES;
		SchematicObject.CAPS_CACHE_BYTES = 1000;
		try {
			// each filter's caps: 400 bytes of positions
			so.worldMeshBuilder.buildCaps = async () => {
				const geometry = new THREE.BufferGeometry();
				geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(100), 3));
				return [new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())];
			};
			const capOf = () => so.shownCaps[0] as THREE.Mesh;
			await so.setLayerRange({ minY: 0, maxY: 1 });
			const first = capOf();
			const offGpu = vi.spyOn(first.geometry, "dispose");
			await so.setLayerRange({ minY: 0, maxY: 2 });
			expect(offGpu).toHaveBeenCalledTimes(1); // not shown: its buffers go, its arrays stay
			expect(so.capsCache.size).toBe(2);
			await so.setLayerRange({ minY: 0, maxY: 1 }); // the first again, from the cache
			expect(capOf()).toBe(first);
			await so.setLayerRange({ minY: 1, maxY: 2 }); // 1200 bytes: the least recently used goes
			expect([...so.capsCache.keys()].map((k: string) => k.split("|")[1])).toEqual(["0-1", "1-2"]);
		} finally {
			SchematicObject.CAPS_CACHE_BYTES = budget;
		}
	});
});

describe("building caps", () => {
	it("puts a hidden cell in a piece's apron once, however many of its cells it borders", async () => {
		const { so, asked } = setup();
		so.cellGrid[4] = 5; // a block at (1, 1, 0), above the hidden (1, 0, 0) and beside (0, 1, 0)
		await so.setHiddenGroups([7]);
		expect(asked).toHaveLength(1);
		expect(asked[0].apron).toEqual([1, 0, 0, 4]);
		expect(asked[0].blocks).toEqual([0, 0, 0, 4, 1, 1, 0, 4]);
	});

	it("builds a filter's caps once for two calls for it back to back", async () => {
		const { so, asked, hold } = setup();
		const release = hold();
		const calls = [so.setLayerRange({ minY: 0, maxY: 2 }), so.setLayerRange({ minY: 0, maxY: 2 })];
		release();
		expect(await Promise.all(calls)).toEqual([true, true]);
		expect(asked).toHaveLength(1);
	});

	it("keeps the key of what is shown until the filter or the grid changes", async () => {
		const { so } = setup();
		await so.setLayerRange({ minY: 0, maxY: 2 });
		const key = so.cellFilterKey();
		const sort = vi.spyOn(Array.prototype, "sort");
		expect(so.cellFilterKey()).toBe(key);
		expect(sort).not.toHaveBeenCalled();
		sort.mockRestore();
		so.gridVersion++;
		expect(so.cellFilterKey()).not.toBe(key);
	});
});
