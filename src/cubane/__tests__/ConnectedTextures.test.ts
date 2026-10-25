import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { BlockMeshBuilder } from "../BlockMeshBuilder";
import type { AssetLoader } from "../AssetLoader";
import type { BlockModel } from "../types";
import {
	Connections,
	FACES,
	Face,
	NO_CONNECTIONS,
	NeighborState,
	faceConnections,
	faceTextureFrame,
	isFullSide,
	fullTile,
	fullSheetRepresentatives,
	parseConnectingMeta,
	parsePredicate,
	piecedQuarterTile,
	rotateFace,
	shouldConnect,
	simpleTile,
	tileFor,
} from "../ConnectedTextures";

const glass = (properties: Record<string, string> = {}): NeighborState => ({
	name: "connectedglass:scratched_glass_lime",
	properties,
});
const stone: NeighborState = { name: "minecraft:stone", properties: {} };
const ctx = (other: NeighborState | null, inFront: NeighborState | null = null) => ({
	self: glass(),
	other,
	inFront,
	direction: "top" as const,
});
const conn = (c: Partial<Connections>): Connections => ({ ...NO_CONNECTIONS, ...c });

describe("Fusion connecting texture metadata", () => {
	it("reads the layout, full by default, and ignores other textures", () => {
		expect(parseConnectingMeta({ fusion: { type: "connecting", layout: "pieced" } })).toEqual({
			layout: "pieced",
			connections: null,
		});
		expect(parseConnectingMeta({ fusion: { type: "fusion:connecting" } })?.layout).toBe("full");
		expect(parseConnectingMeta({ animation: { frametime: 2 } })).toBeNull();
	});
});

describe("connection predicates", () => {
	it("is_same_block and is_same_state", () => {
		expect(shouldConnect(parsePredicate({ type: "fusion:is_same_block" }), ctx(glass()))).toBe(
			true
		);
		expect(shouldConnect(parsePredicate({ type: "fusion:is_same_block" }), ctx(stone))).toBe(false);
		expect(shouldConnect(parsePredicate({ type: "fusion:is_same_block" }), ctx(null))).toBe(false);
		const sameState = parsePredicate({ type: "is_same_state" });
		expect(
			shouldConnect(sameState, { ...ctx(glass({ north: "true" })), self: glass({ north: "true" }) })
		).toBe(true);
		expect(
			shouldConnect(sameState, {
				...ctx(glass({ north: "false" })),
				self: glass({ north: "true" }),
			})
		).toBe(false);
	});

	it("match_block, match_state and is_direction, as Connected Glass's pane models use them", () => {
		// models/scratched_glass_lime_pane_side_north.json
		const pane = parsePredicate({
			type: "fusion:or",
			predicates: [
				{
					type: "fusion:match_state",
					block: "connectedglass:scratched_glass_lime_pane",
					properties: { north: ["true"] },
				},
				{
					type: "fusion:is_direction",
					directions: ["bottom_left", "bottom_right", "left", "right", "top_left", "top_right"],
				},
			],
		});
		const paneBlock = (north: string): NeighborState => ({
			name: "connectedglass:scratched_glass_lime_pane",
			properties: { north },
		});
		expect(shouldConnect(pane, { ...ctx(paneBlock("true")), direction: "top" })).toBe(true);
		expect(shouldConnect(pane, { ...ctx(paneBlock("false")), direction: "top" })).toBe(false);
		expect(shouldConnect(pane, { ...ctx(stone), direction: "left" })).toBe(true);
		expect(shouldConnect(pane, { ...ctx(null), direction: "bottom" })).toBe(false);
		expect(
			shouldConnect(
				parsePredicate({ type: "match_block", blocks: ["stone", "minecraft:dirt"] }),
				ctx(stone)
			)
		).toBe(true);
		expect(
			shouldConnect(
				parsePredicate({ type: "not", predicate: { type: "match_block", block: "stone" } }),
				ctx(stone)
			)
		).toBe(false);
		expect(shouldConnect(parsePredicate([{ type: "false" }, { type: "true" }]), ctx(null))).toBe(
			true
		);
		expect(
			shouldConnect(
				parsePredicate({ type: "and", predicates: [{ type: "true" }, { type: "false" }] }),
				ctx(null)
			)
		).toBe(false);
	});
});

