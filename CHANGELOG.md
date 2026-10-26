# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The package depends only on what its build leaves out or its types name: `three`, `nucleation`, `postprocessing` and `jszip`. The rest is bundled into `dist` (`@ffmpeg/ffmpeg`, `lil-gui`, `n8ao`, `three-creative-controls`) or only builds it (the Vite plugins, `concurrently`), so they are dev dependencies now, and eleven packages nothing used are gone (`chokidar`, `deepmerge`, `fs-extra`, `gif.js.optimized`, `gzip-js`, `http-proxy-middleware`, `pako`, `simplex-noise`, `stats-js`, `webm-writer`, `@ffmpeg/util`). An install takes 25 packages instead of 121, and none of the ones `npm audit` flagged (`http-proxy-middleware`, an old `uuid`) come with it

## [1.9.0] - 2026-10-25

### Added

- `schematicRenderError` event (`{ id, name, error }`) when a schematic's build fails
- `SchematicObject.setLayerRange({ minY, maxY })` (null: every layer) and `setHiddenGroups(groups)` show some of a schematic's cells without meshing again, in a few milliseconds instead of a rebuild: a range of layers, and all but some cell groups (`setCellGroups`: a label for each cell, such as a part of a build; `showCells(range, groups)` sets both at once). The WASM mesher orders each mesh's triangles by layer and cell group, a filter points each material's groups at the index ranges of what it shows, signs, block entities and connected-texture blocks of hidden cells are hidden, and the faces the hidden cells covered on the shown ones (the top layer's tops, a wall beside a hidden part) are drawn by cap meshes built for that filter and kept for the next time. The picture is the one a build of the shown cells alone gives. `loadSchematic(name, data, { layerRange, cellGroups, hiddenGroups })` builds with them from the start; the camera's fit and `getTightWorldBox()` frame the cells shown; `canShowLayerRange()` is false where the build cannot (greedy meshing, the instanced and WebGPU paths, the JavaScript mesher), and the calls then resolve false
- `blockEntityModels` takes `null` for a block id: the block is drawn from the pack alone, without the built-in model it has by default (shulker boxes) or the built-in parts added to its model (the lectern's book, the bell). For an app whose pack has models for them
- The perspective camera's near plane follows the nearest block (`CameraManager.fitNearPlane`, run before every frame; `cameraManager.adaptiveNear = false` keeps the near plane as set): a little short of the nearest block of the loaded schematics (in the box its blocks fill, wherever it starts, and among the cells shown), looked up within six blocks when the camera enters another block or what is shown changes, and of its depth at the corners of the view (where a block at a given distance is least deep: `frustumCornerStretch`), so no part of it in view is clipped. Faces a model puts a hair apart (Macaw's roofs overhang their own boxes by 1/1600 of a block) no longer z-fight from a distance

### Fixed

