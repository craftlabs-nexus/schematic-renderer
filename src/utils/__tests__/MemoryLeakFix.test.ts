import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { disposeObject, disposeGroup, disposeMesh } from "../MemoryLeakFix";
import { MaterialRegistry } from "../../MaterialRegistry";

// What disposing gives back to MaterialRegistry: a merged connected-texture mesh holds a reference to each of its
// materials (userData.holdsMaterialRefs); palette meshes draw with the palette's.
const shared = (color: number) =>
	MaterialRegistry.getMaterial(new THREE.MeshLambertMaterial({ color }));
const holding = (material: THREE.Material) => {
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(), [material]);
	mesh.userData.holdsMaterialRefs = true;
	return mesh;
};

describe("disposing objects drawn with shared materials", () => {
	it("releases each holder's reference, so the material goes with the last", () => {
		const material = shared(0x123401);
		MaterialRegistry.getMaterial(new THREE.MeshLambertMaterial({ color: 0x123401 })); // a second holder's
		const dispose = vi.spyOn(material, "dispose");
		const [a, b] = [holding(material), holding(material)];
		disposeObject(a);
		expect(MaterialRegistry.referenceCount(material)).toBe(1);
		disposeObject(a); // the same mesh again gives back nothing more
		expect(MaterialRegistry.referenceCount(material)).toBe(1);
		const group = new THREE.Group();
		group.add(b);
		disposeGroup(group);
		expect(MaterialRegistry.isShared(material)).toBe(false);
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("leaves a shared material a mesh holds no reference to, and disposes a mesh's own", () => {
		const material = shared(0x123402);
		const own = new THREE.MeshBasicMaterial();
		const disposeOwn = vi.spyOn(own, "dispose");
		disposeObject(new THREE.Mesh(new THREE.BoxGeometry(), [material, own]));
		expect(MaterialRegistry.referenceCount(material)).toBe(1);
		expect(disposeOwn).toHaveBeenCalledTimes(1);
	});
});

describe("disposeMesh and disposeGroup", () => {
	it("dispose everything under them as disposeObject does, an instanced mesh's own buffers included", () => {
		const child = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
		mesh.add(child);
		const disposeChild = vi.spyOn(child.geometry, "dispose");
		disposeMesh(mesh);
		expect(disposeChild).toHaveBeenCalledTimes(1);

		const instanced = new THREE.InstancedMesh(
			new THREE.BoxGeometry(),
			new THREE.MeshBasicMaterial(),
			2
		);
		const onDispose = vi.fn();
		instanced.addEventListener("dispose", onDispose);
		const inner = new THREE.Object3D();
		inner.add(instanced);
		const group = new THREE.Group();
		group.add(inner);
		disposeGroup(group);
		expect(onDispose).toHaveBeenCalledTimes(1);
		expect(group.children).toEqual([]);
	});
});
