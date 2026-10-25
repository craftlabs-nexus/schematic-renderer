import * as THREE from "three";
import { AssetLoader } from "./AssetLoader";
import {
	DEFAULT_NAMESPACE,
	formatResourceLocation,
	parseResourceLocation,
} from "./ResourceLocation";

/**
 * Vanilla-accurate sign rendering for cubane.
 *
 * Ported (as a reference, not a dependency) from Schematic-Mesher's Rust entity
 * mesher (`sign.rs`, `hanging_sign.rs`, `sign_text.rs`). Signs are *block entities*:
 * Minecraft renders them with a dedicated model (a board ± stick / plank / chains)
 * built from cube primitives, then draws the text with the bitmap font. We
 * reproduce that here:
 *
 *  - Geometry is built from the exact MC entity-model cubes and poses (position in
 *    1/16-block units, RotX(π) to flip Java's Y-down model into Y-up, 2/3 scale for
 *    regular signs, 1.0 for hanging), rotated about the block centre by the sign's
 *    `rotation` (standing, 16 steps) or `facing` (wall) property.
 *  - The texture is either the pre-26 entity texture (`entity/signs/<wood>`, 64 × 32,
 *    box-unwrapped cubes) or, since Minecraft 26.x, the block texture
 *    (`block/<wood>_sign`, 32 × 32, laid out as `models/block/template_*sign*.json`
 *    sample it); the layout is picked by the texture's aspect, see {@link SignLayout}.
 *  - Text is baked into an upscaled copy of the sign texture by compositing glyphs
 *    from `font/ascii` at the game's scale (6 font pixels per texel of a regular
 *    sign's face, 6⅔ for hanging signs; four fixed line slots centred on the board;
 *    plain text at 40% of the dye colour, glowing text at full colour with a 40%
 *    outline, cream for black), so it shares the board's UVs (no separate overlay
 *    quad to keep aligned, which is what made the old approach drift / vanish).
 *
 * Output geometry is in cubane's block-local [0,1] space (Y-up); the caller places
 * it at the block's integer coordinate, so vertices fill the cell exactly.
 */

const SIGN_WOODS = [
	"oak",
	"spruce",
	"birch",
	"jungle",
	"acacia",
	"dark_oak",
	"crimson",
	"warped",
	"mangrove",
	"cherry",
	"bamboo",
	"pale_oak",
];

interface SignInfo {
	/** the block's namespace: a mod's sign is drawn from that mod's textures */
	namespace: string;
	isHanging: boolean;
	isWall: boolean;
	/** a ceiling hanging sign's `attached`: hung from one point by V-shaped chains */
	attached: boolean;
	wood: string;
	facingAngle: number; // Y rotation (radians) about the block centre
}

/** The cubes a sign is made of; the name picks the cube's faces in a 26.x texture. */
type SignPart = "board" | "post" | "hanging_board" | "bar" | "chain" | "v_chains";

interface EntityCube {
	part: SignPart;
	origin: [number, number, number];
	dimensions: [number, number, number];
	texOffset: [number, number];
	mirror: boolean;
}

interface EntityPart {
	cubes: EntityCube[];
	position: [number, number, number];
	rotation: [number, number, number];
	scale: number;
	/** A child part's own pose inside the model (a hanging sign's chains): offset, then yaw. */
	childPose?: { offset: [number, number, number]; yaw: number };
}

type Face = "down" | "up" | "north" | "south" | "west" | "east";

const FACE_NORMALS: Record<Face, [number, number, number]> = {
	down: [0, -1, 0],
	up: [0, 1, 0],
	north: [0, 0, -1],
	south: [0, 0, 1],
	west: [-1, 0, 0],
	east: [1, 0, 0],
};

// 6 faces: corner indices into the 8-corner cube + the face direction. Mirrors the
// reference's `generate_cube_faces` face_defs / winding exactly.
const FACE_DEFS: { dir: Face; corners: [number, number, number, number] }[] = [
	{ dir: "down", corners: [4, 5, 1, 0] },
	{ dir: "up", corners: [3, 2, 6, 7] },
	{ dir: "north", corners: [1, 0, 3, 2] },
	{ dir: "south", corners: [4, 5, 6, 7] },
	{ dir: "west", corners: [0, 4, 7, 3] },
	{ dir: "east", corners: [5, 1, 2, 6] },
];

/** A rectangle of the texture, [x, y, width, height] in layout texels. */
type Rect = [number, number, number, number];

/**
 * Where a sign texture keeps each cube face. Two layouts exist: the game's pre-26
 * entity textures (64 × 32, every cube box-unwrapped at its `texOffset`) and, since
 * 26.x, the block textures at `textures/block/<wood>_sign.png` (32 × 32: the front
 * face 24 × 12 at (0, 2), the back at (0, 16), the post in the strip at the right;
 * hanging signs: the board 14 × 10 at (2, 16) and (18, 16), the bar and chains in the
 * top-left quarter). HD packs scale a layout uniformly, so rects are in layout
 * texels and the UVs are normalized.
 */
export interface SignLayout {
	width: number;
	height: number;
	faceRect(cube: EntityCube, face: Face): Rect;
}

/** The legacy 64 × 32 box unwrap: top strip down/up, then west, north (front), east, south (back). */
export const ENTITY_SIGN_LAYOUT: SignLayout = {
	width: 64,
	height: 32,
	faceRect(cube, face) {
		const [u0, v0] = cube.texOffset;
		const [w, h, d] = cube.dimensions;
		switch (face) {
			case "down":
				return [u0 + d, v0, w, d];
			case "up":
				return [u0 + d + w, v0, w, d];
			case "north":
				return [u0 + d, v0 + d, w, h];
			case "south":
				return [u0 + d + w + d, v0 + d, w, h];
			case "west":
				return [u0, v0 + d, d, h];
			case "east":
				return [u0 + d + w, v0 + d, d, h];
		}
	},
};

