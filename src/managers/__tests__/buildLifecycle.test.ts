import { describe, it, expect, vi, afterEach } from "vitest";
import * as THREE from "three";

vi.mock("nucleation", () => ({ default: vi.fn(), SchematicWrapper: class {} }));

import { SchematicObject } from "../SchematicObject";
import { MaterialRegistry } from "../../MaterialRegistry";
import { performanceMonitor } from "../../performance/PerformanceMonitor";

// A schematic's builds on a stand-in: a batched build of one chunk whose mesher answers when the test says so, so
// the schematic can be removed (disposed) while it is in flight.
function setup() {
	const answers: Array<(meshes: THREE.Object3D[]) => void> = [];
	const onSchematicRendered = vi.fn();
	const emit = vi.fn();
	const renderer: any = {
		options: { meshBuildingMode: "batched", callbacks: { onSchematicRendered } },
		renderManager: { render() {} },
		invalidate() {},
	};
	const so = Object.create(SchematicObject.prototype) as any;
	Object.assign(so, {
		fadedMaterials: new Map(),
		baseMaterials: new WeakMap(),
		id: "s",
		name: "s",
		visible: true,
		disposed: false,
		ownsWrapper: true,
		opacity: 1,
		meshes: [],
		chunkMeshes: new Map(),
		chunkDimensions: { chunkWidth: 16, chunkHeight: 16, chunkLength: 16 },
		group: new THREE.Group(),
		position: new THREE.Vector3(),
		rotation: new THREE.Euler(),
		scale: new THREE.Vector3(1, 1, 1),
		renderingBounds: { enabled: false },
		cellFilter: { range: null, hidden: null },
		shownCaps: [],
		capsCache: new Map(),
		capsPending: new Map(),
		filterCall: 0,
		cellGrid: null,
		cellGridBox: null,
		blockEntitiesMap: null,
		_propertyWatcherTimer: null,
		builds: Promise.resolve(),
		unbuilt: false,
		progressBuilds: 0,
		schematicRenderer: renderer,
		sceneManager: { schematicRenderer: renderer },
		eventEmitter: { emit },
		schematicWrapper: {
			free: vi.fn(),
			get_all_palettes: () => ({ default: [] }),
			get_bounding_box: () => ({ min: [0, 0, 0], max: [0, 0, 0] }),
			get_chunk_blocks_indices: () => [],
			create_lazy_chunk_iterator: () => {
				let left = 1;
				return {
					total_chunks: () => 1,
					has_next: () => left > 0,
					next: () =>
						left-- > 0
							? { chunk_x: 0, chunk_y: 0, chunk_z: 0, blocks: new Int32Array([0, 0, 0, 1]) }
							: null,
				};
			},
		},
		worldMeshBuilder: {
			precomputePaletteGeometries: async () => {},
			getPaletteSize: () => 2,
			airPaletteIndices: () => new Set<number>(),
			processChunksBatched: () => new Promise((res) => answers.push(res)),
			buildSignMeshes: async () => [],
		},
	});
	const mesh = () => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
	// the next answer of the mesher, once the build has asked for it
	const answer = async (meshes: THREE.Object3D[]) => {
		await vi.waitFor(() => expect(answers.length).toBeGreaterThan(0));
		answers.shift()!(meshes);
	};
	return { so, renderer, onSchematicRendered, emit, mesh, answer };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a schematic removed while it builds", () => {
	it("stops its build, lets go of what was built and reports nothing", async () => {
		const { so, onSchematicRendered, emit, mesh, answer } = setup();
		const events: string[] = [];
		const onEvent = (e: Event) => events.push(e.type);
		window.addEventListener("schematicRenderComplete", onEvent);
		try {
			const build = (so.meshesReady = so.track(so.buildMeshes()));
			so.dispose();
			const built = mesh();
			const disposeGeometry = vi.spyOn(built.geometry, "dispose");
			await answer([built]);
			await build;
			// the batched build reports a little after it is done
			await new Promise((res) => setTimeout(res, 150));
			expect(so.group.children).toEqual([]);
			expect(disposeGeometry).toHaveBeenCalled();
			expect(onSchematicRendered).not.toHaveBeenCalled();
			expect(emit).not.toHaveBeenCalledWith("schematicRendered", expect.anything());
			expect(events).toEqual([]);
		} finally {
			window.removeEventListener("schematicRenderComplete", onEvent);
		}
	});

	it("reports a build that is not stopped", async () => {
		const { so, onSchematicRendered, emit, mesh, answer } = setup();
		const events: string[] = [];
		const onEvent = (e: Event) => events.push(e.type);
		window.addEventListener("schematicRenderComplete", onEvent);
		try {
			const build = (so.meshesReady = so.track(so.buildMeshes()));
			await answer([mesh()]);
			await build;
			await new Promise((res) => setTimeout(res, 150));
			expect(so.group.children).toHaveLength(1);
			expect(onSchematicRendered).toHaveBeenCalledWith("s");
			expect(emit).toHaveBeenCalledWith("schematicRendered", { id: "s", name: "s" });
			expect(events.length).toBeGreaterThan(0);
		} finally {
			window.removeEventListener("schematicRenderComplete", onEvent);
		}
	});
});

