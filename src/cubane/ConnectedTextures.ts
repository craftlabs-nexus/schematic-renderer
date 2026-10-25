/**
 * Connected textures as Fusion (SuperMartijn642) defines them: a texture whose
 * `.png.mcmeta` carries `{ "fusion": { "type": "connecting", "layout": ... } }` is a
 * sheet of tiles, and a model loaded with `"loader": "fusion:model"` picks, per face,
 * the tile that matches which of the eight neighbours around that face connect.
 *
 * This module is the pure part: the mcmeta and predicate formats, the eight
 * connection bits of a face from a neighbour lookup, the tile each layout uses for
 * them (ported from Fusion's layout handlers), and the composition of a `pieced`
 * strip into a `full` sheet. Cubane applies it per block position.
 */

export type ConnectingLayout =
	"full" | "simple" | "horizontal" | "vertical" | "compact" | "pieced" | "overlay";

/** Tiles across and down in a sheet of each layout. */
export const LAYOUT_TILES: Record<ConnectingLayout, [number, number]> = {
	full: [8, 6],
	simple: [4, 4],
	horizontal: [4, 1],
	vertical: [1, 4],
	compact: [5, 1],
	pieced: [5, 1],
	overlay: [7, 1],
};

export const CONNECTION_DIRECTIONS = [
	"top",
	"top_right",
	"right",
	"bottom_right",
	"bottom",
	"bottom_left",
	"left",
	"top_left",
] as const;
export type ConnectionDirection = (typeof CONNECTION_DIRECTIONS)[number];

/** Which of a face's eight neighbours connect, in texture space (top is the texture's up). */
export interface Connections {
	top: boolean;
	topRight: boolean;
	right: boolean;
	bottomRight: boolean;
	bottom: boolean;
	bottomLeft: boolean;
	left: boolean;
	topLeft: boolean;
}

export const NO_CONNECTIONS: Connections = {
	top: false,
	topRight: false,
	right: false,
	bottomRight: false,
	bottom: false,
	bottomLeft: false,
	left: false,
	topLeft: false,
};

/** A block state as the predicates see it; null stands for air or outside the schematic. */
export interface NeighborState {
	name: string;
	properties: Record<string, string>;
}

export type ConnectionPredicate =
	| { type: "true" }
	| { type: "false" }
	| { type: "is_same_block" }
	| { type: "is_same_state" }
	| { type: "match_block"; blocks: Set<string>; inFront: boolean }
	| {
			type: "match_state";
			blocks: Set<string>;
			properties: Record<string, Set<string>>;
			inFront: boolean;
	  }
	| { type: "is_direction"; directions: Set<ConnectionDirection> }
	| { type: "is_face_visible" }
	| { type: "and"; predicates: ConnectionPredicate[] }
	| { type: "or"; predicates: ConnectionPredicate[] }
	| { type: "not"; predicate: ConnectionPredicate };

export interface ConnectingTextureInfo {
	layout: ConnectingLayout;
	/** The texture's own predicate, when its mcmeta sets `connections`. */
	connections: ConnectionPredicate | null;
}

/** Fusion's default when neither the model nor the texture names a predicate. */
export const DEFAULT_PREDICATE: ConnectionPredicate = { type: "is_same_state" };

const withNamespace = (id: string): string => (id.includes(":") ? id : `minecraft:${id}`);

/**
 * The `fusion` section of a texture's mcmeta, or null when the texture is not a
 * connecting one. Unknown layouts fall back to `full`.
 */
export function parseConnectingMeta(mcmeta: any): ConnectingTextureInfo | null {
	const fusion = mcmeta?.fusion;
	if (!fusion || typeof fusion !== "object") return null;
	const type = String(fusion.type ?? "").replace(/^fusion:/, "");
	if (type !== "connecting") return null;
	const layoutName = String(fusion.layout ?? "full").toLowerCase();
	const layout = (layoutName in LAYOUT_TILES ? layoutName : "full") as ConnectingLayout;
	const connections = fusion.connections !== undefined ? parsePredicate(fusion.connections) : null;
	return { layout, connections };
}

