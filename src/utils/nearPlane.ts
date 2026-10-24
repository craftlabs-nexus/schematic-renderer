// The perspective camera's near plane, fitted to how close the nearest block is.
//
// A depth buffer's precision is set mostly by the near plane: at distance d, two faces closer than about
// d² / (near · 2^24) fall in the same depth step and fight (z-fighting). Block models put faces very close together on
// purpose (Macaw's roofs overhang their own boxes by 1/1600 of a block), so with a fixed near plane of 0.1 they
// flicker from about 30 blocks away. Nothing can be drawn nearer than the nearest block, so the near plane may sit
// just short of it: a camera hovering a few blocks above a roof gets a near plane dozens of times larger, and the
// same faces stay apart until they are a few pixels across.

export type IsSolid = (x: number, y: number, z: number) => boolean;

/**
 * The distance from `p` (in block units, block (x, y, z) a unit cube centred on x, y, z) to the nearest cell
 * `isSolid` says is taken, looked for out to `maxRadius` cells; `maxRadius` when there is none that close. The cells
 * are visited in shells around the point's own cell, nearest first, and the search stops as soon as no farther
 * shell can hold anything nearer.
 */
export function nearestCellDistance(
	p: { x: number; y: number; z: number },
	isSolid: IsSolid,
	maxRadius: number
): number {
	const cx = Math.round(p.x),
		cy = Math.round(p.y),
		cz = Math.round(p.z);
	let best = maxRadius;
	for (let k = 0; k <= maxRadius; k++) {
		// every cell in shell k is at least k - 1 away from a point inside the centre cell
		if (best <= k - 1) break;
		for (let x = cx - k; x <= cx + k; x++)
			for (let y = cy - k; y <= cy + k; y++)
				for (let z = cz - k; z <= cz + k; z++) {
					if (Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - cz)) !== k) continue;
					const dx = Math.max(Math.abs(p.x - x) - 0.5, 0),
						dy = Math.max(Math.abs(p.y - y) - 0.5, 0),
						dz = Math.max(Math.abs(p.z - z) - 0.5, 0);
					const d = Math.hypot(dx, dy, dz);
					if (d < best && isSolid(x, y, z)) best = d;
				}
	}
	return best;
}

export const NEAR_MIN = 0.05,
	NEAR_RADIUS = 6,
	NEAR_SHARE = 0.9;

/** The near plane for a camera `distance` blocks from the nearest block: a little short of it, never under NEAR_MIN. */
export const nearFor = (distance: number): number => Math.max(NEAR_MIN, distance * NEAR_SHARE);
