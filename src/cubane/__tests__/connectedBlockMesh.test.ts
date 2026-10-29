import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { Cubane } from "../Cubane";
import type { BlockModel } from "../types";
import type { NeighborState } from "../ConnectedTextures";
import { formatBlockString } from "../blockString";

// Cubane.getConnectedBlockMesh against a pack of a few models: which tile each connecting face takes
// (userData.connections: model, element, face, then the tile, x for a culled face or - for a face
// kept as it is) and which faces are culled.
// BlockMeshBuilder is replaced by a recorder of the models it is handed.
function withPack(files: Record<string, unknown>) {
	const c = new Cubane({ autoRestore: false });
	const internals = c as unknown as {
		initialized: boolean;
		assetLoader: { getResourceString: (path: string) => Promise<string | undefined> };
		blockMeshBuilder: { createBlockMesh: (model: BlockModel) => Promise<THREE.Object3D> };
	};
	internals.initialized = true;
	const reads: string[] = [];
	internals.assetLoader.getResourceString = async (path) => {
		reads.push(path);
		return path in files ? JSON.stringify(files[path]) : undefined;
	};
	const drawn: BlockModel[] = [];
	internals.blockMeshBuilder.createBlockMesh = async (model) => {
		drawn.push(model);
		return new THREE.Group();
	};
	return { c, reads, drawn };
}

const cube = (texture = "#all"): BlockModel => ({
	textures: { all: "minecraft:block/frame_glass" },
	elements: [
		{
			from: [0, 0, 0],
			to: [16, 16, 16],
			faces: Object.fromEntries(
				(["down", "up", "north", "south", "west", "east"] as const).map((d) => [
					d,
					{ texture, cullface: d },
				])
			),
		},
	],
});
const connecting = { fusion: { type: "connecting", layout: "full" } };

const pack = (variants: Record<string, unknown>, model: BlockModel = cube()) => ({
	"blockstates/minecraft:frame_glass.json": { variants },
	"models/minecraft:block/frame_glass.json": model,
	"textures/block/frame_glass.png.mcmeta": connecting,
});

const GLASS = "minecraft:frame_glass";

// the same block in the same state at each of `offsets`, air elsewhere
const around =
	(state: NeighborState, ...offsets: [number, number, number][]) =>
	(dx: number, dy: number, dz: number): NeighborState | null =>
		offsets.some(([x, y, z]) => x === dx && y === dy && z === dz) ? state : null;

// model face -> its tile ("tx,ty") or "x" when culled, from the mesh's userData.connections
const tiles = (mesh: THREE.Object3D | null): Record<string, string> =>
	Object.fromEntries(
		String(mesh?.userData.connections ?? "")
			.split(";")
			.filter(Boolean)
			.map((part) => {
				const m = /^\d+\.\d+(down|up|north|south|west|east)(.*)$/.exec(part)!;
				return [m[1], m[2]];
			})
	);

// the full layout's tiles for one connection on the texture's side
const TOP = "0,3";
const BOTTOM = "0,1";
const RIGHT = "1,0";
const LEFT = "3,0";

describe("connected tiles on turned models", () => {
	const variants = {
		"facing=north": { model: "minecraft:block/frame_glass" },
		"facing=east": { model: "minecraft:block/frame_glass", y: 90 },
		"facing=west": { model: "minecraft:block/frame_glass", y: 90, uvlock: true },
		"facing=up": { model: "minecraft:block/frame_glass", x: 90 },
		"facing=down": { model: "minecraft:block/frame_glass", x: 90, y: 90 },
	};
	const at = async (facing: string, ...offsets: [number, number, number][]) => {
		const { c } = withPack(pack(variants));
		const state = { name: GLASS, properties: { facing } };
		return tiles(
			await c.getConnectedBlockMesh(
				`${GLASS}[facing=${facing}]`,
				"plains",
				around(state, ...offsets)
			)
		);
	};

	it("reads a y-turned model's top and bottom in the frame the texture is drawn in", async () => {
		// y=90 turns the top's texture with the model: its up points east, so a block to the east is above it
		const east = await at("east", [1, 0, 0]);
		expect(east.up).toBe(TOP);
		expect(east.down).toBe(BOTTOM);
		// the model's west face, now on the north side, has the block on its left as before
		expect(east.west).toBe(LEFT);
		expect(east.north).toBe("x"); // turned to face east, against the block there
		// the mesher draws uvlock the same way (it is not given the rotation), so the tiles follow it
		expect(await at("west", [1, 0, 0])).toEqual(east);
	});

	it("reads an x-turned model (a pillar on its side) the same way", async () => {
		// x=90: the model's top faces north with its texture upside down, so the block above is below
		// it, and its sides have their texture's up pointing north: the block above is to one side
		const z = await at("up", [0, 1, 0]);
		expect(z.up).toBe(BOTTOM);
		expect(z.down).toBe(TOP);
		expect(z.east).toBe(LEFT);
		expect(z.west).toBe(RIGHT);
		expect(z.south).toBe("x"); // now the top, against the block above
		// x=90 then y=90: the model's top faces east, its east side south and its west side north
		const x = await at("down", [0, 1, 0]);
		expect(x.up).toBe(BOTTOM);
		expect(x.east).toBe(LEFT);
		expect(x.west).toBe(RIGHT);
		expect(x.south).toBe("x");
	});

	it("turns the tile with a face's own rotation", async () => {
		const model = cube();
		model.elements![0].faces!.up!.rotation = 90;
		const { c } = withPack(pack({ "": { model: "minecraft:block/frame_glass" } }, model));
		// turned a quarter clockwise, the top's texture has its up pointing east
		const mesh = await c.getConnectedBlockMesh(
			GLASS,
			"plains",
			around({ name: GLASS, properties: {} }, [1, 0, 0])
		);
		expect(tiles(mesh).up).toBe(TOP);
		expect(tiles(mesh).down).toBe(RIGHT);
	});
});