/**
 * A predicate as Fusion's JSON spells it: an object with `type` (with or without the
 * `fusion:` prefix), or an array of them combined with OR.
 */
export function parsePredicate(json: any): ConnectionPredicate {
	if (Array.isArray(json)) {
		return { type: "or", predicates: json.map(parsePredicate) };
	}
	if (!json || typeof json !== "object") return { type: "false" };
	const type = String(json.type ?? "").replace(/^fusion:/, "");
	const list = (v: any): string[] =>
		Array.isArray(v) ? v.map(String) : v === undefined ? [] : [String(v)];
	const blocks = () => new Set([...list(json.block), ...list(json.blocks)].map(withNamespace));
	switch (type) {
		case "true":
		case "false":
		case "is_same_block":
		case "is_same_state":
		case "is_face_visible":
			return { type };
		case "match_block":
		case "match_block_in_front":
			return { type: "match_block", blocks: blocks(), inFront: type.endsWith("in_front") };
		case "match_state":
		case "match_state_in_front": {
			const properties: Record<string, Set<string>> = {};
			for (const [key, values] of Object.entries(json.properties ?? {})) {
				properties[key] = new Set(list(values));
			}
			return {
				type: "match_state",
				blocks: blocks(),
				properties,
				inFront: type.endsWith("in_front"),
			};
		}
		case "is_direction":
			return {
				type: "is_direction",
				directions: new Set(
					[...list(json.direction), ...list(json.directions)].map(
						(d) => d.toLowerCase() as ConnectionDirection
					)
				),
			};
		case "and":
		case "or":
			return {
				type,
				predicates: Array.isArray(json.predicates) ? json.predicates.map(parsePredicate) : [],
			};
		case "not":
			return { type: "not", predicate: parsePredicate(json.predicate) };
		default:
			console.warn(`[ConnectedTextures] unknown connection predicate "${json.type}"`);
			return { type: "false" };
	}
}

export interface ConnectionContext {
	self: NeighborState;
	other: NeighborState | null;
	/** The block in front of the neighbour, on the face's side. */
	inFront: NeighborState | null;
	direction: ConnectionDirection;
}

const sameProperties = (a: Record<string, string>, b: Record<string, string>): boolean => {
	const ka = Object.keys(a);
	if (ka.length !== Object.keys(b).length) return false;
	return ka.every((k) => a[k] === b[k]);
};

/** The same block in the same state, whatever order its properties come in. */
export const sameState = (a: NeighborState, b: NeighborState): boolean =>
	a.name === b.name && sameProperties(a.properties, b.properties);

/** Fusion's ConnectionPredicate.shouldConnect for the built-in predicates. */
export function shouldConnect(predicate: ConnectionPredicate, ctx: ConnectionContext): boolean {
	const { self, other, inFront, direction } = ctx;
	switch (predicate.type) {
		case "true":
			return true;
		case "false":
			return false;
		case "is_same_block":
			return other !== null && other.name === self.name;
		case "is_same_state":
			return other !== null && sameState(other, self);
		case "match_block": {
			const target = predicate.inFront ? inFront : other;
			return target === null
				? predicate.blocks.has("minecraft:air")
				: predicate.blocks.has(target.name);
		}
		case "match_state": {
			const target = predicate.inFront ? inFront : other;
			if (target === null) return predicate.blocks.has("minecraft:air");
			if (!predicate.blocks.has(target.name)) return false;
			return Object.entries(predicate.properties).every(([k, values]) =>
				values.has(String(target.properties[k]))
			);
		}
		case "is_direction":
			return predicate.directions.has(direction);
		case "is_face_visible":
			return inFront === null;
		case "and":
			return predicate.predicates.every((p) => shouldConnect(p, ctx));
		case "or":
			return predicate.predicates.some((p) => shouldConnect(p, ctx));
		case "not":
			return !shouldConnect(predicate.predicate, ctx);
	}
}