describe("a build that fails", () => {
	it("is logged with the schematic's name and reported by an event, awaited or not", async () => {
		const { so, emit } = setup();
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const failure = new Error("mesher failed");
		so.worldMeshBuilder.processChunksBatched = async () => {
			throw failure;
		};
		so.meshesReady = so.track(so.buildMeshes());
		await so.builds;
		expect(log).toHaveBeenCalledWith(expect.stringContaining('"s"'), failure);
		expect(emit).toHaveBeenCalledWith("schematicRenderError", {
			id: "s",
			name: "s",
			error: failure,
		});
		await expect(so.meshesReady).rejects.toBe(failure);
	});

	it("leaves no operation of its own open in the performance monitor", async () => {
		const { so } = setup();
		vi.spyOn(console, "error").mockImplementation(() => {});
		so.worldMeshBuilder.processChunksBatched = async () => {
			throw new Error("mesher failed");
		};
		await expect(so.rebuildMesh()).rejects.toThrow("mesher failed");
		const open = (performanceMonitor as any).timingStack.map((op: { name: string }) => op.name);
		expect(open).toEqual([]);
	});

	it("is not reported once the schematic is removed", async () => {
		const { so, emit } = setup();
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		so.worldMeshBuilder.processChunksBatched = async () => {
			so.dispose();
			throw new Error("freed");
		};
		so.meshesReady = so.track(so.buildMeshes());
		await so.builds;
		expect(log).not.toHaveBeenCalled();
		expect(emit).not.toHaveBeenCalledWith("schematicRenderError", expect.anything());
		await expect(so.meshesReady).rejects.toThrow("freed");
	});
});

describe("a schematic's WASM schematic", () => {
	it("is freed only once every build is over, a rebuild started after the first build included", async () => {
		const { so, mesh, answer } = setup();
		so.meshesReady = so.track(so.buildMeshes());
		await answer([mesh()]);
		await so.meshesReady;
		const rebuild = so.rebuildMesh();
		so.dispose();
		await new Promise((res) => setTimeout(res, 0));
		expect(so.schematicWrapper.free).not.toHaveBeenCalled();
		await answer([mesh()]);
		await rebuild;
		await new Promise((res) => setTimeout(res, 0));
		expect(so.schematicWrapper.free).toHaveBeenCalledTimes(1);
	});

	it("is not read by a rebuild, chunk rebuild or regrouping asked for after removal", async () => {
		const { so, mesh } = setup();
		so.dispose();
		const read = vi.spyOn(so.schematicWrapper, "create_lazy_chunk_iterator");
		so.schematicWrapper.getChunkData = vi.fn();
		so.meshes = [mesh()];
		await so.rebuildMesh();
		await so.updateMesh();
		await so.rebuildChunk(0, 0, 0);
		await so.setCellGroups(new Uint16Array(1));
		expect(read).not.toHaveBeenCalled();
		expect(so.schematicWrapper.getChunkData).not.toHaveBeenCalled();
	});
});

describe("a rebuild", () => {
	it("gives back the material references of the connected-texture meshes it replaces", async () => {
		const { so } = setup();
		so.visible = false; // the old meshes go; nothing is built again
		const material = MaterialRegistry.getMaterial(
			new THREE.MeshLambertMaterial({ color: 0x123403 })
		);
		const dispose = vi.spyOn(material, "dispose");
		const connected = new THREE.Mesh(new THREE.BoxGeometry(), [material]);
		connected.userData.holdsMaterialRefs = true;
		so.group.add(connected);
		so.meshes = [connected];
		await so.rebuildMesh();
		expect(MaterialRegistry.isShared(material)).toBe(false);
		expect(dispose).toHaveBeenCalledTimes(1);
	});
});

