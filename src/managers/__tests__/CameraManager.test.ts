import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

// Mock all problematic imports
vi.mock("nucleation", () => ({
	default: vi.fn().mockResolvedValue(undefined),
	SchematicWrapper: class {},
}));
vi.mock("../../workers/MeshBuilder.worker?worker&inline", () => ({
	default: class MockWorker {
		postMessage() {}
		terminate() {}
		onmessage = null;
	},
}));

// Import the static presets for testing without instantiating the full class
import { CameraManager } from "../CameraManager";

describe("CameraManager", () => {
	describe("camera presets", () => {
		it("should have isometric preset defined", () => {
			expect(CameraManager.CAMERA_PRESETS.isometric).toBeDefined();
			expect(CameraManager.CAMERA_PRESETS.isometric.type).toBe("orthographic");
			expect(CameraManager.CAMERA_PRESETS.isometric.controlType).toBe("orbit");
		});

		it("should have perspective preset defined", () => {
			expect(CameraManager.CAMERA_PRESETS.perspective).toBeDefined();
			expect(CameraManager.CAMERA_PRESETS.perspective.type).toBe("perspective");
			expect(CameraManager.CAMERA_PRESETS.perspective.controlType).toBe("orbit");
		});

		it("should have perspective_fpv preset defined", () => {
			expect(CameraManager.CAMERA_PRESETS.perspective_fpv).toBeDefined();
			expect(CameraManager.CAMERA_PRESETS.perspective_fpv.type).toBe("perspective");
			expect(CameraManager.CAMERA_PRESETS.perspective_fpv.controlType).toBe("creative");
		});

		it("should have correct isometric angles", () => {
			const rotation = CameraManager.CAMERA_PRESETS.isometric.rotation;
			// True isometric pitch is ~35.264° which is Math.atan(1/Math.sqrt(2))
			const expectedPitch = -Math.atan(1 / Math.sqrt(2));
			const expectedYaw = (45 * Math.PI) / 180;

			expect(rotation[0]).toBeCloseTo(expectedPitch, 5);
			expect(rotation[1]).toBeCloseTo(expectedYaw, 5);
		});

		it("should have proper control settings for isometric", () => {
			const settings = CameraManager.CAMERA_PRESETS.isometric.controlSettings;
			expect(settings).toBeDefined();
			expect(settings?.enableDamping).toBe(true);
			expect(settings?.enableZoom).toBe(true);
			expect(settings?.enableRotate).toBe(true);
			expect(settings?.enablePan).toBe(true);
		});

		it("should have proper control settings for perspective", () => {
			const settings = CameraManager.CAMERA_PRESETS.perspective.controlSettings;
			expect(settings).toBeDefined();
			expect(settings?.enableDamping).toBe(true);
			expect(settings?.minDistance).toBe(1);
			expect(settings?.maxDistance).toBe(1000);
		});
	});

	describe("isometric angle calculations", () => {
		it("should calculate correct pitch for true isometric", () => {
			// True isometric: camera looks down at ~35.264°
			const pitch = Math.atan(1 / Math.sqrt(2)) * (180 / Math.PI);
			expect(pitch).toBeCloseTo(35.264, 2);
		});

		it("should have 45° yaw for isometric view", () => {
			const yaw = CameraManager.CAMERA_PRESETS.isometric.rotation[1];
			const yawDegrees = yaw * (180 / Math.PI);
			expect(yawDegrees).toBeCloseTo(45, 2);
		});
	});

	describe("camera vectors", () => {
		it("should create valid Vector3 for positions", () => {
			const position = new THREE.Vector3(...CameraManager.CAMERA_PRESETS.perspective.position);
			expect(position).toBeInstanceOf(THREE.Vector3);
			expect(position.y).toBe(20);
			expect(position.z).toBe(20);
		});

		it("should create valid Euler for rotations", () => {
			const rotation = new THREE.Euler(...CameraManager.CAMERA_PRESETS.perspective.rotation);
			expect(rotation).toBeInstanceOf(THREE.Euler);
		});
	});

	describe("FOV settings", () => {
		it("should have reasonable FOV for perspective", () => {
			const fov = CameraManager.CAMERA_PRESETS.perspective.fov;
			expect(fov).toBe(60);
			expect(fov).toBeGreaterThan(30);
			expect(fov).toBeLessThan(120);
		});

		it("should have wider FOV for FPV mode", () => {
			const fov = CameraManager.CAMERA_PRESETS.perspective_fpv.fov;
			expect(fov).toBe(90);
		});
	});

	// A window resize used to set only the active camera's aspect, which an isometric (orthographic) camera does not
	// have: the iso view stretched with the window.
	describe("reshapeCameras", () => {
		it("gives an isometric camera the new width at its height and centre, and a perspective one the aspect", () => {
			const iso = new THREE.OrthographicCamera(-6, 10, 5, -5, 0.1, 1000); // 16 x 10, centred on x = 2
			const persp = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
			const cm = {
				cameras: new Map([
					["iso", { camera: iso }],
					["persp", { camera: persp }],
				]),
			} as any;
			(CameraManager.prototype as any).reshapeCameras.call(cm, 1);
			expect([iso.left, iso.right, iso.top, iso.bottom]).toEqual([-3, 7, 5, -5]);
			expect(persp.aspect).toBe(1);
		});
	});

	// A canvas with no size (a hidden panel, a page not laid out yet) gave the framing an aspect of 0 / 0, which set
	// the camera's position to NaN for good. The focus waits for a size instead.
	describe("framing a canvas with no size", () => {
		const proto = CameraManager.prototype as any;
		function fake(width: number, height: number) {
			const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
			camera.position.set(30, 25, 40);
			return {
				schematicRenderer: {
					schematicManager: { isEmpty: () => false },
					canvas: { width, height },
				},
				cameraOptions: {},
				pendingFocus: null,
				camera,
				viewAspect: proto.viewAspect,
				calculateSchematicBounds: vi.fn(),
				focusOnSchematics: vi.fn(),
			} as any;
		}

		it("puts the focus off and leaves the camera alone", async () => {
			const cm = fake(0, 0);
			await proto.focusOnSchematics.call(cm, { animationDuration: 0 });
			expect(cm.pendingFocus).toEqual({ animationDuration: 0 });
			expect(cm.calculateSchematicBounds).not.toHaveBeenCalled();
			expect(cm.camera.position.toArray()).toEqual([30, 25, 40]);
		});

		it("runs the focus it put off once the canvas has a size", () => {
			const cm = fake(0, 0);
			cm.pendingFocus = { animationDuration: 0 };
			proto.focusIfPending.call(cm);
			expect(cm.focusOnSchematics).not.toHaveBeenCalled();
			cm.schematicRenderer.canvas = { width: 800, height: 500 };
			proto.focusIfPending.call(cm);
			expect(cm.focusOnSchematics).toHaveBeenCalledWith({ animationDuration: 0 });
			expect(cm.pendingFocus).toBeNull();
		});

		it("ignores an aspect that is no number (a resize to 0 × 0)", () => {
			const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
			const cm = { cameras: new Map([["p", { camera }]]), schematicRenderer: {} } as any;
			proto.updateAspectRatio.call(cm, 0 / 0);
			proto.updateAspectRatio.call(cm, 0);
			expect(camera.aspect).toBe(1.6);
		});
	});
});