// The 26.x block textures, as models/block/template_wall_sign.json, template_sign_rot_0.json,
// template_hanging_sign_rot_0.json and template_wall_hanging_sign.json sample them (their uv in
// sixteenths of a 32 px texture, doubled). The entity model's "north" face is the front (the
// model's south face at its default facing), so the model's faces are mirrored onto it.
const BLOCK_SIGN_FACES: Record<SignPart, Record<Face, Rect>> = {
	board: {
		north: [0, 2, 24, 12],
		south: [0, 16, 24, 12],
		down: [0, 0, 24, 2],
		up: [0, 28, 24, 2],
		west: [24, 2, 2, 12],
		east: [24, 16, 2, 12],
	},
	post: {
		north: [28, 0, 2, 14],
		south: [28, 16, 2, 14],
		west: [30, 0, 2, 14],
		east: [30, 16, 2, 14],
		up: [28, 30, 2, 2],
		down: [28, 30, 2, 2],
	},
	hanging_board: {
		north: [2, 16, 14, 10],
		south: [18, 16, 14, 10],
		west: [16, 16, 2, 10],
		east: [0, 16, 2, 10],
		down: [2, 14, 14, 2],
		up: [2, 26, 14, 2],
	},
	bar: {
		north: [0, 4, 16, 2],
		south: [0, 7, 16, 2],
		west: [16, 4, 4, 2],
		east: [16, 7, 4, 2],
		down: [0, 0, 16, 4],
		up: [0, 9, 16, 4],
	},
	chain: {
		north: [22, 7, 2, 6],
		south: [22, 7, 2, 6],
		west: [22, 7, 2, 6],
		east: [22, 7, 2, 6],
		up: [22, 7, 2, 2],
		down: [22, 7, 2, 2],
	},
	// A flat cube: only its front and back are drawn (see emitCube). Assumed to sit in the
	// texture's free 12 × 6 corner right of the bar, as the legacy texture keeps it beside the chains.
	v_chains: {
		north: [20, 0, 12, 6],
		south: [20, 0, 12, 6],
		west: [20, 0, 0, 6],
		east: [20, 0, 0, 6],
		up: [20, 0, 12, 0],
		down: [20, 0, 12, 0],
	},
};

export const BLOCK_SIGN_LAYOUT: SignLayout = {
	width: 32,
	height: 32,
	faceRect: (cube, face) => BLOCK_SIGN_FACES[cube.part][face],
};

/**
 * How the game lays text on a board. SignRenderer draws regular signs at a text scale
 * of ⅔ × 1/96 block per font pixel on a board 24 texels wide at ⅔ scale: 6 font pixels
 * per texel, lines 10 px apart, at most 90 px wide; HangingSignRenderer uses 0.9 × 1/96
 * on a 14-texel board at full scale: 6⅔ px per texel, lines 9 px apart, 60 px wide. The
 * four lines are fixed slots centred on the board (empty lines keep their slot).
 */
const TEXT_METRICS = {
	regular: { fontPxPerTexel: 6, lineHeight: 10, maxWidth: 90 },
	hanging: { fontPxPerTexel: 20 / 3, lineHeight: 9, maxWidth: 60 },
};

/**
 * The largest side a sign's text texture may have: a MAX_TEXTURE_SIZE most GPUs reach (a
 * texture past the GPU's is not drawn).
 */
const MAX_SIGN_TEXTURE_SIZE = 4096;

/** DyeColor.getTextColor(): the colour a sign's text is set to with that dye. */
const DYE_TEXT_COLORS: Record<string, number> = {
	white: 0xffffff,
	orange: 0xff681f,
	magenta: 0xff00ff,
	light_blue: 0x9ac0cd,
	yellow: 0xffff00,
	lime: 0xbfff00,
	pink: 0xff69b4,
	gray: 0x808080,
	light_gray: 0xd3d3d3,
	cyan: 0x00ffff,
	purple: 0xa020f0,
	blue: 0x0000ff,
	brown: 0x8b4513,
	green: 0x00ff00,
	red: 0xff0000,
	black: 0x000000,
};

type RGB = [number, number, number];

/** The colour codes after a § (ChatFormatting): the colour names textColorRgb knows. */
const FORMATTING_COLORS: Record<string, string> = {
	"0": "black",
	"1": "dark_blue",
	"2": "dark_green",
	"3": "dark_aqua",
	"4": "dark_red",
	"5": "dark_purple",
	"6": "gold",
	"7": "gray",
	"8": "dark_gray",
	"9": "blue",
	a: "green",
	b: "aqua",
	c: "red",
	d: "light_purple",
	e: "yellow",
	f: "white",
};

/** The text of one side of a sign, as the block entity carries it. */
interface SignText {
	lines: string[];
	color: string;
	glowing: boolean;
}

interface TextSegment {
	text: string;
	/** A colour the text component sets itself; null for the sign's dye colour. */
	color: string | null;
}

export class SignRenderer {
	private fontData: {
		pixels: Uint8ClampedArray;
		width: number;
		height: number;
		cellW: number;
		cellH: number;
		/** font texels per font pixel: the cell height over the game's 8 (2 for a 16 px font) */
		scale: number;
		/** each glyph's advance in font pixels, as the game has it whatever the cell size */
		glyphWidths: Uint8Array;
	} | null = null;
	private fontPromise: Promise<void> | null = null;
	private basePixelCache = new Map<string, ImageData | null>();
	private textureCache = new Map<string, THREE.Texture>();
	// bumped by clearCaches: a font, texture or pixels read before the packs changed is not kept
	private generation = 0;

	constructor(private assetLoader: AssetLoader) {}

