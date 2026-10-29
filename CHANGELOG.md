# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.11.0] - 2026-10-29

### Changed

- pnpm instead of npm for installs, CI and the Publish workflow (publishing itself is still `npm publish`, for trusted publishing): `pnpm-lock.yaml` replaces `package-lock.json` (and upstream's `bun.lock`), and `package.json` names the version (`packageManager`). `pnpm-workspace.yaml` keeps `node_modules` flat and installs the Windows and Linux x64 native binaries both (esbuild, Rolldown, SWC, Lightning CSS), so a checkout shared by Windows and WSL builds from either without reinstalling; it carries the `@swc/core` 1.15.40 pin npm's `overrides` held. `.pnpmfile.mjs` gives vitest a Vite of its own, as npm did: pnpm filled its Vite peer with this project's Vite 4
- Faces are culled as the game culls them (`workers/faceCulling.ts`, `faceHiddenBy`, which the WASM mesher mirrors in both its mesh and its greedy paths). An opaque full side hides any face against it; a full side that is not opaque (glass, ice, slime, honey, copper grates, spawners: cutout or translucent textures) hides only the same block's face; a fluid's face is hidden by the same fluid; leaves hide nothing (the game's fancy leaves). Each palette entry carries a `cullKey` (`"solid"`, or the block id) and a `fluid`, and each of its geometries a `fluid`; they replace culling by render category. A side counts as opaque when one full face on it is (a grass block's cutout overlay lies over its opaque side)
- Water and lava are matched by their ids, and glass, ice and leaves as words of a block id, for render categories: `water_cauldron` and `lava_cauldron` are no longer water, and `rice_bag` is no longer ice
- The shape cache is version 6: shapes kept by an earlier version are made again once
- `postprocessing` and `jszip` are external in the build, as the dependencies they are: the consumer's own copies are used, not ones bundled into `dist` (a bundled `postprocessing` failed `instanceof` against an `Effect` the consumer made). A UMD page needs them as the `POSTPROCESSING` and `JSZip` globals
- Every IndexedDB database is opened one way (`utils/idb.ts`): no IndexedDB, a failed open, or one another tab blocks is no database (the pack stores still wait for a blocking tab); every connection closes for another tab's newer version or a delete, and the kept ones open again on next use; `storageUsage` and `clearAssetCaches` open a database only if it exists
- The build's performance record counts the geometry it made and the blocks it drew (it recorded estimates); the `[WorkerStats]` and `[ChunkTiming]` logs (NaN averages from the WASM mesher) and the stack trace `dispose()` logged are gone
- `rebuildAllChunks()` returns the rebuild's promise; `getChunkGeometries` takes the chunk's `apronBlocks` as `getChunkMesh` does
- `SchematicObject.isCellDrawn(x, y, z)`: whether a block is drawn in a cell (not air, inside the rendering bounds, shown by the filter), from the cell grid once built
- The atlas cache keeps each atlas as a PNG, encoded once the page is idle (version 3; it read the raw pixels back on the main thread as the renderer became usable, up to 256 MB at 8192², and kept them whole). Atlases an earlier version kept are dropped once, and built again
- The shape cache writes a palette's shapes in batches of 200, waiting for the page to be idle between them (one transaction held the page's IndexedDB for the whole palette), and counts its size from an index of each shape's bytes (`storageUsage` read every shape). Its database is version 2; shapes an earlier version kept are made again once
- The camera's near plane looks for the nearest block at most 6 cells out, however small the schematic is drawn (one scaled to 0.1 searched 60 cells out, 121³ lookups, whenever the view moved)
- Normals are 8-bit on WebGL (a normalized `Int8` attribute: 3 bytes a vertex instead of 12): they were widened to floats for every mesh. WebGPU still gets floats
- A chunk's connected-texture meshes are merged once (they were merged again for each material), and Cubane keeps the last 4096 connected-texture meshes it made (it kept every one until a pack switch)
- The WASM mesher copies only the vertices of the faces it keeps into a chunk's mesh (it copied each block's whole shape, its culled faces too, and drew from part of it)
- Cubane writes a pack's bytes to its store once (`persistPacks`): every save wrote every pack again