describe("a hidden schematic", () => {
	it("is not built until it is shown, and is built once then", async () => {
		const { so, mesh, answer } = setup();
		const mesher = vi.spyOn(so.worldMeshBuilder, "processChunksBatched");
		so.visible = false;
		so.meshesReady = so.track(so.buildMeshes());
		await so.meshesReady;
		expect(mesher).not.toHaveBeenCalled();
		so.visible = true;
		so.updateMeshVisibility();
		so.updateMeshVisibility(); // shown again: no second build
		const meshes = so.getMeshes();
		await answer([mesh()]);
		expect(await meshes).toHaveLength(1);
		expect(mesher).toHaveBeenCalledTimes(1);
	});

	it("rebuilt while hidden is built once it is shown, even between two checks of its properties", async () => {
		vi.useFakeTimers();
		try {
			const { so, mesh, answer } = setup();
			so.meshesReady = so.track(so.buildMeshes());
			await vi.advanceTimersByTimeAsync(0);
			await answer([mesh()]);
			await so.meshesReady;
			so.setupPropertyWatchers();
			so.visible = false;
			await so.rebuildMesh();
			expect(so.group.children).toEqual([]);
			// an edit meanwhile is meshed by the build made when it is shown, not by a chunk mesh of its own
			so.schematicWrapper.getChunkData = vi.fn();
			await so.rebuildChunk(0, 0, 0);
			expect(so.schematicWrapper.getChunkData).not.toHaveBeenCalled();
			so.visible = true;
			await vi.advanceTimersByTimeAsync(300);
			await answer([mesh()]);
			expect(await so.getMeshes()).toHaveLength(1);
			so.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("the progress bar a build shows", () => {
	// a progress bar on the renderer that says whether it is shown
	function withBar(renderer: any) {
		const bar = { shown: false };
		renderer.options.enableProgressBar = true;
		renderer.uiManager = {
			showProgressBar: () => (bar.shown = true),
			hideProgressBar: () => (bar.shown = false),
			isProgressBarVisible: () => bar.shown,
			updateProgress() {},
		};
		return bar;
	}
	// a second schematic drawn by the same renderer
	function sharing(renderer: any) {
		const other = setup();
		other.so.schematicRenderer = renderer;
		other.so.sceneManager = { schematicRenderer: renderer };
		return other;
	}

	it("goes once a build stopped by removal ends", async () => {
		const { so, renderer, mesh, answer } = setup();
		const bar = withBar(renderer);
		const build = so.track(so.buildMeshes());
		await vi.waitFor(() => expect(bar.shown).toBe(true));
		so.dispose();
		await answer([mesh()]);
		await build;
		expect(bar.shown).toBe(false);
	});

	it("goes once a build that failed ends", async () => {
		const { so, renderer } = setup();
		const bar = withBar(renderer);
		so.worldMeshBuilder.processChunksBatched = async () => {
			throw new Error("mesher failed");
		};
		await expect(so.rebuildMesh()).rejects.toThrow("mesher failed");
		expect(bar.shown).toBe(false);
	});

	it("stays while another schematic's build still shows it", async () => {
		const first = setup();
		const bar = withBar(first.renderer);
		const second = sharing(first.renderer);
		const firstBuild = first.so.track(first.so.buildMeshes());
		const secondBuild = second.so.track(second.so.buildMeshes());
		await vi.waitFor(() => expect(bar.shown).toBe(true));
		first.so.dispose();
		await first.answer([first.mesh()]);
		await firstBuild;
		expect(bar.shown).toBe(true);
		await second.answer([second.mesh()]);
		await secondBuild;
		expect(bar.shown).toBe(false);
	});

	it("stays while a rebuild of the same schematic still shows it", async () => {
		const { so, renderer, mesh, answer } = setup();
		const bar = withBar(renderer);
		const build = so.track(so.buildMeshes());
		const rebuild = so.rebuildMesh();
		await answer([mesh()]);
		await build;
		expect(bar.shown).toBe(true);
		await answer([mesh()]);
		await rebuild;
		expect(bar.shown).toBe(false);
	});
});

describe("a chunk rebuilt after a batched build", () => {
	it("takes its old faces out of the batch and its connected-texture meshes away", async () => {
		const { so, mesh, answer } = setup();
		// a batch of two chunks, a triangle each: chunk 0,0,0 has vertices 0-2, chunk 1,0,0 vertices 3-5
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(18), 3));
		geometry.setIndex([0, 1, 2, 3, 4, 5]);
		geometry.userData.batchChunks = {
			keys: new Map([
				["0,0,0", 0],
				["1,0,0", 1],
			]),
			ofVertex: Uint8Array.from([0, 0, 0, 1, 1, 1]),
		};
		const batch = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
		const connected = mesh();
		connected.userData.connectedChunk = "0,0,0";
		const otherConnected = mesh();
		otherConnected.userData.connectedChunk = "1,0,0";
		so.meshesReady = so.track(so.buildMeshes());
		await answer([batch, connected, otherConnected]);
		await so.meshesReady;

		const rebuilt = mesh();
		so.schematicWrapper.getChunkData = () => ({ blocks: [[0, 0, 0, 1]], entities: [] });
		so.worldMeshBuilder.getChunkMesh = async () => [rebuilt];
		so.renderingBounds = {
			enabled: false,
			min: new THREE.Vector3(0, 0, 0),
			max: new THREE.Vector3(32, 16, 16),
		};
		await so.rebuildChunk(0, 0, 0);

		expect(Array.from(geometry.index!.array)).toEqual([0, 0, 0, 3, 4, 5]);
		expect(so.group.children).toEqual([batch, otherConnected, rebuilt]);
		expect(so.chunkMeshes.get("batched")).toEqual([batch, otherConnected]);
		expect(so.chunkMeshes.get("0,0,0")).toEqual([rebuilt]);
		expect(so.meshes).not.toContain(connected);
	});
});