- Fitting an isometric camera (`focusOnSchematics`) resets its zoom: the framing sized the frustum but kept the zoom the wheel had left, so a fit after zooming in looked like it did nothing
- A removed schematic is let go: each one ran a property watcher that rescheduled itself every 250 ms for good, which kept every schematic ever loaded (its meshes' arrays, cell grids, WASM schematic) alive and polling. `SchematicObject.dispose()` (called by `removeSchematic`) stops it, drops the meshes, grids, caps and caches, and frees the WASM schematic it was parsed into once every build and rebuild in flight is over (a wrapper passed to `loadSchematic` stays the caller's; `createEmptySchematic`'s own is freed). `removeSchematic` disposes at once, mid-build or after a failed build, instead of waiting for the build: a build still running stops at its next step and reports nothing (no `onSchematicRendered`, `schematicRendered` or `schematicRenderComplete` for a file no longer shown), and no build starts after removal; `disposeGroup` frees lines and points too
- `precomputePaletteGeometries` reuses the last palette's geometry only when every entry is the same: it compared the length and the first and last entries, so a file whose palette differed only in between was drawn with the last file's blocks
- The `schematicRendered` event is emitted (with the schematic's id and name) when a build is done, alongside the `onSchematicRendered` callback
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
- Translucent blocks draw back to front: stained glass in front of water (and slime or honey beside glass) shows in front. Every block mesh draws at one renderOrder (by category, water always drew over the glass in front of it), and the triangles of translucent materials go to meshes of their own, one per 32-block region, which three.js sorts by distance; each keeps its layer runs, so layer ranges and hidden cell groups still show without a rebuild. Overlapping translucent faces inside one region still blend in mesh order
- Hanging signs show the parts their block state calls for: a wall hanging sign its plank and two chains, a ceiling one two straight chains, or V-shaped chains when `attached`; a wall hanging sign sits in the middle of its cell, across the wall it hangs from, instead of half outside it
- Sign text keeps only what fits the sign's width (90 pixels, 60 on a hanging sign) and breaks at a space, as the game does, instead of running to the board's edges
- Signs from 1.17 to 1.19 show their glowing text (`GlowingText`), and a sign line reading `null`, `true` or a number shows that word instead of nothing
- Connected textures keep their seams on the right edges on turned blocks (y-rotated variants, sideways pillars, a face's own rotation): the neighbours were read in the model's frame, not the drawn texture's
- A connected-texture slab or other partial block no longer loses a face, leaving a hole, beside a differently shaped block of its kind: a face is culled only where the same block's faces against it cover it
- Connected-texture materials are freed when their chunks are disposed or rebuilt: a merged mesh held one registry reference a face, not one a mesh, a rebuild disposed them under the other meshes still using them, and a material shared by several meshes was released only once. Building many connected-texture blocks is faster (a block's models and faces are read once per block string)
- Connected glass panes hide the faces where they meet a pane beside, above or below them again, and the connected mesh cache tells a multipart block's models apart (two arms of one model turned differently got one mesh); a connected mesh still being built when the pack changes is not kept
- Each schematic meshes against its own palette: with two schematics of different palettes in a scene, one's layer caps and chunk rebuilds used the other's blocks. Two overlapping builds of one palette no longer race its cache (the second could mesh against the previous palette)
- A schematic's opacity multiplies its materials' own, on copies of them: a fade set water and lava fully opaque, and changed the materials other schematics share
- Layer and cell-group filters: caps are kept by the cell grid's version, so a filter set between a block edit and its remesh is not kept stale; a filter applied while the schematic is hidden shows its signs, block entities and caps when the schematic is shown again; the `layerRange` a schematic is made with is taken as `setLayerRange` takes it (an open top no longer hangs the page); a filter takes effect once its caps are ready, and a rebuild or removal meanwhile drops it; a caps build that fails draws no caps instead of never finishing, and gives its worker back; a cut through connected-texture blocks shows the faces the hidden cells covered
- A schematic hidden before it is built is built once it is shown (it stayed empty for good, as did one rebuilt while hidden)
- The progress bar a build shows goes however the build ends (finished, failed or stopped by removal), and stays while another build still shows it: a stopped or failed build left it on screen, and one schematic's build could hide another's
- A chunk meshed again after a batched build (a block edit) is cut out of the batch's meshes instead of being drawn twice: the batch kept the chunk's old faces, so a removed block stayed visible
- A chunk meshed again after a block edit culls its seam faces against its neighbours' blocks, as a full build does (it drew the faces along its edges, visible with water), and an edit of a block on a chunk's face remeshes the neighbour across that face, so the face the removed block covered shows
- Loading a schematic (from a file or a URL) hides the progress bar only once no build still shows it
- A build overtaken by a later one (a rebuild while the first build runs, a schematic hidden, rebuilt and shown mid-build) stops and lets go of what it made, instead of both being drawn; `setCellGroups` during a build rebuilds; a filter cleared during a build reaches the meshes it added; a failed build is logged and emitted as `schematicRenderError`; `updateMesh` is `rebuildMesh`; a rebuild of a faded schematic keeps its regions faded, and caps take the schematic's opacity when shown
- Chunk edits: an edit outside the schematic's original box is drawn; two rebuilds of one chunk (edits on both sides of a seam), or an edit during a full build, draw it once; an edit landing after removal adds nothing; the edited chunk is filtered before it is shown; a multi-chunk edit builds its caps once; the cell grid follows rendering bounds and grows with the schematic; immediate and incremental builds fill it too, so their layer ranges and hidden groups get caps
- Chunks cut out of a batch leave it once they are a quarter of it, a batch whose last chunk is cut lets go of its buffers, and exports leave out the cut triangles
- `loadSchematic` frees the WASM schematic it made when the file cannot be read; `addSchematic` with a name in use removes and disposes the schematic it replaces
- Two builds at once each hear their own workers' answers (chunk and batch requests are told apart by build), a request waiting for a worker meshes against its palette though it is dropped meanwhile (a worker refuses a palette it does not know instead of meshing nothing), and `WorldMeshBuilder.dispose` settles every request in flight or waiting
- Signs: a font with larger cells grows the text texture only as far as it needs, within 4096 px (a hanging sign's could pass 5000); a sign built across a pack switch keeps nothing it read from the old packs; the mesh builder writes a block state's string one way (properties sorted), so connected blocks are read once a state
- The near plane is fitted to the shown schematics only, and the instanced path's rendering bounds no longer draw one layer past their top
- The caps kept for other filters stay within a budget (32 MB of arrays, 16 filters, the least recently used dropped), and caps not on screen give back their GPU buffers
- Picking (a click, hover, the tilt-shift focus) hits only what is drawn, not a hidden schematic or the cells a filter hides
- The isometric zoom-in fits its frustum as the plain fit does (its zoom reset to 1)
- Sign text from a font with larger cells (an HD pack) fits and draws at the game's size, and `§` formatting codes are neither drawn nor counted in a line's width (colour codes colour what follows). A hanging sign's flat chains show their back from the texture strip beside their front, as the game unwraps a flat cube
- The performance monitor keeps the last 20 build sessions and stops its timers when no build is running: every build added a session for good, and the memory and frame timers ran on after the first. A build that fails ends its session, and an older build ending no longer stops a newer one's monitoring

### Changed

- `disposeObject` disposes the materials it finds that the material registry does not hold (sign and multi-material faces), and gives registry materials back once per mesh that took them
- `invalidateCache` (`Cubane.getAssetLoader()`) deletes the atlas cached in IndexedDB (no longer a localStorage entry), and returns a promise
- `getTightWorldBox()` without a filter gives the cells' edges, as it does with one (it was half a block off, so a fit moves by half a block)
- A sign line is read as a JSON text component by the file's data version: before 1.21.5 as JSON, from 1.21.5 a plain string as typed (`[1]`, `"hi"`); with no version, only a line that holds a valid text component is JSON
- A pack's zip is scanned for its assets in one place (`scanPackAssets`); CI checks formatting again

### Removed

- `analyzeTextureTransparency` from the asset loader and `atlasSizeFor` from the atlas builder (no callers; the atlas is sized by `buildAtlas`)

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

## [1.7.1] - 2026-10-22

### Added

- `.editorconfig` matching `.prettierrc` (tabs, 100 columns, LF)

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

### Changed

- The fork's first release, based on upstream 1.6.1 (upstream's releases 1.1.18 to 1.6.1 have no entries here)
- npm instead of Bun for installs and the workflows: CI and Publish run `npm ci` on Node 22, `package-lock.json` is tracked (with `@swc/core` pinned to 1.15.40, as `bun.lock` has it: 1.16 breaks `vite build`), and the pre-commit hook runs lint-staged through `npx` where Bun is not installed. Releases go to npm only (upstream also published to GitHub Packages)

## [1.1.17] - 2026-01-14

### Added

- RenderSettingsUI component for managing render settings
- ExportUI component for schematic export management
- Enhanced camera and schematic handling for tighter framing
- ESLint and Prettier configuration for code quality
- Pre-commit hooks with Husky and lint-staged
- GitHub Actions CI/CD pipelines for testing and publishing
- Comprehensive test suite with Vitest
- Dual publishing to npm and GitHub Packages

### Changed

- Bump version and enhance resource pack management
- Update dependencies
- Standardized on Bun as the package manager
- Updated package.json with repository metadata and keywords

### Removed

- Old `.tgz` package files from the repository

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
