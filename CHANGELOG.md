# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `SchematicObject.setLayerRange({ minY, maxY })` (null: every layer) shows a range of layers without meshing again, in a few milliseconds instead of a rebuild: the WASM mesher orders each mesh's triangles by layer, a range points each material's group at the indices its layers take, signs, block entities and connected-texture blocks of other layers are hidden, and the faces the layers left out would have hidden (the top layer's tops, the bottom layer's bottoms) are drawn by cap meshes built for those two layers and kept for the next time. The picture is the one a build of those layers alone gives. `loadSchematic(name, data, { layerRange })` builds with a range from the start; `canShowLayerRange()` is false where the build cannot (greedy meshing, the instanced and WebGPU paths, the JavaScript mesher), and `setLayerRange` then resolves false
- `blockEntityModels` takes `null` for a block id: the block is drawn from the pack alone, without the built-in model it has by default (shulker boxes) or the built-in parts added to its model (the lectern's book, the bell). For an app whose pack has models for them
- The perspective camera's near plane follows the nearest block (`CameraManager.fitNearPlane`, run before every frame; `cameraManager.adaptiveNear = false` keeps the near plane as set): a little short of the nearest block of the loaded schematics (in the box its blocks fill, wherever it starts, and in the layers shown), looked up within six blocks when the camera enters another block or the layers shown change, and of its depth at the corners of the view (where a block at a given distance is least deep: `frustumCornerStretch`), so no part of it in view is clipped. Faces a model puts a hair apart (Macaw's roofs overhang their own boxes by 1/1600 of a block) no longer z-fight from a distance

### Fixed

- Packs whose textures do not fit an atlas no longer leave the renderer half switched: the pack change takes and resolves, the meshes are rebuilt (blocks drawn from their own textures), and the error is logged and emitted as the pack manager's `error` event (`context: "atlas"`) instead of rejecting `addPack`/`togglePack` with the old atlas already gone and the meshes never rebuilt. The same packs are not decoded again only to fail again (`rebuildTextureAtlas` still tries)
- A mod's block named `water`, `lava` or `flowing_*` is drawn from its own blockstate: the liquid shortcut looked at the name alone and drew it as the game's liquid
- A mod's sign is drawn from the mod's own sign textures (its wood from the block name: `biomesoplenty:fir_wall_sign` is fir), or by its own model when the mod has none, instead of being taken over and drawn as oak
- A texture not in the atlas under its own name is looked for under other names in its own namespace only (`atlasLookupVariations`): the fallback to `block/<file name>` dropped the namespace, so a mod's `item/iron_bars` was drawn with the game's `block/iron_bars`
- `ResourcePackManager.getPackAssets` (managers) lists assets with their namespace (`create:block/stone`; the game's own still `block/stone`), as the Cubane manager does: it dropped the namespace, so the same path in two namespaces was reported by `getAssetConflicts` as a conflict, and a mod's asset passed back to `getAssetSource` was looked for under `minecraft`. A conflict's `assetPath` keeps a mod's namespace and path whole (it was cut at the first colon)
- A pack switch forgets what was read from the old packs for connected textures (which textures are connecting sheets, and their layout) and signs (board textures, the font, `SignRenderer.clearCaches`): glass from a pack with a pieced sheet was baked as one after a switch to a pack without, and signs kept the old pack's boards and font (or none, when built before a pack was loaded)
- The missing-texture checkerboard (and any texture backed by pixel data) is drawn opaque: its alpha could not be read through a canvas, so it was drawn translucent, blended and without depth writes. A texture whose pixels cannot be read yet is drawn translucent once and read again on the next call, instead of keeping that material for good
- Blocks with connected textures are drawn in instanced mode too (they have no palette geometry to instance, and were left out), and `getChunkGeometries(chunk, bounds, schematicObject)` returns them as `connectedMeshes`
- Chests, trapped chests and ender chests draw with a vanilla pack again: since `blockEntityModels` became empty by default they were drawn from the pack, whose chest model has no elements (to 1.21) or which has no chest blockstate (26.x), so they vanished. A chest the option leaves out is now built in while the loaded packs have no model with faces for it (`Cubane.prepareBlockEntityModels`, settled per pack set before each build), and drawn from a pack that has one; `null` keeps it to the pack
- The WASM mesher no longer carries the build machine's file paths (rustc writes dependency source paths, under the builder's home directory, into the binary for panic messages, and the binary is inlined into the bundle): `npm run build:wasm` builds it with those paths remapped, refuses to copy a binary that still names the home directory, and a test checks the shipped one
- A multipart `when` of `{ "AND": [...] }` matches when all its conditions do, nested in an `OR` or holding one (Macaw's windows write every case that way and were drawn as nothing); `BlockStateCondition` types it
- An orbit's momentum stops once a frame's step of it would move the picture by less than a quarter of a pixel (`MOMENTUM_STEP_PX`): damping only fades it, so the camera went on creeping, and the scene on being redrawn (shimmer and all), for about twice as long as the motion showed
- A model with no elements draws nothing, as in the game (the vanilla `block/air`, which Macaw's doors name for an open portcullis's middle, was drawn as the purple debug placeholder); only a model that cannot be found, or whose parent cannot (`isMissingModel`), gets the placeholder

## [1.8.1] - 2026-10-23

### Fixed

- A model element's face without a `uv` gets the game's default for that face (from the element's bounds, per direction, as Minecraft's `uvsByFace` does) instead of the whole texture, so the hopper's sides and spout are no longer squished; building a mesh no longer writes the computed UVs back into the shared model
- A lava or water cauldron draws as a cauldron: only `block/water`, `block/lava` and their `_level_N` models are liquids now (a prefix match took `block/lava_cauldron` and `block/water_cauldron_level1` for liquids and drew a cube of lava or water)

## [1.8.0] - 2026-10-23

### Added

- `CameraManager.reshapeCameras(aspect)`: gives every camera a new shape (a perspective camera's aspect, an orthographic one's width at its height), the view left where it is; `focusIfPending()` runs a framing that was put off while the canvas had no size
- `npm run build:watch`: the ES build with source maps, rebuilt on every change, for an app that uses a checkout of the renderer instead of the published package

### Fixed

- Faces in a block's middle plane are no longer culled against the neighbour beyond it: the mesher's test for a face on the block's edge also took 0.0 for one (as if blocks ran from 0 to 1), so a repeater torch's side vanished beside a solid block and the floor showed through. Fixed in the WASM mesher (rebuilt), the JS worker and the WebGPU shader
- Screenshots and recordings of another shape than the canvas keep an isometric camera's proportions (its frustum kept the canvas's shape, so the shot came out stretched), and the live view no longer stretches for a moment while a shot is taken: a still of the current frame covers the canvas meanwhile
- A window resize reshapes the isometric camera too: only the active camera's aspect was set, which an orthographic camera does not have, so the iso view stretched with the window
- A canvas with no size (a hidden panel, a page not laid out yet) no longer frames the camera to NaN, which left the view empty after the canvas got a size: the framing waits until it has one
- Blocks seen through glass no longer vanish at some camera angles. Every block material was transparent, so three.js sorted whole meshes by distance and glass drawn first hid what lay behind it. Each texture is now classified from its pixels, as Minecraft's render layers do: opaque and cutout textures (plain glass, leaves) draw in the opaque pass; translucent ones (stained glass, ice) are blended without depth writes, after everything opaque
- Connected-texture blocks are merged into one mesh per chunk and draw category, with the same shared materials as the palette meshes (they were one object per block, outside the draw-order settings)
- A rebuild no longer waits a frame for every two meshes: meshes are added in slices of a million vertices a frame, so a small build shows at once (changing the shown layers of a large build went from 1-3 s to under 0.1 s), and a build in a hidden tab keeps going instead of stalling until the tab is shown

