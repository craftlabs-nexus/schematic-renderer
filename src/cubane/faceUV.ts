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
