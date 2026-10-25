import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { Cubane } from "../Cubane";
import type { BlockModel } from "../types";
import type { NeighborState } from "../ConnectedTextures";

// Cubane.getConnectedBlockMesh against a pack of a few models: which tile each connecting face takes
// (userData.connections: element, face, tile, or x for a culled face) and which faces are culled.
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
				const m = /^\d+(down|up|north|south|west|east)(.*)$/.exec(part)!;
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
