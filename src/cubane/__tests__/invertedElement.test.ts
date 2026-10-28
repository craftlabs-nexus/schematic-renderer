import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { AssetLoader } from "../AssetLoader";
import { BlockMeshBuilder } from "../BlockMeshBuilder";

// An element whose `from` is past its `to` on an axis: the game places its faces at `from` and `to` as written, so
// the box is drawn inside out. Wilder Wild's hollowed logs line their hole that way: the "inner" element runs from
// [13, 0, 3] to [3, 16, 13], its west face at x = 13 and its east face at x = 3, both facing into the hole. The
// element was centred on `from` (x = 13) instead of its midpoint, which moved the lining 5 pixels east, out of the log.
describe("an element turned inside out", () => {
	const files: Record<string, unknown> = {
		"models/minecraft:block/hollow_lining.json": {
			textures: { inside: "minecraft:block/stripped_jungle_log" },
			elements: [
				{
					from: [13, 0, 3],
					to: [3, 16, 13],
					faces: {
						north: { uv: [3, 0, 13, 16], texture: "#inside" },
						east: { uv: [3, 0, 13, 16], texture: "#inside" },
						south: { uv: [3, 0, 13, 16], texture: "#inside" },
						west: { uv: [3, 0, 13, 16], texture: "#inside" },
					},
				},
			],
		},
	};
	function loader() {
		const l = new AssetLoader(false) as any;
		l.getResourceString = async (path: string) => {
			const hit = files[path] ?? files[path.replace("models/", "models/minecraft:")];
			return hit ? JSON.stringify(hit) : undefined;
		};
		return l as AssetLoader;
	}

	// every triangle of the mesh: its corners in model units (0 to 16) and the way it faces (from its winding)
	async function triangles() {
		const l = loader();
		const mesh = await new BlockMeshBuilder(l).createBlockMeshNoWater(
			await l.getModel("minecraft:block/hollow_lining")
		);
		const out: { corners: THREE.Vector3[]; facing: THREE.Vector3 }[] = [];
		mesh.traverse((o) => {
			const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
			if (!g?.attributes.position) return;
			const p = g.attributes.position;
			const index = g.index ? Array.from(g.index.array) : [...Array(p.count).keys()];
			for (let i = 0; i < index.length; i += 3) {
				const corners = [0, 1, 2].map((k) =>
					new THREE.Vector3()
						.fromBufferAttribute(p, index[i + k])
						.addScalar(0.5)
						.multiplyScalar(16)
				);
				const facing = new THREE.Vector3()
					.subVectors(corners[1], corners[0])
					.cross(new THREE.Vector3().subVectors(corners[2], corners[0]))
					.normalize()
					.round();
				out.push({ corners, facing });
			}
		});
		return out;
	}

	it("stays inside the hole, on its walls", async () => {
		const tris = await triangles();
		expect(tris.length).toBe(8);
		for (const { corners } of tris) {
			for (const c of corners) {
				expect(c.x).toBeGreaterThanOrEqual(3 - 1e-4);
				expect(c.x).toBeLessThanOrEqual(13 + 1e-4);
				expect(c.z).toBeGreaterThanOrEqual(3 - 1e-4);
				expect(c.z).toBeLessThanOrEqual(13 + 1e-4);
			}
		}
	});

	it("faces into the hole from each wall", async () => {
		const tris = await triangles();
		// each wall's triangles: where they lie and the way they face
		const at = (axis: "x" | "z", v: number) =>
			tris
				.filter(({ corners }) => corners.every((c) => Math.abs(c[axis] - v) < 1e-4))
				.map((t) => t.facing);
		expect(at("x", 3).map((f) => f.x)).toEqual([1, 1]); // the west wall of the hole faces east
		expect(at("x", 13).map((f) => f.x)).toEqual([-1, -1]); // the east wall faces west
		expect(at("z", 3).map((f) => f.z)).toEqual([1, 1]); // the north wall faces south
		expect(at("z", 13).map((f) => f.z)).toEqual([-1, -1]); // the south wall faces north
	});
});