describe("culling a connected block's faces", () => {
	const slab = (from: number, to: number): BlockModel => {
		const model = cube();
		model.elements![0].from = [0, from, 0];
		model.elements![0].to = [16, to, 16];
		// as vanilla's slab models: the face inside the block has no cullface
		delete model.elements![0].faces![from === 0 ? "up" : "down"]!.cullface;
		return model;
	};
	const files = {
		"blockstates/minecraft:frame_glass.json": {
			variants: {
				"type=bottom": { model: "minecraft:block/frame_glass_bottom" },
				"type=top": { model: "minecraft:block/frame_glass_top" },
				"type=double": { model: "minecraft:block/frame_glass" },
			},
		},
		"models/minecraft:block/frame_glass_bottom.json": slab(0, 8),
		"models/minecraft:block/frame_glass_top.json": slab(8, 16),
		"models/minecraft:block/frame_glass.json": cube(),
		"textures/block/frame_glass.png.mcmeta": connecting,
	};
	const slabState = (type: string): NeighborState => ({ name: GLASS, properties: { type } });
	const bottomSlabBeside = async (type: string) => {
		const { c } = withPack(files);
		const mesh = await c.getConnectedBlockMesh(
			`${GLASS}[type=bottom]`,
			"plains",
			around(slabState(type), [0, 0, -1])
		);
		return tiles(mesh).north;
	};

	it("keeps a bottom slab's side beside a top slab of the same block", async () => {
		expect(await bottomSlabBeside("top")).not.toBe("x");
		// a whole face against it hides it
		expect(await bottomSlabBeside("double")).toBe("x");
	});

	it("keeps a face against another block, and drops one under a whole face of the same block", async () => {
		const { c } = withPack(files);
		const stone = { name: "minecraft:stone", properties: {} };
		const mesh = await c.getConnectedBlockMesh(
			`${GLASS}[type=double]`,
			"plains",
			around(stone, [0, 0, -1])
		);
		expect(tiles(mesh).north).not.toBe("x");
		// the double slab's top against a bottom slab above: the slab's underside is whole, so it hides it
		const above = await c.getConnectedBlockMesh(
			`${GLASS}[type=double]`,
			"plains",
			around(slabState("bottom"), [0, 1, 0])
		);
		expect(tiles(above).up).toBe("x");
	});
});

describe("a connected block at many positions", () => {
	it("reads its models and textures once, and builds a mesh once per neighbourhood", async () => {
		const { c, drawn } = withPack(pack({ "": { model: "minecraft:block/frame_glass" } }));
		const internals = c as unknown as {
			modelResolver: { resolveBlockModel: (...args: unknown[]) => Promise<unknown> };
			assetLoader: { getConnectingTexture: (...args: unknown[]) => Promise<unknown> };
		};
		const count = { resolve: 0, texture: 0 };
		const resolve = internals.modelResolver.resolveBlockModel.bind(internals.modelResolver);
		internals.modelResolver.resolveBlockModel = (...args) => (count.resolve++, resolve(...args));
		const texture = internals.assetLoader.getConnectingTexture.bind(internals.assetLoader);
		internals.assetLoader.getConnectingTexture = (...args) => (count.texture++, texture(...args));

		const glass = { name: GLASS, properties: {} };
		expect(await c.isConnectingBlock(GLASS)).toBe(true);
		const first = await c.getConnectedBlockMesh(GLASS, "plains", around(glass, [1, 0, 0]));
		const again = await c.getConnectedBlockMesh(GLASS, "plains", around(glass, [1, 0, 0]));
		const other = await c.getConnectedBlockMesh(GLASS, "plains", around(glass, [0, 1, 0]));
		expect(again?.userData.connections).toBe(first?.userData.connections);
		expect(other?.userData.connections).not.toBe(first?.userData.connections);
		expect(count).toEqual({ resolve: 1, texture: 6 }); // one look per face, the first time
		expect(drawn).toHaveLength(2); // the second position took the first's mesh
	});
});

