import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { CameraManager } from "../CameraManager";
import { frustumCornerStretch, NEAR_MIN, NEAR_RADIUS } from "../../utils/nearPlane";

// the stand-in camera: fov 60, aspect 1
const STRETCH = frustumCornerStretch(60, 1);

// CameraManager.fitNearPlane on a stand-in: one schematic (a 10 × 10 × 10 box, block (x, y, z) a unit cube centred on
// x, y, z in its group) and a perspective camera; the rest of the manager is not needed.
function setup(blocks: [number, number, number][], groupAt = new THREE.Vector3()) {
	const solid = new Set(blocks.map((b) => b.join(",")));
	let lookups = 0;
	const wrapper = {
		get_dimensions: () => [10, 10, 10],
		get_block: (x: number, y: number, z: number) => {
			lookups++;
			return solid.has(`${x},${y},${z}`) ? "minecraft:stone" : "minecraft:air";
		},
	};
	const schematic = {
		group: new THREE.Group(),
		schematicWrapper: wrapper as Record<string, unknown>,
		blocksVersion: 0,
		layers: null as { minY: number; maxY: number } | null,
		// SchematicObject's: what a layer range shows, and a key of it
		isCellShown(_x: number, y: number) {
			return !this.layers || (y >= this.layers.minY && y < this.layers.maxY);
		},
		cellFilterKey() {
			return `${this.blocksVersion}|${JSON.stringify(this.layers)}`;
		},
	};
	const group = schematic.group;
	group.position.copy(groupAt);
	group.updateMatrixWorld(true);
	const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
	const manager = Object.create(CameraManager.prototype) as any;
	Object.assign(manager, {
		adaptiveNear: true,
		nearKey: "",
		nearFrom: new THREE.Vector3(),
		nearDistance: NEAR_RADIUS,
		wrapperIds: new WeakMap(),
		nextWrapperId: 1,
		schematicRenderer: {
			schematicManager: { getAllSchematics: () => [schematic] },
		},
	});
	Object.defineProperty(manager, "activeCamera", { get: () => ({ camera }) });
	return { manager: manager as CameraManager, camera, lookups: () => lookups, solid, schematic };
}

