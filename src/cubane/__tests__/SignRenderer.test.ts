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
		expect(sign("minecraft:oak_wall_hanging_sign", { facing: "north" })).toEqual({
			front: [0, 0, -1],
			center: [0, 0.44],
		});
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