describe("the mesh cache of a connected block made of several models", () => {
	it("tells apart two models whose faces have the same element and name", async () => {
		// two copies of one model, the second turned to face east, whose sides are cull-only (a texture that does
		// not connect), and a third model with a connecting face, so the block takes the connected path
		const wall: BlockModel = {
			textures: { plain: "minecraft:block/stone" },
			elements: [
				{
					from: [0, 0, 0],
					to: [16, 16, 16],
					faces: {
						north: { texture: "#plain", cullface: "north" },
						south: { texture: "#plain", cullface: "south" },
					},
				},
			],
		};
		const core: BlockModel = {
			textures: { all: "minecraft:block/frame_glass" },
			connections: { type: "false" },
			elements: [{ from: [4, 4, 4], to: [12, 12, 12], faces: { down: { texture: "#all" } } }],
		} as BlockModel;
		const { c, drawn } = withPack({
			"blockstates/minecraft:frame_glass.json": {
				multipart: [
					{ apply: { model: "minecraft:block/wall" } },
					{ apply: { model: "minecraft:block/wall", y: 90 } },
					{ apply: { model: "minecraft:block/core" } },
				],
			},
			"models/minecraft:block/wall.json": wall,
			"models/minecraft:block/core.json": core,
			"textures/block/frame_glass.png.mcmeta": connecting,
		});
		const glass = { name: GLASS, properties: {} };
		const north = await c.getConnectedBlockMesh(GLASS, "plains", around(glass, [0, 0, -1]));
		const east = await c.getConnectedBlockMesh(GLASS, "plains", around(glass, [1, 0, 0]));
		expect(east?.userData.connections).not.toBe(north?.userData.connections);
		// the east neighbour hides the turned copy's north face (now facing east), not the first copy's
		expect(drawn).toHaveLength(6);
		expect(Object.keys(drawn[3].elements![0].faces!)).toEqual(["north", "south"]);
		expect(Object.keys(drawn[4].elements![0].faces!)).toEqual(["south"]);
	});
});