	/** Forgets the sign textures and font read from the packs, for when the packs change. */
	public clearCaches(): void {
		this.textureCache.forEach((t) => t.dispose());
		this.textureCache.clear();
		this.basePixelCache.clear();
		this.fontData = null;
		this.fontPromise = null;
		this.generation++;
	}

	/** Whether a block id (e.g. "minecraft:oak_wall_sign", "biomesoplenty:fir_sign") is any kind of sign. */
	public isSign(blockName: string): boolean {
		const name = parseResourceLocation(blockName).path;
		return name.endsWith("_sign") || name === "sign";
	}

	/**
	 * Build a full sign mesh (geometry + baked-text material) for a block.
	 * Returns null if the block isn't a sign or the textures can't be loaded.
	 */
	public async buildSignMesh(
		blockName: string,
		properties: Record<string, string>,
		nbtData?: Record<string, any>
	): Promise<THREE.Object3D | null> {
		const info = this.detectSign(blockName, properties);
		if (!info) return null;
		const generation = this.generation;

		const base = await this.getBasePixels(info);
		if (!base) return null;
		const layout = base.width === base.height ? BLOCK_SIGN_LAYOUT : ENTITY_SIGN_LAYOUT;

		const parts = this.buildParts(info);
		const geometry = this.buildGeometry(parts, info.facingAngle, layout);

		const { front, back } = this.extractSignText(nbtData ?? {});
		const texture = await this.getSignTexture(
			info,
			layout,
			base,
			parts[0].cubes[0],
			front,
			back,
			generation
		);

		const material = new THREE.MeshStandardMaterial({
			map: texture,
			transparent: false,
			alphaTest: 0.5,
			roughness: 1.0,
			metalness: 0.0,
		});

		const mesh = new THREE.Mesh(geometry, material);
		mesh.name = `sign_${info.namespace === DEFAULT_NAMESPACE ? "" : `${info.namespace}_`}${info.wood}${info.isWall ? "_wall" : ""}${info.isHanging ? "_hanging" : ""}`;

		// Geometry is already in block-local [0,1]; the caller adds it at the block
		// coordinate, so no positional offset is needed.
		const group = new THREE.Group();
		group.add(mesh);
		return group;
	}

	// ── Detection ─────────────────────────────────────────────────────────────

	private detectSign(blockName: string, properties: Record<string, string>): SignInfo | null {
		const { namespace, path: name } = parseResourceLocation(blockName);
		if (!this.isSign(blockName)) return null;

		const isHanging = name.includes("hanging");
		const isWall = name.includes("wall");

		// Strip the suffixes to recover the wood prefix. A mod's woods are its own: its fir_wall_sign is fir, drawn
		// from its textures (or not by this renderer at all, when it has none), never as oak.
		const wood =
			namespace === DEFAULT_NAMESPACE
				? (SIGN_WOODS.find((w) => name.startsWith(`${w}_`)) ?? "oak")
				: name.replace(/(_wall)?(_hanging)?_sign$/, "") || name;

		// Standing signs (and ceiling hanging signs) rotate by the 16-step `rotation`
		// property; wall variants rotate by `facing`.
		const facingAngle = isWall
			? this.facingRotationRad(properties.facing ?? "north")
			: this.standingRotationRad(properties.rotation);

		const attached = properties.attached === "true";

		return { namespace, isHanging, isWall, attached, wood, facingAngle };
	}

	/**
	 * Y rotation for a wall sign's board. At angle 0 the board sits on the cell's
	 * south edge (the entity pose puts it at z = 15/16) and, turned half round by
	 * buildParts, faces north: a north-facing wall sign hanging on the block to its
	 * south. three.js's positive Y rotation turns +z toward +x, the opposite of the
	 * game's yaw, so east is -90° and west +90° (the other way round put the board
	 * on the far side of its cell, text toward the block it should hang on).
	 */
	private facingRotationRad(facing: string): number {
		switch (facing) {
			case "south":
				return Math.PI;
			case "east":
				return -Math.PI / 2;
			case "west":
				return Math.PI / 2;
			case "north":
			default:
				return 0;
		}
	}

	/**
	 * `rotation` 0-15, each step 22.5° clockwise (seen from above) from south: 0 faces
	 * south, 4 west, 8 north, 12 east. The model's front faces south at angle 0 and
	 * three.js's positive Y rotation turns the other way than the game's yaw, hence
	 * the minus (the old plus mirrored every rotation but 0 and 8).
	 */
	private standingRotationRad(rotation: string | undefined): number {
		const rot = parseInt(rotation ?? "0", 10);
		return -(Number.isFinite(rot) ? rot : 0) * (Math.PI / 8);
	}

	// ── Model definitions (exact MC entity-model cubes/poses) ───────────────────