export type Face = "down" | "up" | "north" | "south" | "west" | "east";
export const FACES: Face[] = ["down", "up", "north", "south", "west", "east"];

export const FACE_NORMAL: Record<Face, [number, number, number]> = {
	down: [0, -1, 0],
	up: [0, 1, 0],
	north: [0, 0, -1],
	south: [0, 0, 1],
	west: [-1, 0, 0],
	east: [1, 0, 0],
};

export const OPPOSITE_FACE: Record<Face, Face> = {
	down: "up",
	up: "down",
	north: "south",
	south: "north",
	west: "east",
	east: "west",
};

/**
 * A rectangle across one side of the block: [from, from, to, to] on the side's two other
 * axes, in their x, y, z order, in model units (0 to 16).
 */
export type SideRect = [number, number, number, number];

/**
 * Where an element lies against `side` (a side of the block in the world) once its model is
 * turned by a blockstate's `x` / `y`: the rectangle its box covers across that side, and
 * whether the box is flush on the block's boundary there. The element's own rotation is not
 * applied: callers that need a face flush with the boundary leave turned elements out.
 */
export function elementOnSide(
	element: { from?: number[]; to?: number[] },
	side: Face,
	x: number = 0,
	y: number = 0
): { rect: SideRect; flush: boolean } {
	// the box's corners turned about the block's centre, as rotateFace turns its faces
	const a = rotateVector((element.from ?? [0, 0, 0]).map((v) => v - 8) as Vec3, x, y);
	const b = rotateVector((element.to ?? [16, 16, 16]).map((v) => v - 8) as Vec3, x, y);
	const lo = [0, 1, 2].map((i) => Math.min(a[i], b[i]) + 8);
	const hi = [0, 1, 2].map((i) => Math.max(a[i], b[i]) + 8);
	const axis = side === "west" || side === "east" ? 0 : side === "down" || side === "up" ? 1 : 2;
	const [u, v] = [0, 1, 2].filter((i) => i !== axis);
	const flush = FACE_NORMAL[side][axis] < 0 ? lo[axis] <= 0 : hi[axis] >= 16;
	return { rect: [lo[u], lo[v], hi[u], hi[v]], flush };
}

/**
 * Whether the rectangles `by` (on one side of the block) cover all of `rect`, together: the
 * plane is cut along every rectangle's edges, and each cell of `rect` has to lie in one of
 * them. A rectangle with no area is covered when one of them holds it.
 */
export function rectCovered(rect: SideRect, by: readonly SideRect[]): boolean {
	const [u0, v0, u1, v1] = rect;
	const holds = (r: SideRect, a0: number, b0: number, a1: number, b1: number) =>
		r[0] <= a0 && r[1] <= b0 && r[2] >= a1 && r[3] >= b1;
	if (u0 >= u1 || v0 >= v1) return by.some((r) => holds(r, u0, v0, u1, v1));
	const cuts = (lo: number, hi: number, i: 0 | 1) =>
		[
			...new Set([lo, hi, ...by.flatMap((r) => [r[i], r[i + 2]]).filter((c) => c > lo && c < hi)]),
		].sort((p, q) => p - q);
	const us = cuts(u0, u1, 0);
	const vs = cuts(v0, v1, 1);
	for (let i = 0; i + 1 < us.length; i++) {
		for (let j = 0; j + 1 < vs.length; j++) {
			if (!by.some((r) => holds(r, us[i], vs[j], us[i + 1], vs[j + 1]))) return false;
		}
	}
	return true;
}

/**
 * Where a face's texture points by default (vanilla's face UVs): its "up" and "right"
 * in world space, as Fusion's TextureOrientation tables have them.
 */
export type Vec3 = [number, number, number];

/** Where a face's texture points: the world directions of its "up" and "right". */
export interface TextureFrame {
	up: Vec3;
	right: Vec3;
}