### Fixed

- A connected-texture (Fusion) block hides its neighbours' faces and has its own faces hidden by an opaque neighbour, as every other block does: it had no palette entry, so nothing culled against it, and Cubane culled its faces only against the same block
- The camera's near plane fits to the blocks drawn: it ignored the rendering bounds, and looked each cell up in the schematic
- A block string with a `:` in a property value is read whole (`Cubane.parseBlockString`); cave and void air are air to the connected-texture lookup; a palette written with its properties in another order is the same palette
- `export()` holds the progress bar as builds do: it hid a running build's bar
- The atlas cache no longer reads every atlas's pixels into memory to list them (`getCacheInfo`), and a cache miss is no longer an error caught as one (`loadCachedAtlas`)
- A block's occlusion follows its blockstate's `x` / `y` (`Cubane.analyzeModelGeometry`): an upside-down stair claimed its full slab side faced down and hid the top of the block below it
- `uvlock` keeps a turned variant's textures fixed to the world, as the game's `FaceBakery.recomputeUVs` does (`faceUV.uvLockedFace`): a stair facing south showed its top turned a quarter, an upside-down one its bricks upside down. Blocks with connected textures are left as they were
- An element written inside out (`from` past `to` on an axis, as Wilder Wild's hollowed logs line their hole) is placed about its midpoint: it was placed about its `from`, and the lining stood 5 pixels off, half out of the log
- Stone beside slime, honey or a copper grate keeps its face (it was culled, and the see-through block showed nothing behind it); glass beside leaves, ice or glass of another colour keeps its faces on both sides; a waterlogged block keeps its own sides next to water (only its water culls against water)
- Blocks with connected textures are drawn in incremental and immediate builds and after a block edit on a page without `SharedArrayBuffer`: `getChunkMesh` moved the chunk's own array to the worker and then built them from the emptied array. A worker now gets a copy (`blocksForWorker`), and the caller's array is left whole
- A pack switch while a palette builds (`invalidateCache`) no longer leaves the palette made from the old packs in use, with materials already disposed: that build ends stale, is neither kept nor sent to the workers, and `precomputePaletteGeometries` builds again from the new packs. Its shapes are not kept in the shape cache under the old packs either
- A kept shape is restored only with the atlas layout it was made with: a material's fingerprint holds where its texture sits in the atlas, so a shape kept before a change of atlas layout is made again instead of sampling the wrong textures
- An incremental build with rendering bounds culls the faces on a chunk's seam only against neighbours the bounds keep: a neighbour cut off by the bounds is not drawn, and the face against it was culled, which showed a hole along the cut
- `AssetLoader.rebuildTextureAtlas()` frees the atlas it replaces (it stayed on the GPU, up to 8192² RGBA a rebuild)
- A schematic built empty and then edited shows a layer range or hidden groups: no cell grid was begun for it, so `setLayerRange` resolved `true` and hid nothing, made no caps and framed every block. Whether a schematic is built no longer goes by how many meshes it has
- A chunk rebuilt after an edit is in the build's list of objects (`getMeshes`, `canShowLayerRange`) in place of the one it replaced, which stayed there disposed
- A `layerRange` or `hiddenGroups` given at load to a build that cannot show one (greedy meshing, instanced, WebGPU, the JavaScript mesher) is dropped with a warning: it stayed half applied, the framing, picking and the objects tagged with their layer following it while every layer of the meshes drew
- An instanced build returns only the meshes it added: it returned every child of the group (regions, the bounds helper, the caps shown, a later build's meshes), and a build stopped meanwhile disposed them all. The rendering bounds helper is not added to a schematic removed or rebuilt while its build finished
- A builder on a shared `SchematicRendererContext` disposed while it holds workers gives them back to the pool, to a builder waiting for one first, and drops in them the palettes its requests held: the pool lost them for good, and once all were gone every renderer on the context waited for a worker for ever
- Material references: a palette dropped releases the registry references its build took (they only grew until a pack switch), an instanced render releases those of the connected-texture meshes it replaces (it freed only their geometry), and a batch that fails frees the meshes it built
- The atlas and shape caches close their IndexedDB connections when another tab opens a newer version or `clearAssetCaches` deletes the database (both waited for them for the page's life), and open them again when next used. A shape cache blocked once by another tab is tried again at the next build (it stayed off for good)
- Sign textures are kept to 128 MB, the least recently used let go first: one was kept per text and colour until the packs changed, a hanging sign with a 16 px font 64 MB of it
- Palettes building at once are each built once: a third build of the first of two palettes building at once built it again
- Whether the packs draw chests, asked across a pack switch, keeps the new packs' answer: the old packs' came later and was written over it, and a chest the new packs draw stayed built in
- A palette name without a namespace (`water`) is read as the game's for render categories and fluids
- A layer range with an end left out (`{ maxY: 5 }` from JavaScript) takes that end for the schematic's: it hid every cell
- `meshBuildingMode: "batched"` with the JavaScript mesher builds incrementally, with a warning: its workers take no batch, and the build waited for good. The JavaScript mesher keeps each palette by its mesh context and drops it when told, as the WASM mesher does: two schematics of different palettes meshed against whichever was sent last

## [1.10.0] - 2026-10-26

### Added

- A palette's block shapes are kept between visits (`cubane/ShapeCache.ts`, IndexedDB `cubane-shape-cache`): per block state, the geometry `precomputePaletteGeometries` makes from its models, its occlusion flags and what each face material was made from (`FaceMaterialSpec`; `BlockMeshBuilder.materialFromSpec` makes it again from the session's atlas, checked against the material it was kept with, so a mismatch is made from the models as before), with the textures' alpha classes. Keyed by the packs' content hash, the options that change a block's mesh (`showUnknownBlocks`, `blockEntityModels`) and `SHAPE_CACHE_VERSION`; the last 8 pack sets are kept. Entity models, fallbacks and empty shapes are not kept. A 1031-state landscape builds its palette in 0.22 s on a repeat load instead of 2.3 s, with the same geometry, and its page holds about 90 MB less (no per-block meshes and model caches made)
- `SchematicRenderer.clearAssetCaches()` (static) deletes what the renderer keeps that is made from packs: the texture atlases, the block shapes and the pack copies Cubane kept before this version. The packs themselves are left alone
- `SchematicRenderer.storageUsage()` (static): the packs, atlases, block shapes and old pack copies kept in this browser, as counts and bytes, without reading pixels or pack bytes
- Cubane's `persistPacks` option (default `true`): `false` keeps no copy of the packs and restores none at start, for when something else keeps them

### Changed

- The atlas cache keeps the newest 4 atlases (it kept one per pack set for good, each its raw pixels: 64 MB at 4096²). Its database is version 2, with indexes by time and by size; an older renderer cannot open it and builds its atlas each time instead
- The package depends only on what its build leaves out or its types name: `three`, `nucleation`, `postprocessing` and `jszip`. The rest is bundled into `dist` (`@ffmpeg/ffmpeg`, `lil-gui`, `n8ao`, `three-creative-controls`) or only builds it (the Vite plugins, `concurrently`), so they are dev dependencies now, and eleven packages nothing used are gone (`chokidar`, `deepmerge`, `fs-extra`, `gif.js.optimized`, `gzip-js`, `http-proxy-middleware`, `pako`, `simplex-noise`, `stats-js`, `webm-writer`, `@ffmpeg/util`). An install takes 25 packages instead of 121, and none of the ones `npm audit` flagged (`http-proxy-middleware`, an old `uuid`) come with it

### Fixed

- A renderer draws with the packs its `ResourcePackManager` has enabled, and those alone. Cubane kept its own copy of every pack (IndexedDB `cubane-resource-packs`) and restored the last session's at start, which `initializeResourcePacks` took for the packs loaded: a file opened with other packs than the last was drawn with the last session's pack as well (the blocks both define could come from it, and the atlas held both). `SchematicRenderer` and `SchematicRendererContext` now make Cubane with `persistPacks: false`, and the renderer clears the copies an earlier version kept (the copies were never deleted either: a new one under a new id at every pack switch, hundreds of MB). With Cubane on its own, `removePack` deletes a pack's saved copy and `saveState` lets go of those no longer held

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
