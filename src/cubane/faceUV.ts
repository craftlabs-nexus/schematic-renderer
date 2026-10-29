import { FACE_NORMAL, rotateFace, type Face } from "./ConnectedTextures";

/**
 * The UV a model face takes when it names none, as Minecraft works it out (BlockElement.uvsByFace): the face's own
 * place on its element, projected onto the texture, so a small element shows the part of the texture where it sits
 * instead of the whole texture squeezed onto it (a hopper's rim and funnel, a stair's step, a lectern's book).
 * Coordinates are model pixels (0..16); the result is [u0, v0, u1, v1].
 */
export function defaultFaceUV(
	element: { from?: number[]; to?: number[] },
	direction: string
): [number, number, number, number] {
	const [fx, fy, fz] = element.from ?? [0, 0, 0];
	const [tx, ty, tz] = element.to ?? [16, 16, 16];
	switch (direction) {
		case "down":
			return [fx, 16 - tz, tx, 16 - fz];
		case "up":
			return [fx, fz, tx, tz];
		case "south":
			return [fx, 16 - ty, tx, 16 - fy];
		case "west":
			return [fz, 16 - ty, tz, 16 - fy];
		case "east":
			return [16 - tz, 16 - ty, 16 - fz, 16 - fy];
		case "north":
		default:
			return [16 - tx, 16 - ty, 16 - fx, 16 - fy];
	}
}

/** The face as drawn: its own UV, or the default for its place on the element (a copy; the model is left alone). */
export function withFaceUV<T extends { uv?: number[] }>(
	faceData: T,
	element: { from?: number[]; to?: number[] },
	direction: string
): T {
	return faceData.uv ? faceData : { ...faceData, uv: defaultFaceUV(element, direction) };
}

// ---- uvlock ---------------------------------------------------------------------------------------------------------
// A blockstate variant with `uvlock: true` keeps its textures fixed to the world while its model turns: a stair's top
// keeps its grain running the way the planks around it do, whichever way the stair faces. The game does it by giving
// each face a new UV and texture rotation before the face is turned with the model (FaceBakery.recomputeUVs, with
// BlockMath.getUVLockTransform); this is that computation.

type M4 = number[]; // column-major 4x4

const mul = (a: M4, b: M4): M4 => {
	const out = new Array(16).fill(0);
	for (let c = 0; c < 4; c++)
		for (let r = 0; r < 4; r++)
			for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
	return out;
};
const apply = (m: M4, v: [number, number, number, number]): [number, number, number, number] => {
	const out: [number, number, number, number] = [0, 0, 0, 0];
	for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[r] += m[k * 4 + r] * v[k];
	return out;
};
const translate = (x: number, y: number, z: number): M4 => [
	1,
	0,
	0,
	0,
	0,
	1,
	0,
	0,
	0,
	0,
	1,
	0,
	x,
	y,
	z,
	1,
];
// right-handed rotations by `deg` about x and y, exact for quarter turns
const trig = (deg: number) => {
	const q = ((Math.round(deg / 90) % 4) + 4) % 4;
	return [
		[1, 0],
		[0, 1],
		[-1, 0],
		[0, -1],
	][q] as [number, number];
};
const rotX = (deg: number): M4 => {
	const [c, s] = trig(deg);
	return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
};
const rotY = (deg: number): M4 => {
	const [c, s] = trig(deg);
	return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
};
// the inverse of a rotation is its transpose
const transpose = (m: M4): M4 => [0, 1, 2, 3].flatMap((c) => [0, 1, 2, 3].map((r) => m[r * 4 + c]));

// BlockMath.VANILLA_UV_TRANSFORM_LOCAL_TO_GLOBAL: a face's texture plane from the south face's
const LOCAL_TO_GLOBAL: Record<string, M4> = {
	south: rotY(0),
	east: rotY(90),
	west: rotY(-90),
	north: rotY(180),
	up: rotX(-90),
	down: rotX(90),
};

/** A blockstate's x / y as the game turns a model: y after x, both clockwise seen from the positive axis. */
function modelRotation(x: number, y: number): M4 {
	return mul(rotY(-y), rotX(-x));
}

/**
 * The UV and texture rotation a face takes under a blockstate's x / y with uvlock on (FaceBakery.recomputeUVs): the
 * face is then drawn with them and turned with its model as any other, and its texture comes out fixed to the
 * world. `uv` is the face's [u0, v0, u1, v1] (its own, or defaultFaceUV), `rotation` its texture rotation.
 */
export function uvLockedFace(
	direction: string,
	uv: readonly number[],
	rotation: number,
	x: number,
	y: number
): { uv: [number, number, number, number]; rotation: number } {
	const r = modelRotation(x, y);
	const face: Face = direction in FACE_NORMAL ? (direction as Face) : "up";
	// the side it ends up on, as the culling and the connected textures turn faces (they agree with modelRotation)
	const facing = rotateFace(face, x, y);
	// GLOBAL_TO_LOCAL(face) · R⁻¹ · LOCAL_TO_GLOBAL(facing), about the block's corner: from the turned face's texture
	// plane back through the turn to the model face's
	const t = mul(mul(transpose(LOCAL_TO_GLOBAL[face]), transpose(r)), LOCAL_TO_GLOBAL[facing]);
	const m = mul(mul(translate(0.5, 0.5, 0.5), t), translate(-0.5, -0.5, -0.5));

	const [u0, v0, u1, v1] = uv;
	const a = apply(m, [u0 / 16, v0 / 16, 0, 1]);
	const b = apply(m, [u1 / 16, v1 / 16, 0, 1]);
	const [nu0, nv0, nu1, nv1] = [a[0], a[1], b[0], b[1]].map((v) => Math.round(v * 16 * 1e4) / 1e4);
	// the new rectangle runs the way the old one did on each axis; the turn goes to the rotation
	const [minU, maxU] = Math.sign(u0 - u1) === Math.sign(nu0 - nu1) ? [nu0, nu1] : [nu1, nu0];
	const [minV, maxV] = Math.sign(v0 - v1) === Math.sign(nv0 - nv1) ? [nv0, nv1] : [nv1, nv0];
	const rad = (rotation * Math.PI) / 180;
	const dir = apply(m, [Math.cos(rad), Math.sin(rad), 0, 0]);
	const turned = Math.round((Math.atan2(dir[1], dir[0]) * 180) / Math.PI / 90) * 90;
	return { uv: [minU, minV, maxU, maxV], rotation: ((-turned % 360) + 360) % 360 };
}