describe("face connections", () => {
	// a 3 × 3 glass wall in the x/y plane at z = 0 with the centre missing: the block at
	// (0, 0) sees glass to its right and above, nothing left or below
	const wall = new Set(["1,0", "0,1", "1,1", "-1,1", "1,-1"]);
	const lookup = (x: number, y: number) => (dx: number, dy: number, dz: number) =>
		dz === 0 && wall.has(`${x + dx},${y + dy}`) ? glass() : null;

	it("reads the eight neighbours in the face's texture frame", () => {
		const south = faceConnections("south", { type: "is_same_block" }, glass(), lookup(0, 0));
		expect(south).toEqual(
			conn({ top: true, right: true, topRight: true, topLeft: true, bottomRight: true })
		);
		// seen from the north, left and right swap
		const north = faceConnections("north", { type: "is_same_block" }, glass(), lookup(0, 0));
		expect(north).toEqual(
			conn({ top: true, left: true, topLeft: true, topRight: true, bottomLeft: true })
		);
	});

	it("maps a model face to the world face under blockstate rotations", () => {
		expect(rotateFace("north", 0, 90)).toBe("east");
		expect(rotateFace("east", 0, 90)).toBe("south");
		expect(rotateFace("north", 0, 270)).toBe("west");
		expect(rotateFace("up", 90, 0)).toBe("north");
		expect(rotateFace("north", 90, 0)).toBe("down");
		expect(rotateFace("up", 0, 180)).toBe("up");
	});
});

// Where the texture of the one face of `model` points once BlockMeshBuilder has drawn it and the part
// has been turned by the blockstate as Cubane turns it: the world directions in which the texture's
// u grows (its right) and its v shrinks (its up), from the quad's corners.
async function drawnFrame(model: BlockModel, x: number, y: number, uvlock: boolean) {
	const assets = { resolveTexture: () => "block/glass", getTextureAtlas: () => null };
	const builder = new BlockMeshBuilder(assets as unknown as AssetLoader) as any;
	builder.createFaceMaterial = async () => new THREE.MeshBasicMaterial();
	const part: THREE.Object3D = await builder.createBlockMesh(model, { uvlock });
	if (y) part.rotateY(-(y * Math.PI) / 180);
	if (x) part.rotateX(-(x * Math.PI) / 180);
	part.updateMatrixWorld(true);
	const mesh = part.children[0] as THREE.Mesh;
	const pos = mesh.geometry.attributes.position;
	const uv = mesh.geometry.attributes.uv;
	const p = (i: number) =>
		new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
	// P = P0 + dPdu (u - u0) + dPdv (v - v0) across the quad
	const [d1, d2] = [p(1).sub(p(0)), p(2).sub(p(0))];
	const [du1, dv1] = [uv.getX(1) - uv.getX(0), uv.getY(1) - uv.getY(0)];
	const [du2, dv2] = [uv.getX(2) - uv.getX(0), uv.getY(2) - uv.getY(0)];
	const det = du1 * dv2 - du2 * dv1;
	const dPdu = d1.clone().multiplyScalar(dv2).addScaledVector(d2, -dv1).divideScalar(det);
	const dPdv = d2.clone().multiplyScalar(du1).addScaledVector(d1, -du2).divideScalar(det);
	const dir = (v: THREE.Vector3) => v.toArray().map((c) => Math.round(c / v.length()) + 0);
	// three's v runs up the texture: the mesher writes 1 - v
	return { up: dir(dPdv), right: dir(dPdu) };
}