describe("CameraManager.fitNearPlane", () => {
	it("puts the near plane a little short of the nearest block, in the group's own coordinates", () => {
		const { manager, camera } = setup([[5, 5, 5]], new THREE.Vector3(100, 0, -50));
		camera.position.set(105, 9, -45); // block (5, 9, 5) of the group: 3.5 above the block's top
		manager.fitNearPlane();
		expect(camera.near).toBeCloseTo((3.5 * 0.9) / STRETCH);
	});

	it("keeps the near plane short of a block it moves toward without leaving its block", () => {
		const { manager, camera, lookups } = setup([[5, 5, 5]]);
		camera.position.set(5, 8.4, 5); // 2.9 above the block
		manager.fitNearPlane();
		expect(camera.near).toBeCloseTo((2.9 * 0.9) / STRETCH);
		const n = lookups();
		camera.position.set(5, 7.6, 5); // the same block (y 8), now 2.1 above: no new lookups, the 0.8 taken off
		manager.fitNearPlane();
		expect(lookups()).toBe(n);
		expect(camera.near).toBeLessThan(2.1);
		expect(camera.near).toBeCloseTo(((2.9 - 0.8) * 0.9) / STRETCH);
	});

	it("goes to the search's reach with no block near, and to the minimum inside one", () => {
		const far = setup([[0, 0, 0]]);
		far.camera.position.set(9, 9, 9);
		far.manager.fitNearPlane();
		expect(far.camera.near).toBeCloseTo((NEAR_RADIUS * 0.9) / STRETCH);
		const inside = setup([[5, 5, 5]]);
		inside.camera.position.set(5.2, 5, 5);
		inside.manager.fitNearPlane();
		expect(inside.camera.near).toBe(NEAR_MIN);
	});

	it("clips nothing of the nearest block where it is off the view's axis", () => {
		const { manager, camera } = setup([[4, 4, 4]]);
		camera.position.set(2, 2, 8); // looking down -z; the block's nearest corner up and to the right
		camera.updateMatrixWorld(true);
		manager.fitNearPlane();
		const corner = new THREE.Vector3(3.5, 3.5, 4.5); // 4.09 away, but only 3.5 deep
		const ndc = corner.clone().project(camera);
		expect(Math.abs(ndc.x)).toBeLessThan(1); // in view
		expect(Math.abs(ndc.y)).toBeLessThan(1);
		const depth = -corner.clone().applyMatrix4(camera.matrixWorldInverse).z;
		expect(depth).toBeCloseTo(3.5);
		expect(camera.near).toBeLessThan(depth); // 0.9 × 4.09 = 3.68 would cut the corner off
	});

	it("looks again when a block is set in front of a camera that has not moved", () => {
		const { manager, camera, solid, schematic } = setup([[5, 0, 5]]);
		camera.position.set(5, 6, 5); // 5.5 above the block
		manager.fitNearPlane();
		expect(camera.near).toBeCloseTo((5.5 * 0.9) / STRETCH);
		solid.add("5,4,5"); // a block set 1.5 below the camera (SchematicObject.setBlock bumps blocksVersion)
		schematic.blocksVersion++;
		manager.fitNearPlane();
		expect(camera.near).toBeCloseTo((1.5 * 0.9) / STRETCH);
	});

	it("leaves the near plane alone when it is turned off", () => {
		const { manager, camera } = setup([[5, 5, 5]]);
		(manager as any).adaptiveNear = false;
		camera.position.set(5, 9, 5);
		manager.fitNearPlane();
		expect(camera.near).toBe(0.1);
	});

	it("finds blocks anywhere in a schematic whose blocks fill a box away from cell 0", () => {
		// get_dimensions is the size of the box the blocks fill (a part shown alone): 3 × 1 × 3, at 44..46
		const { manager, camera, schematic } = setup([[45, 0, 45]]);
		Object.assign(schematic.schematicWrapper, {
			get_dimensions: () => [3, 1, 3],
			get_tight_bounds_min: () => [44, 0, 44],
			get_tight_bounds_max: () => [46, 0, 46],
		});
		camera.position.set(45, 3, 45); // 2.5 above the block
		manager.fitNearPlane();
		expect(camera.near).toBeCloseTo((2.5 * 0.9) / STRETCH);
	});

	it("does not fit to a block in a layer that is not shown", () => {
		const { manager, camera, schematic } = setup([
			[5, 7, 5],
			[5, 2, 5],
		]);
		camera.position.set(5, 9, 5); // 1.5 above the block at y 7, 6.5 above the one at y 2
		manager.fitNearPlane();
		expect(camera.near).toBeCloseTo((1.5 * 0.9) / STRETCH);
		schematic.layers = { minY: 0, maxY: 5 }; // y 7 hidden
		manager.fitNearPlane();
		expect(camera.near).toBeCloseTo((NEAR_RADIUS * 0.9) / STRETCH); // y 2 is out of reach
	});

	// a hidden schematic is not drawn: its blocks do not pull the plane in
	it("leaves out hidden schematics", () => {
		const { manager, camera, schematic } = setup([[5, 5, 5]]);
		camera.position.set(5, 7, 5); // 1.5 above the block's top
		manager.fitNearPlane();
		const near = camera.near;
		expect(near).toBeCloseTo((1.5 * 0.9) / STRETCH);
		Object.assign(schematic, { visible: false });
		manager.fitNearPlane();
		expect(camera.near).toBeGreaterThan(near);
		Object.assign(schematic, { visible: true });
		schematic.group.visible = false;
		manager.fitNearPlane();
		expect(camera.near).toBeGreaterThan(near);
		schematic.group.visible = true;
		manager.fitNearPlane();
		expect(camera.near).toBeCloseTo(near);
	});
});
