import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { visibleObjects } from "../visibleObjects";

const box = (x: number) => {
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
	mesh.position.set(x, 0, 0);
	return mesh;
};

describe("visibleObjects", () => {
	it("leaves out what is hidden itself or by an ancestor, so a pick goes through it", () => {
		const scene = new THREE.Scene();
		const shown = new THREE.Group();
		const hidden = new THREE.Group();
		hidden.visible = false;
		scene.add(shown, hidden);
		const front = box(0); // hidden by its filter: in front of the one behind
		front.visible = false;
		const behind = box(-3);
		const sign = new THREE.Group();
		sign.visible = false;
		sign.add(box(-1));
		shown.add(front, behind, sign);
		hidden.add(box(-2));
		scene.updateMatrixWorld(true);

		const objects = visibleObjects([shown, hidden]);
		expect(objects).toEqual([shown, behind]);
		const raycaster = new THREE.Raycaster(new THREE.Vector3(5, 0, 0), new THREE.Vector3(-1, 0, 0));
		expect(raycaster.intersectObjects(objects, false)[0].object).toBe(behind);
		// three.js's own recursion picks the hidden ones
		expect(raycaster.intersectObjects([shown, hidden], true)[0].object).toBe(front);
	});
});
