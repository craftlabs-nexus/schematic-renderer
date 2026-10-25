import * as THREE from "three";

/**
 * The objects under `roots` (the roots included) that are drawn: visible themselves and every ancestor, for picking.
 * three.js's Raycaster tests objects whether they show or not, so a pick through every object of a schematic hit a
 * hidden schematic, or the signs and caps a cell filter hides; pass these to intersectObjects without recursing.
 */
export function visibleObjects(roots: Iterable<THREE.Object3D>): THREE.Object3D[] {
	const out: THREE.Object3D[] = [];
	const walk = (o: THREE.Object3D) => {
		if (!o.visible) return;
		out.push(o);
		for (const child of o.children) walk(child);
	};
	for (const root of roots) {
		let shown = true;
		for (let p = root.parent; p && shown; p = p.parent) shown = p.visible;
		if (shown) walk(root);
	}
	return out;
}