	private buildParts(info: SignInfo): EntityPart[] {
		if (info.isHanging) {
			// HangingSignRenderer.translateSign puts both kinds in the middle of the cell (unlike
			// a wall sign, no step toward the wall): a wall hanging sign's board stands across
			// the wall it hangs from, and its plank runs out of that wall.
			const pos: [number, number, number] = [8, 10, 8];
			const scale = 1.0;
			// RotX(π) flips Java's Y-down model; wall variants turn half round too, so their
			// front faces their `facing` (see facingRotationRad).
			const rotation: [number, number, number] = [Math.PI, info.isWall ? Math.PI : 0, 0];
			const posed = (cube: EntityCube, childPose?: EntityPart["childPose"]): EntityPart => ({
				cubes: [cube],
				position: pos,
				rotation,
				scale,
				childPose,
			});
			const parts: EntityPart[] = [
				posed({
					part: "hanging_board",
					origin: [-7, 0, -1],
					dimensions: [14, 10, 2],
					texOffset: [0, 12],
					mirror: false,
				}),
			];
			// HangingSignModel.evaluateVisibleParts: the plank only on a wall hanging sign (it
			// runs into the wall); a ceiling sign hangs from the block above by two straight
			// chains, or by V-shaped chains from one point when it is `attached`.
			if (info.isWall) {
				parts.push(
					posed({
						part: "bar",
						origin: [-8, -6, -2],
						dimensions: [16, 2, 4],
						texOffset: [0, 0],
						mirror: false,
					})
				);
			}
			if (!info.isWall && info.attached) {
				parts.push(
					posed({
						part: "v_chains",
						origin: [-6, -6, 0],
						dimensions: [12, 6, 0],
						texOffset: [14, 6],
						mirror: false,
					})
				);
			} else {
				// Each chain is two flat 3 × 6 cubes crossed at ±45° about its own vertical axis.
				for (const x of [-5, 5]) {
					for (const [u, yaw] of [
						[0, -Math.PI / 4],
						[6, Math.PI / 4],
					]) {
						parts.push(
							posed(
								{
									part: "chain",
									origin: [-1.5, 0, 0],
									dimensions: [3, 6, 0],
									texOffset: [u, 6],
									mirror: false,
								},
								{ offset: [x, -6, 0], yaw }
							)
						);
					}
				}
			}
			return parts;
		}

		const pos: [number, number, number] = info.isWall ? [8, 3, 15] : [8, 8, 8];
		const scale = 2 / 3;
		// RotX(π) flips Java's Y-down model; wall variants turn half round too, so the
		// front faces away from the wall the board sits against (see facingRotationRad).
		const rotation: [number, number, number] = [Math.PI, info.isWall ? Math.PI : 0, 0];
		const parts: EntityPart[] = [
			{
				cubes: [
					{
						part: "board",
						origin: [-12, -14, -1],
						dimensions: [24, 12, 2],
						texOffset: [0, 0],
						mirror: false,
					},
				],
				position: pos,
				rotation,
				scale,
			},
		];
		// Standing signs have a stick; wall signs don't.
		if (!info.isWall) {
			parts.push({
				cubes: [
					{
						part: "post",
						origin: [-1, -2, -1],
						dimensions: [2, 14, 2],
						texOffset: [0, 14],
						mirror: false,
					},
				],
				position: pos,
				rotation,
				scale,
			});
		}
		return parts;
	}

	// ── Geometry generation ─────────────────────────────────────────────────────

	private buildGeometry(
		parts: EntityPart[],
		facingAngle: number,
		layout: SignLayout
	): THREE.BufferGeometry {
		// facing_mat = T(0.5,0,0.5) · Ry(angle) · T(-0.5,0,-0.5) — rotate about the
		// block centre (in the ground plane).
		const facingMat = new THREE.Matrix4()
			.makeTranslation(0.5, 0, 0.5)
			.multiply(new THREE.Matrix4().makeRotationY(facingAngle))
			.multiply(new THREE.Matrix4().makeTranslation(-0.5, 0, -0.5));

		// The reference model is block-local [0,1]; cubane builds block meshes in
		// [-0.5,0.5] centered space (c/16 - 0.5) and the caller places them at the
		// block coordinate. Shift the whole sign to match, else it sits +0.5 off on
		// every axis.
		const centerMat = new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5);

		const positions: number[] = [];
		const normals: number[] = [];
		const uvs: number[] = [];
		const indices: number[] = [];

