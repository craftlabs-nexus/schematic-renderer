// The perspective camera's near plane, fitted to how close the nearest block is.
//
// A depth buffer's precision is set mostly by the near plane: at distance d, two faces closer than about
// d² / (near · 2^24) fall in the same depth step and fight (z-fighting). Block models put faces very close together on
// purpose (Macaw's roofs overhang their own boxes by 1/1600 of a block), so with a fixed near plane of 0.1 they
// flicker from about 30 blocks away. Nothing can be drawn nearer than the nearest block, so the near plane may sit
// just short of it: a camera hovering a few blocks above a roof gets a near plane dozens of times larger, and the
// same faces stay apart until they are a few pixels across. The near plane cuts by depth, not distance, so it sits
// short of the nearest block's depth at the corners of the view, where depth is least for a given distance.

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

/**
 * How many cells out the nearest block is looked for in a schematic drawn at `scale`, for a search out to `reach`
 * world units: the cells that reach covers, but never more than NEAR_RADIUS (13³ cells at most, as at full size). A
 * schematic scaled down to 0.1 searched 60 cells out (121³ lookups) whenever the view moved; past the cap the near
 * plane sits nearer than it could, which clips nothing.
 */
export function searchRadiusCells(reach: number, scale: number): number {
	return Math.min(Math.ceil(reach / scale), NEAR_RADIUS);
}

/**
 * How much farther from the camera than its depth (its distance along the view axis) a point in view can be: the most
 * is at the corners of the view, sqrt(1 + tan²(fov / 2) · (1 + aspect²)) for a vertical `fovDeg`. The near plane clips
 * by depth, so a block `d` away in a corner of the view is only d / stretch deep.
 */
export function frustumCornerStretch(fovDeg: number, aspect: number): number {
	const t = Math.tan((fovDeg * Math.PI) / 360);
	const stretch = Math.sqrt(1 + t * t * (1 + aspect * aspect));
	return Number.isFinite(stretch) && stretch >= 1 ? stretch : 1;
}

/**
 * The near plane for a camera `distance` blocks from the nearest block: a little short of the shallowest depth that
 * block can have anywhere in view (`stretch`, frustumCornerStretch), never under NEAR_MIN.
 */
export const nearFor = (distance: number, stretch = 1): number =>
	Math.max(NEAR_MIN, (distance * NEAR_SHARE) / stretch);
