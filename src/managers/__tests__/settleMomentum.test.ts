import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CameraManager } from "../CameraManager";
import { momentumPixels, MOMENTUM_STEP_PX } from "../../utils/momentum";

describe("momentumPixels", () => {
	it("measures a turn through the lens and a pan at the target's distance", () => {
		// 60° over 600 px: 573 px a radian
		expect(
			momentumPixels({ theta: 0.001, phi: 0, pan: 0, distance: 30, heightPx: 600, fovDeg: 60 })
		).toBeCloseTo(0.573, 2);
		// a pan of a tenth of the visible height at the target
		const h = 2 * 30 * Math.tan(Math.PI / 6);
		expect(
			momentumPixels({ theta: 0, phi: 0, pan: h / 10, distance: 30, heightPx: 600, fovDeg: 60 })
		).toBeCloseTo(60);
		// orthographic: the arc at the target's distance, over the visible height
		expect(
			momentumPixels({ theta: 0.01, phi: 0, pan: 0, distance: 20, heightPx: 400, orthoHeight: 40 })
		).toBeCloseTo(2);
	});
});

// CameraManager's update on a stand-in with real OrbitControls: a fling, then the frames after the mouse is let go
function orbit() {
	const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
	camera.position.set(0, 10, 30);
	const dom = document.createElement("canvas");
	Object.defineProperty(dom, "clientHeight", { value: 600 });
	const controls = new OrbitControls(camera, dom);
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.update();
	const manager = Object.create(CameraManager.prototype) as any;
	Object.assign(manager, {
		flyControlsEnabled: false,
		activeControlKey: "perspective",
		controls: new Map([["perspective", controls]]),
		rendererDomElement: dom,
	});
	Object.defineProperty(manager, "activeCamera", { get: () => ({ camera }) });
	let changes = 0;
	controls.addEventListener("change", () => changes++);
	return {
		manager: manager as CameraManager,
		controls: controls as any,
		camera,
		changes: () => changes,
	};
}

describe("CameraManager stops orbit momentum once it would not show", () => {
	it("ends a fling once a frame's step is under a quarter pixel, not a thousandth of a block a frame later", () => {
		const settled = orbit(),
			plain = orbit();
		for (const o of [settled, plain]) {
			o.controls._sphericalDelta.theta = 0.05;
			o.controls._panOffset.set(0.5, 0, 0);
		}
		let frames = 0;
		while (frames < 400) {
			settled.manager.update(1 / 60);
			frames++;
			const d = settled.controls._sphericalDelta;
			if (!d.theta && !d.phi && !settled.controls._panOffset.lengthSq()) break;
		}
		let plainFrames = 0;
		for (let c = -1; plainFrames < 400 && c !== plain.changes(); plainFrames++) {
			c = plain.changes();
			plain.controls.update();
		}
		expect(frames).toBeLessThan(plainFrames * 0.6); // the fling ends well sooner...
		expect(settled.changes()).toBeLessThan(plain.changes() * 0.6); // ...with fewer redraws
		// and a few pixels short of where it would have crept to: a quarter pixel over the damping factor at most
		for (let i = 0; i < 400; i++) plain.controls.update();
		const angle = settled.camera.quaternion.angleTo(plain.camera.quaternion);
		expect(angle * (600 / ((60 * Math.PI) / 180))).toBeLessThan(MOMENTUM_STEP_PX / 0.08);
		// nothing moves after it has stopped (beyond float rounding as the controls recompute the position)
		const at = settled.camera.position.clone();
		settled.manager.update(1 / 60);
		expect(settled.camera.position.distanceTo(at)).toBeLessThan(1e-9);
	});

	it("leaves a turn that would still show alone", () => {
		const o = orbit();
		o.controls._sphericalDelta.theta = 0.01; // ~5.7 px still to come, ~0.46 px this frame
		o.manager.update(1 / 60);
		expect(o.controls._sphericalDelta.theta).toBeGreaterThan(0);
	});
});