export const FACE_FRAME: Record<Face, TextureFrame> = {
	up: { up: [0, 0, -1], right: [1, 0, 0] },
	down: { up: [0, 0, 1], right: [1, 0, 0] },
	north: { up: [0, 1, 0], right: [-1, 0, 0] },
	south: { up: [0, 1, 0], right: [1, 0, 0] },
	west: { up: [0, 1, 0], right: [0, 0, 1] },
	east: { up: [0, 1, 0], right: [0, 0, -1] },
};

export type NeighborLookup = (dx: number, dy: number, dz: number) => NeighborState | null;

/**
 * The eight connection bits of one (world) face of `self`, asking `neighborAt` for the
 * blocks around it. `frame` is where the face's texture points in the world, its
 * default one unless the model turns it (faceTextureFrame).
 */
export function faceConnections(
	face: Face,
	predicate: ConnectionPredicate,
	self: NeighborState,
	neighborAt: NeighborLookup,
	frame: TextureFrame = FACE_FRAME[face]
): Connections {
	const { up, right } = frame;
	const n = FACE_NORMAL[face];
	const test = (dx: number, dy: number, dz: number, direction: ConnectionDirection): boolean =>
		shouldConnect(predicate, {
			self,
			other: neighborAt(dx, dy, dz),
			inFront: neighborAt(dx + n[0], dy + n[1], dz + n[2]),
			direction,
		});
	return {
		top: test(up[0], up[1], up[2], "top"),
		topRight: test(up[0] + right[0], up[1] + right[1], up[2] + right[2], "top_right"),
		right: test(right[0], right[1], right[2], "right"),
		bottomRight: test(-up[0] + right[0], -up[1] + right[1], -up[2] + right[2], "bottom_right"),
		bottom: test(-up[0], -up[1], -up[2], "bottom"),
		bottomLeft: test(-up[0] - right[0], -up[1] - right[1], -up[2] - right[2], "bottom_left"),
		left: test(-right[0], -right[1], -right[2], "left"),
		topLeft: test(up[0] - right[0], up[1] - right[1], up[2] - right[2], "top_left"),
	};
}

/**
 * The world face a model face ends up on under a blockstate's `x` / `y` rotation
 * (degrees, multiples of 90; x first, then y, both clockwise as the game turns them:
 * y=90 takes north to east, x=90 takes up to north).
 */
export function rotateFace(face: Face, x: number = 0, y: number = 0): Face {
	const [vx, vy, vz] = rotateVector(FACE_NORMAL[face], x, y);
	return FACES.find((f) => {
		const n = FACE_NORMAL[f];
		return n[0] === vx && n[1] === vy && n[2] === vz;
	})!;
}

/** A direction under a blockstate's `x` / `y` rotation, as rotateFace turns faces. */
export function rotateVector(v: Vec3, x: number = 0, y: number = 0): Vec3 {
	let [vx, vy, vz] = v;
	for (let i = 0; i < (((x / 90) % 4) + 4) % 4; i++) [vy, vz] = [vz, -vy];
	for (let i = 0; i < (((y / 90) % 4) + 4) % 4; i++) [vx, vz] = [-vz, vx];
	return [vx + 0, vy + 0, vz + 0]; // no -0, so directions compare with ===
}

const cross = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
const negate = (v: Vec3): Vec3 => [-v[0] + 0, -v[1] + 0, -v[2] + 0];

/**
 * Where a model face's texture points in the world once drawn, which is the frame its
 * connections have to be read in for the tile to sit the right way round: the face's
 * default frame, mirrored on an axis its `uv` runs backwards on, turned clockwise by
 * its `rotation`, then turned with the model by the blockstate's `x` / `y`. This is how
 * BlockMeshBuilder draws it: Cubane hands it no x / y, so uvlock changes nothing there.
 */