		for (const part of parts) {
			// local = T(pos/16) · Rz · Ry · Rx · S(scale)
			const local = new THREE.Matrix4()
				.makeTranslation(part.position[0] / 16, part.position[1] / 16, part.position[2] / 16)
				.multiply(new THREE.Matrix4().makeRotationZ(part.rotation[2]))
				.multiply(new THREE.Matrix4().makeRotationY(part.rotation[1]))
				.multiply(new THREE.Matrix4().makeRotationX(part.rotation[0]))
				.multiply(new THREE.Matrix4().makeScale(part.scale, part.scale, part.scale));
			if (part.childPose) {
				const [cx, cy, cz] = part.childPose.offset;
				local
					.multiply(new THREE.Matrix4().makeTranslation(cx / 16, cy / 16, cz / 16))
					.multiply(new THREE.Matrix4().makeRotationY(part.childPose.yaw));
			}

			const full = new THREE.Matrix4().multiplyMatrices(facingMat, local).premultiply(centerMat);
			const normalMat = new THREE.Matrix3().getNormalMatrix(full);

			for (const cube of part.cubes) {
				this.emitCube(cube, full, normalMat, layout, positions, normals, uvs, indices);
			}
		}

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
		geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
		geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
		geometry.setIndex(indices);
		return geometry;
	}

	private emitCube(
		cube: EntityCube,
		full: THREE.Matrix4,
		normalMat: THREE.Matrix3,
		layout: SignLayout,
		positions: number[],
		normals: number[],
		uvs: number[],
		indices: number[]
	): void {
		const [ox, oy, oz] = cube.origin;
		const [w, h, d] = cube.dimensions;
		const x0 = ox / 16;
		const y0 = oy / 16;
		const z0 = oz / 16;
		const x1 = (ox + w) / 16;
		const y1 = (oy + h) / 16;
		const z1 = (oz + d) / 16;

		// 8 corners (---, +--, ++-, -+-, --+, +-+, +++, -++)
		const corners: [number, number, number][] = [
			[x0, y0, z0],
			[x1, y0, z0],
			[x1, y1, z0],
			[x0, y1, z0],
			[x0, y0, z1],
			[x1, y0, z1],
			[x1, y1, z1],
			[x0, y1, z1],
		];
		const transformed = corners.map((c) => {
			const v = new THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(full);
			return [v.x, v.y, v.z] as [number, number, number];
		});

		// A flat cube (the chains) is seen from both sides: the game draws signs without back-face
		// culling, and its box unwrap gives the back (south) face its own rect, the strip beside
		// the front's (u + width). Its front and back are drawn, each facing its own way; its
		// other faces have no area.
		const flat = d === 0;
		for (const { dir, corners: ci } of FACE_DEFS) {
			if (flat && dir !== "north" && dir !== "south") continue;
			const faceUVs = this.faceUVs(layout.faceRect(cube, dir), dir, cube.mirror, layout);

			const dn = FACE_NORMALS[dir];
			const n = new THREE.Vector3(dn[0], dn[1], dn[2]).applyMatrix3(normalMat).normalize();

			// Side faces wind 0-1-2 / 0-2-3; up/down wind 0-2-1 / 0-3-2.
			const isSide = dir === "north" || dir === "south" || dir === "west" || dir === "east";
			const vStart = positions.length / 3;
			for (let i = 0; i < 4; i++) {
				const p = transformed[ci[i]];
				positions.push(p[0], p[1], p[2]);
				normals.push(n.x, n.y, n.z);
				uvs.push(faceUVs[i][0], faceUVs[i][1]);
			}
			if (isSide) {
				indices.push(vStart, vStart + 1, vStart + 2, vStart, vStart + 2, vStart + 3);
			} else {
				indices.push(vStart, vStart + 2, vStart + 1, vStart, vStart + 3, vStart + 2);
			}
		}
	}

	/**
	 * UVs for one cube face from its rect in the layout. Normalized with a top-left
	 * origin; the sign texture is created with `flipY = false` so these map 1:1 onto
	 * the canvas pixels.
	 */
	private faceUVs(rect: Rect, face: Face, mirror: boolean, layout: SignLayout): [number, number][] {
		const [left, top, w, h] = rect;
		const nl = left / layout.width;
		const nt = top / layout.height;
		const nr = (left + w) / layout.width;
		const nb = (top + h) / layout.height;

		if (face === "up") {
			return mirror
				? [
						[nr, nb],
						[nl, nb],
						[nl, nt],
						[nr, nt],
					]
				: [
						[nl, nb],
						[nr, nb],
						[nr, nt],
						[nl, nt],
					];
		}
		return mirror
			? [
					[nl, nt],
					[nr, nt],
					[nr, nb],
					[nl, nb],
				]
			: [
					[nr, nt],
					[nl, nt],
					[nl, nb],
					[nr, nb],
				];
	}

	// ── Text extraction (modern front_text / back_text + legacy Text1-4) ────────

	private extractSignText(nbtData: Record<string, any>): {
		front: SignText;
		back: SignText | null;
	} {
		const side = (text: any): SignText | null => {
			if (!text?.messages) return null;
			const lines: string[] = [];
			for (const msg of text.messages) lines.push(this.messageToString(msg));
			while (lines.length < 4) lines.push("");
			return {
				lines: lines.slice(0, 4),
				color: typeof text.color === "string" ? text.color : "black",
				glowing: text.has_glowing_text === 1 || text.has_glowing_text === true,
			};
		};

		let front = side(nbtData.front_text ?? nbtData.Text?.front_text);
		if (!front) {
			const lines: string[] = [];
			for (let i = 1; i <= 4; i++) {
				const key = `Text${i}`;
				lines.push(nbtData[key] !== undefined ? this.messageToString(nbtData[key]) : "");
			}
			front = {
				lines,
				color: typeof nbtData.Color === "string" ? nbtData.Color : "black",
				// 1.17-1.19 signs keep the glow ink as a GlowingText byte.
				glowing: nbtData.GlowingText === 1 || nbtData.GlowingText === true,
			};
		}
		const back = side(nbtData.back_text ?? nbtData.Text?.back_text);
		return { front, back: back && back.lines.some((l) => l.trim() !== "") ? back : null };
	}

	/** A raw NBT message → the literal string we hand to `parse_text_component`. */
	private messageToString(msg: any): string {
		if (typeof msg === "string") return msg;
		if (typeof msg === "object" && msg !== null) {
			try {
				return JSON.stringify(msg);
			} catch {
				return "";
			}
		}
		return String(msg ?? "");
	}

	// ── Texture (base + baked text) ─────────────────────────────────────────────

	private async getSignTexture(
		info: SignInfo,
		layout: SignLayout,
		base: ImageData,
		board: EntityCube,
		front: SignText,
		back: SignText | null,
		/** the generation `base` was read in: a texture made from the old packs is not cached */
		generation: number
	): Promise<THREE.Texture> {
		const hasText = front.lines.some((l) => l.trim() !== "") || back !== null;
		const cacheKey = `${info.namespace}:${info.wood}|${info.isHanging}|${info.isWall}|${hasText ? JSON.stringify([front, back]) : ""}`;
		const cached = this.textureCache.get(cacheKey);
		if (cached) return cached;

		let canvas: HTMLCanvasElement | OffscreenCanvas;
		if (!hasText) {
			canvas = this.imageDataToCanvas(base);
		} else {
			canvas = await this.compositeSignWithText(base, layout, info, board, front, back);
		}

		const texture = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
		texture.flipY = false; // canvas top-left origin matches our top-left UVs
		texture.magFilter = THREE.NearestFilter;
		texture.minFilter = THREE.NearestFilter;
		texture.generateMipmaps = false;
		// Match cubane's block textures: no sRGB decode on sample (gamma is applied in
		// post-processing). SRGBColorSpace here would render signs darker than blocks.
		texture.colorSpace = THREE.NoColorSpace;
		texture.needsUpdate = true;

		// made from the old packs if they changed meanwhile: the caller has it, the cache does not
		if (generation === this.generation) this.textureCache.set(cacheKey, texture);
		return texture;
	}

	/**
	 * The sign's texture: `block/<wood>_sign` (26.x) or `entity/signs/<wood>` (older
	 * packs), whichever the pack has; hanging signs likewise.
	 */
	private async getBasePixels(info: SignInfo): Promise<ImageData | null> {
		const key = `${info.namespace}:${info.isHanging ? "hanging" : "sign"}/${info.wood}`;
		if (this.basePixelCache.has(key)) return this.basePixelCache.get(key)!;
		const generation = this.generation;
		const candidates = (
			info.isHanging
				? [`block/${info.wood}_hanging_sign`, `entity/signs/hanging/${info.wood}`]
				: [`block/${info.wood}_sign`, `entity/signs/${info.wood}`]
		).map((path) =>
			formatResourceLocation({ namespace: info.namespace, path }, { omitDefaultNamespace: true })
		);
		let data: ImageData | null = null;
		for (const path of candidates) {
			data = await this.assetLoader.getTexturePixels(path);
			if (data) break;
		}
		if (generation === this.generation) this.basePixelCache.set(key, data);
		return data;
	}

	private imageDataToCanvas(img: ImageData): HTMLCanvasElement | OffscreenCanvas {
		const canvas = this.makeCanvas(img.width, img.height);
		const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
		ctx.putImageData(img, 0, 0);
		return canvas;
	}

	private makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
		if (typeof document !== "undefined") {
			const c = document.createElement("canvas");
			c.width = w;
			c.height = h;
			return c;
		}
		return new OffscreenCanvas(w, h);
	}

	// ── Text compositing (port of sign_text.rs) ─────────────────────────────────

	private async ensureFont(): Promise<void> {
		if (this.fontData) return;
		if (!this.fontPromise) {
			const generation = this.generation;
			this.fontPromise = (async () => {
				const tex = await this.assetLoader.getTexturePixels("font/ascii");
				if (!tex) return;
				const width = tex.width;
				const height = tex.height;
				const cellW = Math.floor(width / 16);
				const cellH = Math.floor(height / 16);
				const px = tex.data;
				// as the game's bitmap font: drawn 8 font pixels high, so a glyph's width read in
				// texels is scaled by 8 / cell height (rounded) before its 1 px of spacing
				const scale = Math.max(1, cellH) / 8;
				const glyphWidths = new Uint8Array(256);
				for (let ch = 0; ch < 256; ch++) {
					const col = ch % 16;
					const row = Math.floor(ch / 16);
					const cx = col * cellW;
					const cy = row * cellH;
					let maxX = 0;
					let has = false;
					for (let py = 0; py < cellH; py++) {
						for (let pxx = 0; pxx < cellW; pxx++) {
							const idx = ((cy + py) * width + (cx + pxx)) * 4;
							if (idx + 3 < px.length && px[idx + 3] > 0) {
								maxX = Math.max(maxX, pxx + 1);
								has = true;
							}
						}
					}
					const cell = Math.round(cellW / scale);
					glyphWidths[ch] = has
						? Math.min(Math.round(maxX / scale) + 1, cell)
						: Math.floor(cell / 2);
				}
				// read from the old packs if they changed meanwhile: the next sign reads the font again
				if (generation !== this.generation) return;
				this.fontData = { pixels: px, width, height, cellW, cellH, scale, glyphWidths };
			})();
		}
		await this.fontPromise;
	}

	/**
	 * How many times the text texture scales the game's (1 output pixel per font pixel on a
	 * regular sign, 3 on a hanging one). An HD board keeps its detail with the multiple it has
	 * of the layout, and a font with larger cells (font.scale texels per font pixel) with
	 * enough output pixels per font pixel to show each texel: a hanging sign already draws 3,
	 * so a 4× font needs 2 there, not 4. It is lowered until the texture fits
	 * MAX_SIGN_TEXTURE_SIZE.
	 */
	private textScale(base: ImageData, layout: SignLayout, isHanging: boolean): number {
		const metrics = isHanging ? TEXT_METRICS.hanging : TEXT_METRICS.regular;
		const perGlyph = isHanging ? 3 : 1;
		let hd = Math.max(
			1,
			Math.round(base.width / layout.width),
			Math.ceil((this.fontData?.scale ?? 1) / perGlyph)
		);
		const size = (n: number) =>
			Math.max(layout.width, layout.height) * Math.round(metrics.fontPxPerTexel * perGlyph * n);
		while (hd > 1 && size(hd) > MAX_SIGN_TEXTURE_SIZE) hd--;
		return hd;
	}

	private async compositeSignWithText(
		base: ImageData,
		layout: SignLayout,
		info: SignInfo,
		board: EntityCube,
		front: SignText,
		back: SignText | null
	): Promise<HTMLCanvasElement | OffscreenCanvas> {
		await this.ensureFont();

		// The output is sized so a font pixel is a whole number of pixels: `glyph`
		// output pixels per font pixel, `texel` per layout texel. HD packs (base
		// texture a multiple of the layout) scale both up to keep their detail.
		const metrics = info.isHanging ? TEXT_METRICS.hanging : TEXT_METRICS.regular;
		const hd = this.textScale(base, layout, info.isHanging);
		const glyph = (info.isHanging ? 3 : 1) * hd;
		const texel = Math.round(metrics.fontPxPerTexel * glyph);
		const outW = layout.width * texel;
		const outH = layout.height * texel;
		const out = new Uint8ClampedArray(outW * outH * 4);

		// Nearest-neighbour upscale of the base texture.
		for (let y = 0; y < outH; y++) {
			const srcY = Math.floor((y * base.height) / outH);
			for (let x = 0; x < outW; x++) {
				const srcX = Math.floor((x * base.width) / outW);
				const s = (srcY * base.width + srcX) * 4;
				const dpx = (y * outW + x) * 4;
				out[dpx] = base.data[s];
				out[dpx + 1] = base.data[s + 1];
				out[dpx + 2] = base.data[s + 2];
				out[dpx + 3] = base.data[s + 3];
			}
		}

		const font = this.fontData;
		if (font) {
			// Text goes on the board's front face (the entity model's "north") and, when
			// the back carries any, on its back face.
			const sides: [Rect, SignText][] = [[layout.faceRect(board, "north"), front]];
			if (back) sides.push([layout.faceRect(board, "south"), back]);

			for (const [[rx, ry, rw, rh], text] of sides) {
				const clip = {
					x0: rx * texel,
					y0: ry * texel,
					x1: (rx + rw) * texel,
					y1: (ry + rh) * texel,
				};
				const cx = (clip.x0 + clip.x1) / 2;
				const cy = (clip.y0 + clip.y1) / 2;
				const lineHeight = metrics.lineHeight * glyph;
				const dye = this.dyeRgb(text.color);

				// SignRenderer.renderSignText: line m at (m - 2) × lineHeight from the centre, each centred.
				for (let m = 0; m < 4; m++) {
					const line = text.lines[m] ?? "";
					if (line.trim() === "") continue;
					const segments = this.fitToWidth(
						this.applyFormattingCodes(this.parseTextComponent(line)),
						font.glyphWidths,
						metrics.maxWidth
					);
					if (segments.length === 0) continue;
					const width = this.segmentsWidth(segments, font, glyph);
					const x = Math.round(cx - width / 2);
					const y = Math.round(cy - 2 * lineHeight + m * lineHeight);
					this.renderSegments(out, outW, font, glyph, segments, x, y, clip, text.glowing, dye);
				}
			}
		}

		const canvas = this.makeCanvas(outW, outH);
		const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
		ctx.putImageData(new ImageData(out, outW, outH), 0, 0);
		return canvas;
	}

	/**
	 * Draw one line. As the game (SignRenderer.renderSignText / getDarkColor): plain
	 * text in the dye colour darkened to 40%; glowing text in the full dye colour
	 * with an 8-way outline in the darkened colour, cream (#f0ebcc) for black; a
	 * colour a text component sets itself is used as is.
	 */
	private renderSegments(
		pixels: Uint8ClampedArray,
		bufW: number,
		font: NonNullable<typeof this.fontData>,
		glyphScale: number,
		segments: TextSegment[],
		xStart: number,
		yStart: number,
		clip: { x0: number; y0: number; x1: number; y1: number },
		glowing: boolean,
		dye: RGB
	): void {
		const dark = this.darkened(dye);
		if (glowing) {
			const outline: RGB = dye[0] === 0 && dye[1] === 0 && dye[2] === 0 ? [0xf0, 0xeb, 0xcc] : dark;
			const offsets: [number, number][] = [
				[-1, 0],
				[1, 0],
				[0, -1],
				[0, 1],
				[-1, -1],
				[-1, 1],
				[1, -1],
				[1, 1],
			];
			let cursorX = xStart;
			for (const seg of segments) {
				for (const ch of this.toBytes(seg.text)) {
					for (const [dx, dy] of offsets) {
						this.blitGlyph(
							pixels,
							bufW,
							font,
							glyphScale,
							ch,
							outline,
							cursorX + dx * glyphScale,
							yStart + dy * glyphScale,
							clip
						);
					}
					cursorX += font.glyphWidths[ch] * glyphScale;
				}
			}
		}

		let cursorX = xStart;
		for (const seg of segments) {
			const rgb = seg.color !== null ? this.textColorRgb(seg.color) : glowing ? dye : dark;
			for (const ch of this.toBytes(seg.text)) {
				this.blitGlyph(pixels, bufW, font, glyphScale, ch, rgb, cursorX, yStart, clip);
				cursorX += font.glyphWidths[ch] * glyphScale;
			}
		}
	}

	private blitGlyph(
		pixels: Uint8ClampedArray,
		bufW: number,
		font: NonNullable<typeof this.fontData>,
		glyphScale: number,
		ch: number,
		rgb: RGB,
		dstX: number,
		dstY: number,
		clip: { x0: number; y0: number; x1: number; y1: number }
	): void {
		// glyphScale output pixels per font pixel, font.scale texels per font pixel
		const scaledH = Math.round((font.cellH / font.scale) * glyphScale);
		const glyphW = font.glyphWidths[ch] * glyphScale;
		const col = ch % 16;
		const row = Math.floor(ch / 16);
		const gx = col * font.cellW;
		const gy = row * font.cellH;

		for (let py = 0; py < scaledH; py++) {
			const pxY = dstY + py;
			if (pxY < clip.y0 || pxY >= clip.y1) continue;
			const srcY = Math.min(Math.floor((py * font.scale) / glyphScale), font.cellH - 1);
			for (let px = 0; px < glyphW; px++) {
				const pxX = dstX + px;
				if (pxX < clip.x0 || pxX >= clip.x1) continue;
				const srcX = Math.min(Math.floor((px * font.scale) / glyphScale), font.cellW - 1);
				const fontIdx = ((gy + srcY) * font.width + (gx + srcX)) * 4;
				if (fontIdx + 3 >= font.pixels.length) continue;
				const alpha = font.pixels[fontIdx + 3];
				if (alpha === 0) continue;

				const dstIdx = (pxY * bufW + pxX) * 4;
				if (dstIdx + 3 >= pixels.length) continue;

				const a = alpha / 255;
				const inv = 1 - a;
				pixels[dstIdx] = rgb[0] * a + pixels[dstIdx] * inv;
				pixels[dstIdx + 1] = rgb[1] * a + pixels[dstIdx + 1] * inv;
				pixels[dstIdx + 2] = rgb[2] * a + pixels[dstIdx + 2] * inv;
				pixels[dstIdx + 3] = Math.max(alpha, pixels[dstIdx + 3]);
			}
		}
	}

	/**
	 * The part of a line that fits `maxWidth` font pixels (glyphWidths: fontData's, in the
	 * game's 8 px units whatever the font's cell size): the first line the game's
	 * font.split wraps it into. It breaks at the last space that fits (dropping the space),
	 * else before the first character that overflows; the first character always stays.
	 */
	private fitToWidth(
		segments: TextSegment[],
		glyphWidths: Uint8Array,
		maxWidth: number
	): TextSegment[] {
		const cut = (seg: number, at: number): TextSegment[] =>
			[
				...segments.slice(0, seg),
				{ ...segments[seg], text: segments[seg].text.slice(0, at) },
			].filter((s) => s.text !== "");
		let width = 0;
		let hadVisible = false;
		let lastSpace: [number, number] | null = null;
		for (let s = 0; s < segments.length; s++) {
			const text = segments[s].text;
			for (let i = 0; i < text.length; i++) {
				const code = text.charCodeAt(i);
				if (code === 10) return cut(s, i);
				if (code === 32) lastSpace = [s, i];
				const w = glyphWidths[code & 0xff];
				width += w;
				if (hadVisible && width > maxWidth) return lastSpace ? cut(...lastSpace) : cut(s, i);
				hadVisible ||= w !== 0;
			}
		}
		return segments;
	}

	private segmentsWidth(
		segments: TextSegment[],
		font: NonNullable<typeof this.fontData>,
		glyphScale: number
	): number {
		let total = 0;
		for (const seg of segments) {
			for (const ch of this.toBytes(seg.text)) {
				total += font.glyphWidths[ch] * glyphScale;
			}
		}
		return total;
	}

	/** Latin-1 bytes (the ascii font sheet is indexed 0-255). */
	private toBytes(s: string): number[] {
		const out: number[] = [];
		for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
		return out;
	}

	// ── Text component parsing (port of parse_text_component) ────────────────────

	private parseTextComponent(input: string): TextSegment[] {
		const trimmed = input.trim();
		if (trimmed === "") return [];
		// Only an object, array or quoted string is a component: a bare `null`, `true` or
		// `42` is a line someone typed, not JSON.
		if (!/^[{["]/.test(trimmed)) return [{ text: input, color: null }];
		try {
			const value = JSON.parse(trimmed);
			const segments: TextSegment[] = [];
			this.parseJsonValue(value, null, segments);
			return segments;
		} catch {
			return [{ text: input, color: null }];
		}
	}

	/**
	 * A line's § codes read as the game reads them (StringDecomposer.iterateFormatted): § and the
	 * character after it are dropped, so they are neither drawn nor measured; a colour code colours
	 * the rest of its text component and §r goes back to the component's own colour. The other
	 * codes (bold, italic, obfuscated and so on) are dropped without their effect.
	 */
	private applyFormattingCodes(segments: TextSegment[]): TextSegment[] {
		const out: TextSegment[] = [];
		for (const seg of segments) {
			let color = seg.color;
			let text = "";
			const flush = () => {
				if (text !== "") out.push({ text, color });
				text = "";
			};
			for (let i = 0; i < seg.text.length; i++) {
				if (seg.text[i] !== "§") {
					text += seg.text[i];
					continue;
				}
				const code = seg.text[++i]?.toLowerCase();
				const next = code === "r" ? seg.color : (FORMATTING_COLORS[code] ?? color);
				if (next !== color) {
					flush();
					color = next;
				}
			}
			flush();
		}
		return out;
	}

	private parseJsonValue(value: any, parentColor: string | null, segments: TextSegment[]): void {
		if (typeof value === "string") {
			if (value !== "") segments.push({ text: value, color: parentColor });
		} else if (Array.isArray(value)) {
			for (const item of value) this.parseJsonValue(item, parentColor, segments);
		} else if (value && typeof value === "object") {
			const color = typeof value.color === "string" ? value.color : parentColor;
			if (typeof value.text === "string" && value.text !== "") {
				segments.push({ text: value.text, color });
			}
			if (Array.isArray(value.extra)) {
				for (const item of value.extra) this.parseJsonValue(item, color, segments);
			}
		}
	}

	/** The sign's dye colour (front_text.color), black for an unknown name. */
	private dyeRgb(color: string): RGB {
		const n = DYE_TEXT_COLORS[color] ?? 0;
		return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
	}

	/** The game's dark variant: every channel at 40%. */
	private darkened(rgb: RGB): RGB {
		return [Math.floor(rgb[0] * 0.4), Math.floor(rgb[1] * 0.4), Math.floor(rgb[2] * 0.4)];
	}

	/** A text component's own colour: a chat colour name or #rrggbb. */
	private textColorRgb(color: string): RGB {
		switch (color) {
			case "black":
				return [0, 0, 0];
			case "dark_blue":
				return [0, 0, 170];
			case "dark_green":
				return [0, 170, 0];
			case "dark_aqua":
				return [0, 170, 170];
			case "dark_red":
				return [170, 0, 0];
			case "dark_purple":
				return [170, 0, 170];
			case "gold":
				return [255, 170, 0];
			case "gray":
				return [170, 170, 170];
			case "dark_gray":
				return [85, 85, 85];
			case "blue":
				return [85, 85, 255];
			case "green":
				return [85, 255, 85];
			case "aqua":
				return [85, 255, 255];
			case "red":
				return [255, 85, 85];
			case "light_purple":
				return [255, 85, 255];
			case "yellow":
				return [255, 255, 85];
			case "white":
				return [255, 255, 255];
			default: {
				// Support #rrggbb hex colors.
				const m = /^#?([0-9a-fA-F]{6})$/.exec(color);
				if (m) {
					const n = parseInt(m[1], 16);
					return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
				}
				return [0, 0, 0];
			}
		}
	}
}
