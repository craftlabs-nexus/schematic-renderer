import * as THREE from "three";

/** A camera's projection shape, kept to put back after rendering at another size. */
export type CameraShape =
	{ aspect: number } | { left: number; right: number; top: number; bottom: number };

export function saveCameraShape(camera: THREE.Camera): CameraShape {
	const o = camera as THREE.OrthographicCamera;
	if (o.isOrthographicCamera) return { left: o.left, right: o.right, top: o.top, bottom: o.bottom };
	return { aspect: (camera as THREE.PerspectiveCamera).aspect };
}

/**
 * Fits the camera to an output of `aspect` (width / height): a perspective camera's aspect, or an orthographic
 * camera's left and right around its center at its current height, so what it shows keeps its proportions. An
 * orthographic camera has no aspect of its own: setting one left its frustum at the old shape, and a canvas or a
 * capture of another shape showed the view stretched.
 */
export function fitCameraAspect(camera: THREE.Camera, aspect: number): void {
	const o = camera as THREE.OrthographicCamera;
	if (o.isOrthographicCamera) {
		const center = (o.left + o.right) / 2;
		const halfWidth = ((o.top - o.bottom) * aspect) / 2;
		o.left = center - halfWidth;
		o.right = center + halfWidth;
		o.updateProjectionMatrix();
		return;
	}
	const p = camera as THREE.PerspectiveCamera;
	if (!p.isPerspectiveCamera) return;
	p.aspect = aspect;
	p.updateProjectionMatrix();
}

export function restoreCameraShape(camera: THREE.Camera, shape: CameraShape): void {
	if ("aspect" in shape) (camera as THREE.PerspectiveCamera).aspect = shape.aspect;
	else Object.assign(camera as THREE.OrthographicCamera, shape);
	(camera as THREE.PerspectiveCamera | THREE.OrthographicCamera).updateProjectionMatrix();
}
