import { describe, it, expect } from "vitest";
import {
	Connections,
	NO_CONNECTIONS,
	NeighborState,
	faceConnections,
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