## [1.7.2] - 2026-10-22

### Fixed

- A screenshot no longer grows the canvas on a display scaled above 100%: the size before the shot is restored in CSS pixels (it was the backing store's, which the pixel ratio then multiplied again), so the live view stays put through a series of shots

### Changed

- Releases are published by the Publish workflow through npm trusted publishing (OIDC, no stored token), with provenance

## [1.7.0] - 2026-10-22

### Added

- `@craftlabs/schematic-renderer`: the fork's package name; published from a `v*` tag by the Publish workflow (npm, `npm ci`), CI on push and pull request
- Fusion connected textures (`"loader": "fusion:model"`, `.png.mcmeta` with a `fusion` section): layouts full, simple, horizontal, vertical and pieced; predicates is_same_block, is_same_state, match_block, match_state, is_direction, and, or, not
- Mod namespaces: resource locations keep their namespace through the loader, the atlas and the resolver (from upstream PR #9, reviewed)
- `blockEntityModels` option: which block ids use the built-in entity meshes; none by default, so a pack's `blockstates/chest.json` draws chests with facing and double-chest halves
- The texture atlas is sized to the pack (2048, 4096 or 8192); a texture that fits none is an error instead of a silent drop

### Fixed

- Minecraft 26.x model texture objects (`{ "sprite": ..., "force_translucent": true }`) resolve (glass, panes, redstone dust)
- Signs: 26.x block textures (`textures/block/<wood>_sign.png`, 32 x 32) besides the entity textures, the game's text scale, four line slots, dye colours (plain at 40%, glow outline, cream for black), back text; wall signs face away from their wall for east and west too; standing and hanging signs turn the right way
- Redstone dust tinted with the game's colour per power level
- Only an mcmeta with an `animation` section makes a texture animated
- ESLint and Prettier configuration for code quality
- Pre-commit hooks with Husky and lint-staged
- GitHub Actions CI/CD pipelines for testing and publishing
- Comprehensive test suite with Vitest
- Dual publishing to npm and GitHub Packages

### Changed

- Standardized on Bun as the package manager
- Updated package.json with repository metadata and keywords

### Removed

- Old `.tgz` package files from the repository

## [1.1.17] - 2025-01-14

### Added

- RenderSettingsUI component for managing render settings
- ExportUI component for schematic export management
- Enhanced camera and schematic handling for tighter framing

### Changed

- Bump version and enhance resource pack management
- Update dependencies

## [1.1.0] - Previous

### Added

- Initial public release
- Three.js-based schematic rendering
- Support for Litematic and NBT formats
- Isometric and perspective camera modes
- SSAO and post-processing effects
- HDRI background support
- Web Worker-based mesh building
- WASM mesh builder option for performance