export function faceTextureFrame(
	face: Face,
	uv: readonly number[],
	rotation: number = 0,
	x: number = 0,
	y: number = 0
): TextureFrame {
	const base = FACE_FRAME[face];
	let up = uv[1] <= uv[3] ? base.up : negate(base.up);
	let right = uv[0] <= uv[2] ? base.right : negate(base.right);
	// a quarter turn clockwise, seen from in front of the face: up goes to the right
	const n = FACE_NORMAL[face];
	for (let i = 0; i < ((Math.round(rotation / 90) % 4) + 4) % 4; i++) {
		up = cross(up, n);
		right = cross(right, n);
	}
	return { up: rotateVector(up, x, y), right: rotateVector(right, x, y) };
}

/** Fusion's FullLayoutHandler.getTilePos: 47 tiles in an 8 × 6 sheet. */
export function fullTile(c: Connections): [number, number] {
	const { left: L, top: T, right: R, bottom: B } = c;
	const { topLeft: TL, topRight: TR, bottomLeft: BL, bottomRight: BR } = c;
	if (!L && !T && !R && !B) return [0, 0];
	if (L && !T && !R && !B) return [3, 0];
	if (!L && T && !R && !B) return [0, 3];
	if (!L && !T && R && !B) return [1, 0];
	if (!L && !T && !R && B) return [0, 1];
	if (L && !T && R && !B) return [2, 0];
	if (!L && T && !R && B) return [0, 2];
	if (L && T && !R && !B) return TL ? [3, 3] : [5, 1];
	if (!L && T && R && !B) return TR ? [1, 3] : [4, 1];
	if (!L && !T && R && B) return BR ? [1, 1] : [4, 0];
	if (L && !T && !R && B) return BL ? [3, 1] : [5, 0];
	if (!L) return TR && BR ? [1, 2] : TR ? [4, 2] : BR ? [6, 2] : [6, 0];
	if (!T) return BL && BR ? [2, 1] : BL ? [7, 2] : BR ? [5, 2] : [7, 0];
	if (!R) return TL && BL ? [3, 2] : TL ? [7, 3] : BL ? [5, 3] : [7, 1];
	if (!B) return TL && TR ? [2, 3] : TL ? [4, 3] : TR ? [6, 3] : [6, 1];
	if (TL && TR && BL && BR) return [2, 2];
	if (!TL && TR && BL && BR) return [7, 5];
	if (TL && !TR && BL && BR) return [6, 5];
	if (TL && TR && !BL && BR) return [7, 4];
	if (TL && TR && BL && !BR) return [6, 4];
	if (!TL && TR && !BR && BL) return [0, 4];
	if (TL && !TR && BR && !BL) return [0, 5];
	if (!TL && !TR && BR && BL) return [3, 4];
	if (TL && !TR && !BR && BL) return [3, 5];
	if (TL && TR && !BR && !BL) return [2, 5];
	if (!TL && TR && BR && !BL) return [2, 4];
	return TL ? [5, 5] : TR ? [4, 5] : BR ? [4, 4] : BL ? [5, 4] : [1, 4];
}

/** Fusion's SimpleLayoutHandler: the four cardinal neighbours, 4 × 4 sheet. */
export function simpleTile(c: Connections): [number, number] {
	const { left: L, top: T, right: R, bottom: B } = c;
	if (!L && !T && !R && !B) return [0, 0];
	if (L && !T && !R && !B) return [3, 0];
	if (!L && T && !R && !B) return [3, 1];
	if (!L && !T && R && !B) return [2, 1];
	if (!L && !T && !R && B) return [2, 0];
	if (L && !T && R && !B) return [0, 1];
	if (!L && T && !R && B) return [1, 1];
	if (L && T && !R && !B) return [3, 3];
	if (!L && T && R && !B) return [2, 3];
	if (!L && !T && R && B) return [2, 2];
	if (L && !T && !R && B) return [3, 2];
	if (!L) return [0, 2];
	if (!T) return [1, 2];
	if (!R) return [1, 3];
	if (!B) return [0, 3];
	return [1, 0];
}

