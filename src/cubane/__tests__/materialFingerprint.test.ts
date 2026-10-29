import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { materialFingerprint } from "../ShapeCache";

// A kept shape (ShapeCache) is restored only when the material made again from its spec has the fingerprint it was
// kept with. Its UVs point into the atlas, so the fingerprint has to hold where the texture sits there: without it a
// shape kept with one atlas layout was restored on another and sampled the wrong textures.
function atlasMaterial(atlasUV: { u: number; v: number; width: number; height: number }) {
	const m = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
	Object.assign(m.userData, {
		useAtlas: true,
		texturePath: "block/stone",
		alphaClass: "opaque",
		atlasUV,
	});
	return m;
}

describe("materialFingerprint", () => {
	it("tells the same texture at another place in the atlas apart", () => {
		const here = atlasMaterial({ u: 0.25, v: 0.5, width: 1 / 64, height: 1 / 64 });
		const there = atlasMaterial({ u: 0.5, v: 0.25, width: 1 / 64, height: 1 / 64 });
		expect(materialFingerprint(here)).not.toBe(materialFingerprint(there));
	});

	it("matches the same material made again", () => {
		const uv = { u: 0.25, v: 0.5, width: 1 / 64, height: 1 / 64 };
		expect(materialFingerprint(atlasMaterial(uv))).toBe(
			materialFingerprint(atlasMaterial({ ...uv }))
		);
	});
});
