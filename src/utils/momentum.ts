// The orbit controls' momentum (damping), stopped once what is left of it would not show.
//
// With damping on, three's OrbitControls apply a share of the remaining turn and pan every frame and keep the rest,
// so the motion fades geometrically and never reaches zero: the controls go on reporting a change, and the scene on
// being redrawn, until the camera moves less than a thousandth of a block a frame, long after the picture has stopped
// visibly moving (and any shimmer of the redrawn frames goes on with it). A frame's step is the damping factor's share
// of what is left (which adds up to exactly the delta still held, a geometric series); once that step would move the
// picture by less than a quarter of a pixel the motion no longer reads as motion, only as shimmer, and it is dropped:
// the camera stops at most a few pixels (a quarter over the damping factor) short of where the tail would have taken
// it, a distance it would have crept over dozens of frames.

/** Below this many pixels in a frame's step, the momentum is stopped. */
export const MOMENTUM_STEP_PX = 0.25;

export interface MomentumView {
	/** the turn still to come, radians: azimuth and polar */
	theta: number;
	phi: number;
	/** the pan still to come, world units */
	pan: number;
	/** the camera's distance to the orbit target */
	distance: number;
	/** the canvas height in pixels */
	heightPx: number;
	/** a perspective camera's vertical field of view in degrees, or an orthographic camera's visible height (world
	 *  units, zoom applied) */
	fovDeg?: number;
	orthoHeight?: number;
}

/**
 * How far, in pixels, the remaining momentum would still move the picture: a turn by its angle as seen through the
 * lens (perspective: the field of view's pixels per radian; orthographic: the arc at the target's distance), a pan
 * by its length at the target's distance.
 */
export function momentumPixels(v: MomentumView): number {
	const turn = Math.hypot(v.theta, v.phi);
	if (v.orthoHeight !== undefined) {
		const pxPerUnit = v.heightPx / Math.max(v.orthoHeight, 1e-9);
		return (turn * v.distance + v.pan) * pxPerUnit;
	}
	const fov = ((v.fovDeg ?? 50) * Math.PI) / 180;
	const pxPerRad = v.heightPx / fov;
	const visibleHeight = 2 * Math.max(v.distance, 1e-9) * Math.tan(fov / 2);
	return turn * pxPerRad + (v.pan / visibleHeight) * v.heightPx;
}