describe("culling a connected pane's faces", () => {
	// as vanilla's glass pane: a post 2 px thick, and arms from it to the north side (side, turned for the east)
	// and to the south side (side_alt, turned for the west); the edges carry the cullfaces
	const edge = (uv: number[], cullface?: string) => ({ texture: "#all", uv, cullface });
	const files = {
		"blockstates/minecraft:frame_glass.json": {
			multipart: [
				{ apply: { model: "minecraft:block/frame_glass_post" } },
				{ when: { north: "true" }, apply: { model: "minecraft:block/frame_glass_side" } },
				{ when: { east: "true" }, apply: { model: "minecraft:block/frame_glass_side", y: 90 } },
				{ when: { south: "true" }, apply: { model: "minecraft:block/frame_glass_side_alt" } },
				{ when: { west: "true" }, apply: { model: "minecraft:block/frame_glass_side_alt", y: 90 } },
			],
		},
		"models/minecraft:block/frame_glass_post.json": {
			textures: { all: "minecraft:block/frame_glass" },
			elements: [
				{
					from: [7, 0, 7],
					to: [9, 16, 9],
					faces: { down: edge([7, 7, 9, 9], "down"), up: edge([7, 7, 9, 9], "up") },
				},
			],
		},
		"models/minecraft:block/frame_glass_side.json": {
			textures: { all: "minecraft:block/frame_glass" },
			elements: [
				{
					from: [7, 0, 0],
					to: [9, 16, 7],
					faces: {
						down: edge([7, 0, 9, 7], "down"),
						up: edge([7, 0, 9, 7], "up"),
						north: edge([7, 0, 9, 16], "north"),
						west: edge([16, 0, 9, 16]),
						east: edge([9, 0, 16, 16]),
					},
				},
			],
		},
		"models/minecraft:block/frame_glass_side_alt.json": {
			textures: { all: "minecraft:block/frame_glass" },
			elements: [
				{
					from: [7, 0, 9],
					to: [9, 16, 16],
					faces: {
						down: edge([7, 9, 9, 16], "down"),
						up: edge([7, 9, 9, 16], "up"),
						south: edge([7, 0, 9, 16], "south"),
						west: edge([7, 0, 0, 16]),
						east: edge([0, 0, 7, 16]),
					},
				},
			],
		},
		"textures/block/frame_glass.png.mcmeta": connecting,
	};
	const pane = (...arms: string[]): NeighborState => ({
		name: GLASS,
		properties: Object.fromEntries(
			["north", "east", "south", "west"].map((d) => [d, String(arms.includes(d))])
		),
	});
	const key = (p: NeighborState) => formatBlockString(p.name, p.properties);
	// "model.element face" -> what became of it, from the mesh's userData.connections
	const faces = (mesh: THREE.Object3D | null): Record<string, string> =>
		Object.fromEntries(
			String(mesh?.userData.connections ?? "")
				.split(";")
				.map((part) => /^(\d+\.\d+(?:down|up|north|south|west|east))(.*)$/.exec(part)!)
				.map((m) => [m[1], m[2]])
		);
	const meshOf = async (
		self: NeighborState,
		at: (dx: number, dy: number, dz: number) => NeighborState | null
	) => {
		const { c } = withPack(files);
		return faces(await c.getConnectedBlockMesh(key(self), "plains", at));
	};

	it("drops the post's and the arms' ends between panes stacked on each other", async () => {
		const ns = pane("north", "south");
		const f = await meshOf(ns, around(ns, [0, 1, 0], [0, -1, 0]));
		for (const m of ["0.0", "1.0", "2.0"]) {
			expect(f[`${m}up`]).toBe("x");
			expect(f[`${m}down`]).toBe("x");
		}
		// the arms' outer ends face the open sides
		expect(f["1.0north"]).not.toBe("x");
		expect(f["2.0south"]).not.toBe("x");
	});

	it("keeps an arm's end where the pane above has no arm over it", async () => {
		const f = await meshOf(pane("north", "south"), around(pane("east", "west"), [0, 1, 0]));
		expect(f["0.0up"]).toBe("x"); // the post's top, under the other post
		expect(f["1.0up"]).not.toBe("x");
		expect(f["2.0up"]).not.toBe("x");
	});

	it("drops the ends of two arms joined across a side, turned or not", async () => {
		const e = pane("east");
		const w = pane("west");
		// the east arm (side, y=90) against the west arm (side_alt, y=90) of the pane to the east
		const east = await meshOf(e, (dx, dy, dz) => (dx === 1 && dy === 0 && dz === 0 ? w : null));
		expect(east["1.0north"]).toBe("x");
		// and the other way round
		const west = await meshOf(w, (dx, dy, dz) => (dx === -1 && dy === 0 && dz === 0 ? e : null));
		expect(west["1.0south"]).toBe("x");
		// a pane to the east with no arm toward it leaves the end showing
		const open = await meshOf(e, (dx, dy, dz) =>
			dx === 1 && dy === 0 && dz === 0 ? pane("north") : null
		);
		expect(open["1.0north"]).not.toBe("x");
	});
});

describe("a connected block's mesh across a pack switch", () => {
	it("is not kept when the caches were cleared while it was built", async () => {
		const { c } = withPack(pack({ "": { model: "minecraft:block/frame_glass" } }));
		const internals = c as unknown as {
			blockMeshBuilder: { createBlockMesh: (model: BlockModel) => Promise<THREE.Object3D> };
			connectedMeshCache: Map<string, THREE.Object3D>;
		};
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		internals.blockMeshBuilder.createBlockMesh = async () => (await gate, new THREE.Group());
		const glass = { name: GLASS, properties: {} };
		const building = c.getConnectedBlockMesh(GLASS, "plains", around(glass, [1, 0, 0]));
		// let it read the block and start building, then switch packs under it
		await new Promise((resolve) => setTimeout(resolve, 0));
		c.clearMeshCaches();
		release();
		expect(await building).not.toBeNull(); // the caller still gets its mesh
		expect(internals.connectedMeshCache.size).toBe(0);
	});
});

describe("a connected block's faces against other blocks", () => {
	// the culling the meshers use (workers/faceCulling.ts): an opaque full side hides any face against it
	const stone = {
		name: "minecraft:stone",
		properties: {},
		cull: { occlusionFlags: 63, cullKey: "solid", fluid: 0 },
	};
	const leaves = {
		name: "minecraft:oak_leaves",
		properties: {},
		cull: { occlusionFlags: 0, cullKey: "minecraft:oak_leaves", fluid: 0 },
	};
	const at = async (neighbour: NeighborState) => {
		const { c } = withPack(pack({ "": { model: "minecraft:block/frame_glass" } }));
		const east = (dx: number, dy: number, dz: number) =>
			dx === 1 && dy === 0 && dz === 0 ? neighbour : null;
		return tiles(await c.getConnectedBlockMesh(GLASS, "plains", east));
	};

	it("hides the face against an opaque block, as the meshers do", async () => {
		// only the same block hid it, and the face was drawn inside the stone
		expect((await at(stone)).east).toBe("x");
	});

	it("keeps the face against a see-through block", async () => {
		expect((await at(leaves)).east).not.toBe("x");
	});
});
