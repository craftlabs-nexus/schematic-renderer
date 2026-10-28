import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { AssetLoader } from "../AssetLoader";
import { BlockMeshBuilder } from "../BlockMeshBuilder";
import { uvLockedFace } from "../faceUV";

// uvlock: a variant's textures stay fixed to the world while its model turns (a stair's top grain runs the way the
// planks around it do, an upside-down stair's bricks stay the right way up). It did nothing: the mesh was built
// without the blockstate's x / y and then turned, so every texture turned with it.
// Vanilla's stairs model (26.2): every face's UV is its place on the block, so with uvlock each corner of the turned
// stair has to show the texture at its place in the world.
const stairs = {
	textures: {
		top: "minecraft:block/oak_planks",
		bottom: "minecraft:block/oak_planks",
		side: "minecraft:block/oak_planks",
	},
	elements: [
		{
			from: [0, 0, 0],
			to: [16, 8, 16],
			faces: {
				down: { uv: [0, 0, 16, 16], texture: "#bottom", cullface: "down" },
				up: { uv: [0, 0, 16, 16], texture: "#top" },
				north: { uv: [0, 8, 16, 16], texture: "#side", cullface: "north" },
				south: { uv: [0, 8, 16, 16], texture: "#side", cullface: "south" },
				west: { uv: [0, 8, 16, 16], texture: "#side", cullface: "west" },
				east: { uv: [0, 8, 16, 16], texture: "#side", cullface: "east" },
			},
		},
		{
			from: [8, 8, 0],
			to: [16, 16, 16],
			faces: {
				up: { uv: [8, 0, 16, 16], texture: "#top", cullface: "up" },
				north: { uv: [0, 0, 8, 8], texture: "#side", cullface: "north" },
				south: { uv: [8, 0, 16, 8], texture: "#side", cullface: "south" },
				west: { uv: [0, 0, 16, 8], texture: "#side" },
				east: { uv: [0, 0, 16, 8], texture: "#side", cullface: "east" },
			},
		},
	],
};

function loader() {
	const l = new AssetLoader(false) as any;
	l.getResourceString = async () => undefined;
	return l as AssetLoader;
}

// The texture pixel a point on a side shows when nothing is turned (BlockElement's default UVs), in model pixels.
function worldUV(normal: THREE.Vector3, p: THREE.Vector3): [number, number] {
	const [x, y, z] = [p.x, p.y, p.z];
	if (normal.y > 0.5) return [x, z];
	if (normal.y < -0.5) return [x, 16 - z];
	if (normal.z > 0.5) return [x, 16 - y];
	if (normal.z < -0.5) return [16 - x, 16 - y];
	if (normal.x < -0.5) return [z, 16 - y];
	return [16 - z, 16 - y];
}

// Every corner of the stair built for a variant and turned as Cubane turns it: where it is (model pixels), the way
// its side faces, and the texture pixel it shows.
async function corners(variant: { x?: number; y?: number; uvlock?: boolean }) {
	const builder = new BlockMeshBuilder(loader());
	const mesh = await builder.createBlockMeshNoWater(stairs as any, variant);
	if (variant.y) mesh.rotateY(-(variant.y * Math.PI) / 180);
	if (variant.x) mesh.rotateX(-(variant.x * Math.PI) / 180);
	mesh.updateMatrixWorld(true);
	const out: { at: THREE.Vector3; normal: THREE.Vector3; uv: [number, number] }[] = [];
	mesh.traverse((o) => {
		const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
		if (!g?.attributes.position) return;
		const normalMatrix = new THREE.Matrix3().getNormalMatrix(o.matrixWorld);
		for (let i = 0; i < g.attributes.position.count; i++) {
			const at = new THREE.Vector3()
				.fromBufferAttribute(g.attributes.position, i)
				.applyMatrix4(o.matrixWorld);
			at.addScalar(0.5).multiplyScalar(16);
			const normal = new THREE.Vector3()
				.fromBufferAttribute(g.attributes.normal, i)
				.applyMatrix3(normalMatrix)
				.round();
			const u = g.attributes.uv.getX(i) * 16;
			const v = (1 - g.attributes.uv.getY(i)) * 16;
			out.push({ at, normal, uv: [u, v] });
		}
	});
	return out;
}

const close = (a: [number, number], b: [number, number]) =>
	Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3;

describe("uvlock", () => {
	for (const [name, variant] of [
		["facing=south (y 90)", { y: 90, uvlock: true }],
		["facing=west (y 180)", { y: 180, uvlock: true }],
		["facing=north (y 270)", { y: 270, uvlock: true }],
		["facing=east, half=top (x 180)", { x: 180, uvlock: true }],
		["facing=south, half=top (x 180, y 90)", { x: 180, y: 90, uvlock: true }],
	] as const) {
		it(`keeps every texture fixed to the world: ${name}`, async () => {
			const all = await corners(variant);
			expect(all.length).toBeGreaterThan(0);
			const wrong = all.filter(({ at, normal, uv }) => !close(uv, worldUV(normal, at)));
			expect(
				wrong.map(({ at, uv }) => `${at.toArray().map((c) => c.toFixed(1))} shows ${uv}`)
			).toEqual([]);
		});
	}

	it("lets the texture turn with the model without uvlock", async () => {
		// the same stair turned without uvlock: its top shows the texture turned a quarter, not fixed to the world
		const all = await corners({ y: 90, uvlock: false });
		const top = all.filter(({ normal }) => normal.y > 0.5);
		expect(top.some(({ at, normal, uv }) => !close(uv, worldUV(normal, at)))).toBe(true);
	});

	it("leaves a face alone when nothing is turned", () => {
		expect(uvLockedFace("up", [8, 0, 16, 16], 0, 0, 0)).toEqual({
			uv: [8, 0, 16, 16],
			rotation: 0,
		});
	});
});