describe("a face's texture frame", () => {
	it("is where BlockMeshBuilder draws the texture, for any rotation, uv, face rotation and uvlock", async () => {
		const mismatches: string[] = [];
		for (const face of FACES) {
			for (const uv of [
				[0, 0, 16, 16],
				[16, 0, 0, 16],
				[0, 16, 16, 0],
			] as [number, number, number, number][]) {
				for (const rotation of [0, 90, 180, 270]) {
					const model: BlockModel = {
						elements: [
							{
								from: [0, 0, 0],
								to: [16, 16, 16],
								faces: { [face]: { texture: "#all", uv, rotation } },
							},
						],
					};
					for (const x of [0, 90, 180, 270]) {
						for (const y of [0, 90, 180, 270]) {
							for (const uvlock of [false, true]) {
								const drawn = await drawnFrame(model, x, y, uvlock);
								const frame = faceTextureFrame(face, uv, rotation, x, y);
								if (JSON.stringify(drawn) !== JSON.stringify(frame)) {
									mismatches.push(`${face} uv=${uv} r=${rotation} x=${x} y=${y} uvlock=${uvlock}`);
								}
							}
						}
					}
				}
			}
		}
		expect(mismatches).toEqual([]);
	});

	it("is the face's default frame on an unturned model", () => {
		for (const face of FACES) {
			const { up, right } = faceTextureFrame(face, [0, 0, 16, 16]);
			expect({ up, right }).toEqual(FACE_FRAME_OF[face]);
		}
	});
});

const FACE_FRAME_OF: Record<Face, { up: number[]; right: number[] }> = {
	up: { up: [0, 0, -1], right: [1, 0, 0] },
	down: { up: [0, 0, 1], right: [1, 0, 0] },
	north: { up: [0, 1, 0], right: [-1, 0, 0] },
	south: { up: [0, 1, 0], right: [1, 0, 0] },
	west: { up: [0, 1, 0], right: [0, 0, 1] },
	east: { up: [0, 1, 0], right: [0, 0, -1] },
};

describe("whole faces", () => {
	it("are the faces of an element that cover a side of the block", () => {
		const cube = { from: [0, 0, 0], to: [16, 16, 16] };
		for (const face of FACES) expect(isFullSide(cube, face)).toBe(true);
		const bottomSlab = { from: [0, 0, 0], to: [16, 8, 16] };
		expect(isFullSide(bottomSlab, "down")).toBe(true);
		expect(isFullSide(bottomSlab, "up")).toBe(false); // inside the block
		expect(isFullSide(bottomSlab, "north")).toBe(false); // half a side
		expect(isFullSide({ ...cube, rotation: { angle: 45 } }, "up")).toBe(false);
	});
});

describe("layout tiles", () => {
	const all = conn({
		top: true,
		topRight: true,
		right: true,
		bottomRight: true,
		bottom: true,
		bottomLeft: true,
		left: true,
		topLeft: true,
	});
	const cardinals = conn({ top: true, right: true, bottom: true, left: true });

	it("picks Fusion's tiles for the full and simple layouts", () => {
		expect(fullTile(NO_CONNECTIONS)).toEqual([0, 0]);
		expect(fullTile(all)).toEqual([2, 2]);
		expect(fullTile(cardinals)).toEqual([1, 4]);
		expect(fullTile(conn({ left: true, right: true }))).toEqual([2, 0]);
		expect(fullTile(conn({ left: true, top: true, topLeft: true }))).toEqual([3, 3]);
		expect(fullTile(conn({ left: true, top: true }))).toEqual([5, 1]);
		expect(simpleTile(all)).toEqual([1, 0]);
		expect(simpleTile(conn({ top: true, bottom: true }))).toEqual([1, 1]);
		expect(tileFor("horizontal", conn({ left: true, right: true }))).toEqual([2, 0]);
		expect(tileFor("vertical", conn({ top: true }))).toEqual([0, 3]);
	});

	it("uses every one of the 47 full tiles", () => {
		expect(fullSheetRepresentatives().size).toBe(47);
	});

	it("composes a pieced face quarter by quarter", () => {
		expect(piecedQuarterTile(NO_CONNECTIONS, true, true)).toBe(0);
		expect(piecedQuarterTile(all, true, true)).toBe(1);
		expect(piecedQuarterTile(conn({ top: true, bottom: true }), true, true)).toBe(2);
		expect(piecedQuarterTile(conn({ left: true, right: true }), false, false)).toBe(3);
		expect(piecedQuarterTile(cardinals, false, true)).toBe(4);
		// a diagonal alone changes nothing
		expect(piecedQuarterTile(conn({ topRight: true }), true, false)).toBe(0);
	});
});
