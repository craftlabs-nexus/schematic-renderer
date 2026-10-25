import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { SignRenderer, BLOCK_SIGN_LAYOUT, ENTITY_SIGN_LAYOUT, SignLayout } from "../SignRenderer";
import { AssetLoader } from "../AssetLoader";

/**
 * The sign's geometry for a block state: which way its front text faces (the normal
 * of the face that samples the board's front rect) and where the board sits in the
 * cell (its centre in cubane's [-0.5, 0.5] block space).
 */
function sign(
	blockName: string,
	properties: Record<string, string>,
	layout: SignLayout = BLOCK_SIGN_LAYOUT
) {
	const sr = new SignRenderer({} as AssetLoader) as any;
	const info = sr.detectSign(blockName, properties);
	const parts = sr.buildParts(info);
	const geometry: THREE.BufferGeometry = sr.buildGeometry(parts, info.facingAngle, layout);
	const board = parts[0].cubes[0];
	const [rx, ry, rw, rh] = layout.faceRect(board, "north");
	const inFront = (u: number, v: number) =>
		u >= rx / layout.width &&
		u <= (rx + rw) / layout.width &&
		v >= ry / layout.height &&
		v <= (ry + rh) / layout.height;
	const pos = geometry.getAttribute("position");
	const uv = geometry.getAttribute("uv");
	const nrm = geometry.getAttribute("normal");
	const idx = geometry.getIndex()!;
	const r = (n: number) => Math.round(n * 100) / 100 + 0; // -0 → 0
	let front: number[] | null = null;
	for (let i = 0; i < idx.count; i += 3) {
		const a = idx.getX(i);
		const b = idx.getX(i + 1);
		const c = idx.getX(i + 2);
		const u = (uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3;
		const v = (uv.getY(a) + uv.getY(b) + uv.getY(c)) / 3;
		if (inFront(u, v)) {
			front = [r(nrm.getX(a)), r(nrm.getY(a)), r(nrm.getZ(a))];
			break;
		}
	}
	// the board is the first cube: its 6 faces × 4 vertices come first
	let cx = 0;
	let cz = 0;
	for (let i = 0; i < 24; i++) {
		cx += pos.getX(i);
		cz += pos.getZ(i);
	}
	return { front, center: [r(cx / 24), r(cz / 24)] };
}

describe("SignRenderer geometry", () => {
	// A wall sign hangs on the block behind it (opposite its facing) and shows its text
	// the way it faces: models/block/template_wall_sign.json puts the board at z 0.33-1.67
	// for facing=south, i.e. on the north edge, front toward +z.
	it("hangs wall signs on the block behind them, text facing out", () => {
		expect(sign("minecraft:oak_wall_sign", { facing: "north" })).toEqual({
			front: [0, 0, -1],
			center: [0, 0.44],
		});
		expect(sign("minecraft:oak_wall_sign", { facing: "south" })).toEqual({
			front: [0, 0, 1],
			center: [0, -0.44],
		});
		expect(sign("minecraft:oak_wall_sign", { facing: "east" })).toEqual({
			front: [1, 0, 0],
			center: [-0.44, 0],
		});
		expect(sign("minecraft:oak_wall_sign", { facing: "west" })).toEqual({
			front: [-1, 0, 0],
			center: [0.44, 0],
		});
	});

	// `rotation` counts 22.5° steps clockwise from south: 0 south, 4 west, 8 north, 12 east
	it("turns standing signs clockwise from south", () => {
		expect(sign("minecraft:spruce_sign", { rotation: "0" })).toEqual({
			front: [0, 0, 1],
			center: [0, 0],
		});
		expect(sign("minecraft:spruce_sign", { rotation: "4" }).front).toEqual([-1, 0, 0]);
		expect(sign("minecraft:spruce_sign", { rotation: "8" }).front).toEqual([0, 0, -1]);
		expect(sign("minecraft:spruce_sign", { rotation: "12" }).front).toEqual([1, 0, 0]);
	});

	it("does the same for hanging signs", () => {
		expect(sign("minecraft:oak_hanging_sign", { rotation: "0", attached: "false" }).front).toEqual([
			0, 0, 1,
		]);
		expect(sign("minecraft:oak_hanging_sign", { rotation: "12", attached: "false" }).front).toEqual(
			[1, 0, 0]
		);
	});

	// HangingSignRenderer centres a wall hanging sign in its cell, its board across the wall
	// it hangs from (on its left or right), front toward `facing`, the plank running into the wall.
	it("centres wall hanging signs, the plank running out of the wall", () => {
		const plank = (facing: string) => {
			const sr = new SignRenderer({} as AssetLoader) as any;
			const info = sr.detectSign("minecraft:oak_wall_hanging_sign", { facing });
			const parts = sr.buildParts(info);
			const geometry: THREE.BufferGeometry = sr.buildGeometry(
				parts.filter((p: any) => p.cubes[0].part === "bar"),
				info.facingAngle,
				BLOCK_SIGN_LAYOUT
			);
			geometry.computeBoundingBox();
			const { min, max } = geometry.boundingBox!;
			const px = (n: number) => Math.round(n * 16) + 0; // in sixteenths
			return { x: [px(min.x), px(max.x)], z: [px(min.z), px(max.z)] };
		};
		expect(sign("minecraft:oak_wall_hanging_sign", { facing: "north" })).toEqual({
			front: [0, 0, -1],
			center: [0, 0],
		});
		expect(sign("minecraft:oak_wall_hanging_sign", { facing: "south" })).toEqual({
			front: [0, 0, 1],
			center: [0, 0],
		});
		expect(sign("minecraft:oak_wall_hanging_sign", { facing: "east" })).toEqual({
			front: [1, 0, 0],
			center: [0, 0],
		});
		expect(sign("minecraft:oak_wall_hanging_sign", { facing: "west" })).toEqual({
			front: [-1, 0, 0],
			center: [0, 0],
		});
		// the 4-wide plank spans the cell across the facing, edge to edge between the walls
		expect(plank("north")).toEqual({ x: [-8, 8], z: [-2, 2] });
		expect(plank("east")).toEqual({ x: [-2, 2], z: [-8, 8] });
	});

	// HangingSignModel.evaluateVisibleParts: the plank only on wall hanging signs; ceiling
	// signs hang by two straight chains, or by V-shaped chains when attached.
	it("picks a hanging sign's plank and chains by block state", () => {
		const sr = new SignRenderer({} as AssetLoader) as any;
		const parts = (block: string, properties: Record<string, string>) =>
			sr
				.buildParts(sr.detectSign(block, properties))
				.flatMap((p: any) => p.cubes.map((c: any) => c.part));
		const chains = ["chain", "chain", "chain", "chain"];
		expect(parts("minecraft:oak_wall_hanging_sign", { facing: "north" })).toEqual([
			"hanging_board",
			"bar",
			...chains,
		]);
		expect(parts("minecraft:oak_hanging_sign", { rotation: "0", attached: "false" })).toEqual([
			"hanging_board",
			...chains,
		]);
		expect(parts("minecraft:oak_hanging_sign", { rotation: "0", attached: "true" })).toEqual([
			"hanging_board",
			"v_chains",
		]);
	});

	it("draws flat chains from both sides", () => {
		const sr = new SignRenderer({} as AssetLoader) as any;
		const info = sr.detectSign("minecraft:oak_hanging_sign", { rotation: "0", attached: "true" });
		const geometry: THREE.BufferGeometry = sr.buildGeometry(
			sr.buildParts(info),
			info.facingAngle,
			ENTITY_SIGN_LAYOUT
		);
		// the board's 6 faces, then the V chains' front twice, facing opposite ways
		const nrm = geometry.getAttribute("normal");
		expect(nrm.count).toBe(24 + 8);
		expect(nrm.getZ(24) + nrm.getZ(28)).toBeCloseTo(0);
		expect(Math.abs(nrm.getZ(24))).toBeCloseTo(1);
	});

	it("faces the same way with the legacy 64 × 32 texture layout", () => {
		expect(sign("minecraft:oak_wall_sign", { facing: "east" }, ENTITY_SIGN_LAYOUT).front).toEqual([
			1, 0, 0,
		]);
		expect(sign("minecraft:spruce_sign", { rotation: "4" }, ENTITY_SIGN_LAYOUT).front).toEqual([
			-1, 0, 0,
		]);
	});

	it("samples the front face where each layout keeps it", () => {
		const sr = new SignRenderer({} as AssetLoader) as any;
		const board = sr.buildParts(sr.detectSign("minecraft:oak_wall_sign", { facing: "north" }))[0]
			.cubes[0];
		expect(BLOCK_SIGN_LAYOUT.faceRect(board, "north")).toEqual([0, 2, 24, 12]);
		expect(BLOCK_SIGN_LAYOUT.faceRect(board, "south")).toEqual([0, 16, 24, 12]);
		expect(ENTITY_SIGN_LAYOUT.faceRect(board, "north")).toEqual([2, 2, 24, 12]);
		expect(ENTITY_SIGN_LAYOUT.faceRect(board, "south")).toEqual([28, 2, 24, 12]);
	});
});

describe("SignRenderer text", () => {
	// as font/ascii: letters 5 px wide plus 1 px spacing, a space 4 px
	const glyphWidths = new Uint8Array(256).fill(6);
	glyphWidths[32] = 4;
	const fit = (segments: { text: string; color: string | null }[], maxWidth: number) =>
		(new SignRenderer({} as AssetLoader) as any).fitToWidth(segments, glyphWidths, maxWidth);
	const plain = (text: string) => [{ text, color: null }];

	// The game keeps the first line font.split wraps each line into: 90 px on a sign, 60 on a hanging sign.
	it("keeps the part of a line that fits the sign's width", () => {
		expect(fit(plain("a".repeat(15)), 90)).toEqual(plain("a".repeat(15)));
		expect(fit(plain("a".repeat(16)), 90)).toEqual(plain("a".repeat(15)));
		expect(fit(plain("a".repeat(16)), 60)).toEqual(plain("a".repeat(10)));
		// a break at the last space that fits, the space dropped
		expect(fit(plain("aaaaa aaaaaaaaaaa"), 90)).toEqual(plain("aaaaa"));
		// across text components, each keeping its colour
		expect(
			fit(
				[
					{ text: "aaaa", color: "red" },
					{ text: "a".repeat(12), color: null },
				],
				60
			)
		).toEqual([
			{ text: "aaaa", color: "red" },
			{ text: "aaaaaa", color: null },
		]);
	});

	// 1.17-1.19 signs: Text1-Text4 with the glow ink in a GlowingText byte
	it("reads a legacy sign's glowing text", () => {
		const sr = new SignRenderer({} as AssetLoader) as any;
		const legacy = { Text1: '{"text":"Hi"}', Color: "red" };
		expect(sr.extractSignText({ ...legacy, GlowingText: 1 }).front).toEqual({
			lines: ['{"text":"Hi"}', "", "", ""],
			color: "red",
			glowing: true,
		});
		expect(sr.extractSignText({ ...legacy, GlowingText: 0 }).front.glowing).toBe(false);
		expect(sr.extractSignText(legacy).front.glowing).toBe(false);
	});

	it("reads only objects, arrays and quoted strings as text components", () => {
		const sr = new SignRenderer({} as AssetLoader) as any;
		expect(sr.parseTextComponent("null")).toEqual(plain("null"));
		expect(sr.parseTextComponent("true")).toEqual(plain("true"));
		expect(sr.parseTextComponent("42")).toEqual(plain("42"));
		expect(sr.parseTextComponent('"null"')).toEqual(plain("null"));
		expect(sr.parseTextComponent('{"text":"null","color":"red"}')).toEqual([
			{ text: "null", color: "red" },
		]);
		expect(sr.parseTextComponent('["a",{"text":"b"}]')).toEqual([
			{ text: "a", color: null },
			{ text: "b", color: null },
		]);
	});
});