/** The tile of a layout's sheet for a face's connections (pieced sheets are baked to full first). */
export function tileFor(layout: ConnectingLayout, c: Connections): [number, number] {
	switch (layout) {
		case "full":
		case "pieced":
			return fullTile(c);
		case "simple":
			return simpleTile(c);
		case "horizontal":
			return c.left && c.right ? [2, 0] : c.left ? [3, 0] : c.right ? [1, 0] : [0, 0];
		case "vertical":
			return c.top && c.bottom ? [0, 2] : c.top ? [0, 3] : c.bottom ? [0, 1] : [0, 0];
		default:
			return [0, 0]; // compact and overlay: not supported, the first tile
	}
}

/** Tiles across and down of the sheet a face samples (pieced is read as the baked full sheet). */
export function sheetTiles(layout: ConnectingLayout): [number, number] {
	return layout === "pieced" ? LAYOUT_TILES.full : LAYOUT_TILES[layout];
}

/**
 * Fusion's PiecedLayoutHandler: a `pieced` strip has five tiles (0 unconnected, 1 all
 * round, 2 vertical, 3 horizontal, 4 the inner corner) and each quarter of a face
 * takes the matching quarter of the tile its two sides and diagonal select.
 */
const PIECED_CORNER_TILE = [0, 3, 2, 4, 0, 3, 2, 1];

export function piecedQuarterTile(c: Connections, top: boolean, left: boolean): number {
	const h = left ? c.left : c.right;
	const v = top ? c.top : c.bottom;
	const d = top ? (left ? c.topLeft : c.topRight) : left ? c.bottomLeft : c.bottomRight;
	return PIECED_CORNER_TILE[(h ? 1 : 0) | ((v ? 1 : 0) << 1) | ((d ? 1 : 0) << 2)];
}

/** One connection state per tile of the full sheet, to bake a pieced strip into it. */
export function fullSheetRepresentatives(): Map<string, Connections> {
	const out = new Map<string, Connections>();
	for (let bits = 0; bits < 256; bits++) {
		const c: Connections = {
			top: !!(bits & 1),
			topRight: !!(bits & 2),
			right: !!(bits & 4),
			bottomRight: !!(bits & 8),
			bottom: !!(bits & 16),
			bottomLeft: !!(bits & 32),
			left: !!(bits & 64),
			topLeft: !!(bits & 128),
		};
		const key = fullTile(c).join(",");
		if (!out.has(key)) out.set(key, c);
	}
	return out;
}

/**
 * Bake a `pieced` strip (five square tiles in a row) into the `full` layout's 8 × 6
 * sheet, quarter by quarter, so a face needs one tile whatever its connections.
 */
export function bakePiecedToFull(
	strip: CanvasImageSource & { width: number; height: number }
): HTMLCanvasElement {
	const t = Math.max(1, Math.floor(strip.width / 5));
	const half = t / 2;
	const canvas = document.createElement("canvas");
	canvas.width = 8 * t;
	canvas.height = 6 * t;
	const ctx = canvas.getContext("2d")!;
	ctx.imageSmoothingEnabled = false;
	for (const [key, c] of fullSheetRepresentatives()) {
		const [tx, ty] = key.split(",").map(Number);
		for (const top of [true, false]) {
			for (const left of [true, false]) {
				const src = piecedQuarterTile(c, top, left);
				const sx = src * t + (left ? 0 : half);
				const sy = top ? 0 : half;
				const dx = tx * t + (left ? 0 : half);
				const dy = ty * t + (top ? 0 : half);
				ctx.drawImage(strip, sx, sy, half, half, dx, dy, half, half);
			}
		}
	}
	return canvas;
}

/** A short key for a face's connections, for mesh caches. */
export function connectionsKey(c: Connections): number {
	return (
		(c.top ? 1 : 0) |
		(c.topRight ? 2 : 0) |
		(c.right ? 4 : 0) |
		(c.bottomRight ? 8 : 0) |
		(c.bottom ? 16 : 0) |
		(c.bottomLeft ? 32 : 0) |
		(c.left ? 64 : 0) |
		(c.topLeft ? 128 : 0)
	);
}
