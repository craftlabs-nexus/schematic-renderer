# Schematic Renderer

A powerful, high-performance 3D rendering library for Minecraft schematics (.schematic, .schem, .litematic), built with Three.js and Rust/WASM.

> **`@craftlabs/schematic-renderer`** is the [craftlabs-nexus](https://github.com/craftlabs-nexus/schematic-renderer) fork of [Schem-at/schematic-renderer](https://github.com/Schem-at/schematic-renderer) 1.6.1, under the same AGPL-3.0-only license. Where the instructions below say `schematic-renderer`, read `@craftlabs/schematic-renderer`; the changes are offered upstream. What the fork changes is listed under [Differences from upstream](#differences-from-upstream).

![Schematic Renderer Demo](./preview.gif)

## Differences from upstream

What a user of upstream 1.6.1 notices or needs to know when switching to this fork. Each release's entry in [CHANGELOG.md](./CHANGELOG.md) has the detail; the first fork release is 1.7.0.

### Package and compatibility

- The package is `@craftlabs/schematic-renderer`, published to npm only (not GitHub Packages), from upstream 1.6.1. The build outputs, exports and constructor are the same; the examples below that import `schematic-renderer` apply with the new name.
- Only `three`, `nucleation`, `postprocessing` and `jszip` are dependencies, and none of them is bundled: the consumer's own copies are used (a UMD page provides them as the `THREE`, `Nucleation`, `POSTPROCESSING` and `JSZip` globals). The rest is bundled into `dist` or only builds it, so an install takes 25 packages instead of 121 (1.10.0, unreleased).
- Browser storage: the renderer keeps its texture atlases in IndexedDB `cubane-atlas-cache` (the newest 4; database version 2, which an older renderer cannot open and builds its atlas each time instead) and its block shapes per pack set in `cubane-shape-cache` (the last 8 pack sets). It no longer keeps Cubane's copy of every pack (`cubane-resource-packs`) and clears the copies an earlier version left; the packs themselves (`ResourcePacksDB`) are kept as before. `SchematicRenderer.clearAssetCaches()` deletes what is made from packs; `SchematicRenderer.storageUsage()` reports what is kept (1.10.0).
- A renderer draws with the packs its `ResourcePackManager` has enabled, and those alone: upstream restored the last session's pack at start as well, so a file opened with other packs could be drawn with both (1.10.0).
- Changed behaviour an upstream caller may depend on: `removeSchematic` disposes the schematic at once (a build in flight stops and reports nothing); `updateMesh` is `rebuildMesh`; `getTightWorldBox()` is at the cells' edges (half a block off before); `getPackAssets` lists assets with their namespace (`create:block/stone`); `AssetLoader.invalidateCache()` returns a promise and deletes the cached atlas; `AtlasBuilder` is sized `"auto"` and rejects a pack that does not fit instead of dropping textures; `analyzeTextureTransparency` and `atlasSizeFor` are gone. A sign line is read as JSON or as typed by the file's data version (1.21.5 and later as typed).

### Resource packs and models

- Minecraft 26.x packs: model texture objects (`{ "sprite": ..., "force_translucent": true }`) and the block sign textures (1.7.0).
- Mod namespaces are kept apart through the loader, the atlas and the resolver; a mod's `item/iron_bars` is not drawn with the game's `block/iron_bars`, a mod's `water` or `wall_sign` is drawn from its own blockstate and textures (1.7.0, 1.9.0).
- Fusion connected textures (`"loader": "fusion:model"`, `.png.mcmeta` with a `fusion` section): layouts full, simple, horizontal, vertical and pieced, and the predicates (1.7.0).
- The texture atlas is sized to the pack (2048, 4096 or 8192). A pack that fits none is an error (the pack manager's `error` event, `context: "atlas"`), not a silent drop, and the pack change still takes (1.7.0, 1.9.0).
- Models are read as the game reads them: a multipart `when` of `{ "AND": [...] }`; a model with no elements draws nothing and only a missing model gets the placeholder; a face without a `uv` takes its place on the element (the hopper); `uvlock` keeps textures fixed to the world on turned variants; an element written inside out (`from` past `to`) is drawn about its midpoint; a texture is animated only when its mcmeta has an `animation` section (1.7.0 to 1.10.0 and after).
- `blockEntityModels` option: which block ids use the built-in entity meshes. None by default, so a pack's `blockstates/chest.json` draws chests with their facing and double halves; a chest the pack has no model for is still built in; `null` keeps a block to the pack (shulker boxes, the lectern's book, the bell) (1.7.0, 1.9.0).

### Rendering

- Faces are culled as the game culls them: an opaque full side hides any face against it, a see-through block (glass, ice, slime, copper grates) hides only the same block's, a fluid hides the same fluid, leaves hide nothing, and a block's occlusion follows its blockstate's rotation (an upside-down stair no longer hides the top of the block below). Faces in a block's middle plane are not culled against the neighbour beyond (a repeater torch's side) (1.8.0 and after).
- Translucent textures draw after everything opaque, back to front per 32-block region, so glass in front of water shows in front and blocks seen through glass no longer vanish at some angles. Textures are classified from their pixels as the game's render layers do (1.8.0, 1.9.0).
- Signs: the game's font layout, text scale and colours, glow text, dye colours, 26.x textures, wall and hanging signs facing and placed as in the game, text wrapped to the sign's width, `§` codes not drawn; a mod's sign from the mod's textures (1.7.0, 1.9.0).
- Redstone dust in the game's colour per power level; a lava or water cauldron drawn as a cauldron; chests draw with a vanilla pack again (1.7.0 to 1.9.0).
- Layer ranges and cell groups show some of a schematic's cells without a rebuild, with the faces the hidden cells covered drawn by cap meshes: `setLayerRange`, `setCellGroups`, `setHiddenGroups`, `showCells`, `canShowLayerRange`, and `loadSchematic` options `layerRange`, `cellGroups`, `hiddenGroups`. See [Rendering Bounds](#rendering-bounds-slicing) (1.9.0).
- Camera: the perspective camera's near plane follows the nearest block (`cameraManager.adaptiveNear = false` keeps it as set); fitting an isometric camera resets its zoom; a resize reshapes the isometric camera; screenshots keep the isometric camera's shape and the live view no longer stretches or grows while one is taken; orbit momentum stops instead of creeping (1.7.2 to 1.9.0).
- Builds: a rebuild shows at once instead of waiting a frame per two meshes, and goes on in a hidden tab; a block edit remeshes the neighbour across a chunk face and culls its seams; a build overtaken by a later one stops; the progress bar goes however a build ends (1.8.0, 1.9.0).

### Events and lifecycle

- `schematicRendered` (`{ id, name }`) is emitted when a build is done, and `schematicRenderError` (`{ id, name, error }`) when it fails (1.9.0).
- A removed schematic is let go: upstream kept every schematic ever loaded alive through a watcher that rescheduled itself for good. `SchematicObject.dispose()` frees its meshes, grids and WASM schematic; materials are reference counted through the registry and released per mesh (1.9.0).
- The performance monitor keeps the last 20 sessions and stops its timers when no build is running (1.9.0).

### Build and development

- npm instead of Bun: `npm ci` on Node 22 in CI (one job: lint, format check, type check, test, build) and in the Publish workflow, which publishes a `v*` tag through npm trusted publishing (OIDC, no stored token) with provenance. `package-lock.json` is tracked, with `@swc/core` pinned to 1.15.40 (1.16 breaks `vite build`) (1.7.0, 1.7.1).
- `npm run build:watch`: the ES build with source maps, rebuilt on every change, for an app that uses a checkout instead of the published package (1.8.0).
- `npm run build:wasm` builds the WASM mesher (Rust, `wasm32-unknown-unknown` and wasm-pack) with the build machine's paths remapped out of the binary; the binary is committed under `src/wasm/` (1.9.0).
- `.editorconfig` matching `.prettierrc` (tabs, 100 columns, LF) (1.7.1).

## Features

- **High-Performance Rendering**: Uses Rust/WASM and multi-threaded Web Workers for fast mesh generation.
- **Easy Integration**: Single-file UMD build with bundled WASM and Workers - just drop it in!
- **Zero-Copy Data Transfer**: Utilizes SharedArrayBuffer (when available) for instant data passing between threads.
- **Resource Pack Support**: Load standard Minecraft resource packs (.zip) with automatic texture atlas generation.
- **Interactive Controls**: Orbit, fly, and creative camera modes with smooth transitions.
- **First-Person Fly Mode**: WASD + mouse navigation with pointer lock for immersive exploration.
- **Enhanced Isometric Mode**: True isometric projection with smart framing, customizable angles, and optimized SSAO.
- **Schematic Slicing**: Real-time rendering bounds for inspecting schematic interiors.
- **Simulation**: Optional redstone/mechanism simulation support (powered by Nucleation).
- **Advanced Rendering**: Adaptive SSAO (automatically adjusts for camera mode), SMAA, and Gamma Correction.
- **Unified Sidebar UI**: Tabbed settings panel with fully configurable keyboard shortcuts (modifier keys by default).
- **Customizable Keyboard Shortcuts**: All shortcuts require modifier keys and can be configured, rebound, or disabled.

## Installation

### Method 1: Direct Browser Import (Recommended for simplicity)

The easiest way to use the renderer is to include the UMD build directly. This file contains everything you need, including the WASM binary and Web Worker code, so you don't need to configure any build tools or serve extra files.

```html
<!-- Three.js is required -->
<script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>

<!-- Schematic Renderer -->
<script src="dist/schematic-renderer.umd.js"></script>
```

### Method 2: NPM Package

If you are using a bundler like Vite, Webpack, or Rollup:

```bash
npm install schematic-renderer
# or
yarn add schematic-renderer
# or
bun add schematic-renderer
```

## Basic Usage

### Constructor Signature

The `SchematicRenderer` constructor has the following signature:

```typescript
new SchematicRenderer(
  canvas: HTMLCanvasElement,
  schematicData?: { [id: string]: () => Promise<ArrayBuffer> },
  defaultResourcePacks?: Record<string, () => Promise<Blob>>,
  options?: SchematicRendererOptions
)
```

**Parameters:**

- `canvas` - The HTML canvas element to render to
- `schematicData` - (Optional) An object mapping schematic IDs to async functions that return ArrayBuffers. Pass `{}` if not preloading schematics.
- `defaultResourcePacks` - (Optional) An object mapping pack names to async functions that return Blobs. Pass `{}` if not preloading resource packs.
- `options` - (Optional) Configuration options for the renderer

> **Important:** If you want to pass options but not preload schematics or resource packs, you must explicitly pass empty objects `{}` for the second and third parameters.

### HTML Example

```html
<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>Schematic Renderer</title>
		<style>
			body {
				margin: 0;
				overflow: hidden;
			}
			#canvas {
				width: 100vw;
				height: 100vh;
				display: block;
			}
		</style>
		<script type="importmap">
			{
				"imports": {
					"three": "https://unpkg.com/three@0.181.2/build/three.module.js"
				}
			}
		</script>
	</head>
	<body>
		<canvas id="canvas"></canvas>

		<script type="module">
			import { SchematicRenderer } from "https://unpkg.com/schematic-renderer@1.1.23/dist/schematic-renderer.es.js";

			const canvas = document.getElementById("canvas");

			const renderer = new SchematicRenderer(
				canvas,
				{},
				{},
				{
					enableDragAndDrop: true,
					showGrid: true,
					cameraOptions: {
						position: [20, 20, 20],
					},
				}
			);
		</script>
	</body>
</html>
```

### Preloading Schematics

If you want to preload schematics at initialization:

```javascript
const renderer = new SchematicRenderer.SchematicRenderer(
	canvas,
	{
		// Keys are schematic IDs, values are async functions returning ArrayBuffer
		myHouse: async () => {
			const response = await fetch("/schematics/house.schem");
			return response.arrayBuffer();
		},
		myFarm: async () => {
			const response = await fetch("/schematics/farm.litematic");
			return response.arrayBuffer();
		},
	},
	{}, // No default resource packs
	{
		showGrid: true,
	}
);
```

### Preloading Resource Packs

```javascript
const renderer = new SchematicRenderer.SchematicRenderer(
	canvas,
	{}, // No preloaded schematics
	{
		// Keys are pack names, values are async functions returning Blob
		faithful: async () => {
			const response = await fetch("/packs/faithful.zip");
			return response.blob();
		},
	},
	{
		showGrid: true,
	}
);
```

## Configuration Options

The `SchematicRenderer` constructor accepts an options object to customize behavior.

```javascript
const options = {
    // --- Appearance ---
    backgroundColor: 0x000000,
    showGrid: true,
    showAxes: true,
    showRenderingBoundsHelper: false,

    // --- Performance & Quality ---
    chunkSideLength: 16,        // Size of render chunks (16 recommended)
    meshBuildingMode: 'batched', // 'batched' (fastest), 'incremental', 'immediate'
    targetFPS: 60,              // Target frame rate
    enableAdaptiveFPS: true,    // Reduce FPS when idle to save battery

    // --- Rendering Features ---
    postProcessingOptions: {
        enabled: true,
        enableSSAO: true,       // Screen Space Ambient Occlusion
        enableSMAA: true,       // Anti-aliasing
        enableGamma: true,      // Gamma correction

        // Custom SSAO presets for different camera modes
        // (automatically switches between presets when changing cameras)
        ssaoPresets: {
            perspective: {
                aoRadius: 1.0,
                distanceFalloff: 0.4,
                intensity: 5.0
            },
            isometric: {
                aoRadius: 0.3,        // Smaller radius for orthographic
                distanceFalloff: 0.1, // Less falloff for flatter look
                intensity: 0.8        // Much lower intensity
            }
        }
    },

    // --- Interaction ---
    enableInteraction: true,
    enableDragAndDrop: true,    // Allow dropping schematics/resource packs
    enableGizmos: true,         // Transform controls

    // --- Camera ---
    cameraOptions: {
        position: [10, 10, 10],
        useTightBounds: true,
    },
    enableAutoOrbit: false,     // Orbit camera automatically
    autoOrbitDuration: 20,      // Seconds per rotation

    // --- UI ---
    enableProgressBar: true,
    progressBarOptions: {
        theme: 'dark',
        barColor: '#4CAF50'
    },

    // --- Advanced ---
    wasmMeshBuilderOptions: {
        enabled: true,          // Use Rust/WASM builder (High Performance)
        greedyMeshingEnabled: false // Merge adjacent faces (Experimental)
    },

    // --- Callbacks (See section below) ---
    callbacks: { ... }
};

const renderer = new SchematicRenderer.SchematicRenderer(canvas, {}, {}, options);
```

## Callbacks

The renderer provides extensive callbacks for hooking into lifecycle events, user interactions, and loading states.

```javascript
const options = {
	callbacks: {
		// --- Lifecycle ---
		onRendererInitialized: (renderer) => {
			console.log("Renderer is ready!");
		},

		// --- Loading ---
		onLoadingProgress: (file, progress) => {
			console.log(`Loading ${file.name}: ${progress * 100}%`);
		},
		onInvalidFileType: (file) => {
			alert("Invalid file type! Please drop .schem, .schematic, .litematic, or .zip");
		},

		// --- Schematics ---
		onSchematicLoaded: (id) => {
			console.log(`Schematic '${id}' loaded successfully`);
		},
		onSchematicRendered: (id) => {
			console.log(`Schematic '${id}' meshes created`);
		},
		onSchematicDropped: (file) => {
			console.log("User dropped a schematic file");
		},

		// --- Resource Packs ---
		onResourcePackLoaded: (name) => {
			console.log(`Resource pack '${name}' active`);
		},

		// --- Interaction ---
		onObjectSelected: (object) => {
			console.log("Selected object:", object);
		},
		onObjectDeselected: (object) => {
			console.log("Deselected object");
		},

		// --- Simulation (Redstone) ---
		onSimulationInitialized: (id) => console.log("Sim ready"),
		onSimulationTicked: (tick) => console.log(`Tick: ${tick}`),
		onBlockInteracted: (x, y, z) => console.log(`Clicked block at ${x},${y},${z}`),
	},
};
```

## API Reference

### Core Methods

```javascript
// Load a schematic from URL
await renderer.schematicManager.loadSchematicFromURL("path/to/house.schem", "MyHouse");

// Focus camera on content
renderer.cameraManager.focusOnSchematics();

// Take a screenshot (returns a Promise<Blob>)
const blob = await renderer.takeScreenshot({
	format: "image/png", // or "image/jpeg"
	quality: 0.9, // 0-1, only for jpeg
	width: 1920, // optional, defaults to canvas size
	height: 1080, // optional, defaults to canvas size
});

// Take a screenshot and automatically download it
await renderer.downloadScreenshot("my_screenshot", {
	format: "image/png",
});

// Toggle debug inspector
renderer.toggleInspector();
```

### Rendering Bounds (Slicing)

Control which parts of the schematic are visible. Useful for inspecting interiors.

```javascript
const schematic = renderer.schematicManager.getSchematic("MyHouse");

// Set bounds (minX, minY, minZ, maxX, maxY, maxZ)
// Example: Cut off the top half
schematic.bounds.maxY = 10;

// Reset to full view
schematic.bounds.reset();
```

Bounds rebuild the meshes. To step through the layers, or to hide parts of a build, show some cells instead: the
meshes are built once with their triangles ordered by layer and by cell group (a label of your own for cells you
hide together, such as the rooms or parts of a build), and what is shown switches in a few milliseconds, with no
rebuild. The faces the hidden cells covered on the shown ones (the top layer's tops, a wall beside a hidden room)
are drawn too, so the picture is the same as a build of the shown cells alone.

```javascript
// layers 0 to 29 (schematic y; maxY exclusive)
await schematic.setLayerRange({ minY: 0, maxY: 30 });
// every layer again
await schematic.setLayerRange(null);

// a group for each cell, in Sponge order over the schematic's box: ((y - minY) * length + (z - minZ)) * width + (x - minX)
await schematic.setCellGroups(groups); // a Uint16Array; the build is redone in group order
await schematic.setHiddenGroups([3, 4]); // hide groups 3 and 4
await schematic.showCells({ minY: 0, maxY: 30 }, [3]); // both at once
schematic.isCellShown(x, y, z);

// or from the first build on
await renderer.schematicManager.loadSchematic("MyHouse", bytes, {
	layerRange: { minY: 0, maxY: 30 },
	cellGroups: groups,
	hiddenGroups: [3],
});
```

These resolve `false` when the build cannot do this (greedy meshing, the instanced or WebGPU paths, or the
JavaScript mesher); use bounds there. `canShowLayerRange()` says so in advance. While cells are hidden, the camera's
fit and `getTightWorldBox()` frame the cells shown.

### Camera Modes

Switch between different camera presets, including isometric view:

```javascript
// Switch to isometric mode
renderer.cameraManager.switchCameraPreset("isometric");

// Switch back to perspective
renderer.cameraManager.switchCameraPreset("perspective");

// Switch to first-person view
renderer.cameraManager.switchCameraPreset("perspective_fpv");

// Or from the console:
canvas.schematicRenderer.cameraManager.switchCameraPreset("isometric");
```

#### Customizing Isometric View

The isometric camera now features improved framing that properly accounts for 3D object projection at viewing angles. You can also customize the viewing angles:

```javascript
// Set custom isometric angles
// pitch: vertical angle (0-90°, default ~35.264° for true isometric)
// yaw: horizontal rotation (default 45°)
renderer.setIsometricAngles(40, 45); // Slightly steeper view

// Common presets:
renderer.setIsometricAngles(35.264, 45); // True isometric (default)
renderer.setIsometricAngles(30, 45); // Flatter, more top-down
renderer.setIsometricAngles(45, 45); // Steeper angle
renderer.setIsometricAngles(35.264, 30); // Different rotation

// Reset to true isometric
renderer.resetIsometricAngles();

// Get current angles
const angles = renderer.getIsometricAngles();
console.log(angles); // { pitch: 35.264, yaw: 45 }

// From console:
canvas.schematicRenderer.setIsometricAngles(40, 60);
```

**Improved Framing:** The isometric camera now calculates the projected bounding box based on the viewing angle, ensuring optimal framing regardless of object orientation. This prevents excessive whitespace and provides tighter, more professional-looking views.

### Fly Controls (First-Person Navigation)

The renderer includes first-person fly controls for immersive navigation:

```javascript
// Enable fly mode
renderer.cameraManager.enableFlyControls();

// Disable fly mode (returns to orbit controls)
renderer.cameraManager.disableFlyControls();

// Toggle fly mode
renderer.cameraManager.toggleFlyControls();

// Check if fly mode is active
const isFlying = renderer.cameraManager.isFlyControlsEnabled();

// Customize fly controls settings
renderer.cameraManager.setFlyControlsSettings({
	moveSpeed: 15, // Units per second
	sprintMultiplier: 3.0, // Speed multiplier when holding Shift
	keybinds: {
		forward: "KeyW",
		backward: "KeyS",
		left: "KeyA",
		right: "KeyD",
		up: "Space",
		down: "KeyC",
		sprint: "ShiftLeft",
	},
});
```

**Fly Mode Controls:**

- **Click canvas** - Enter fly mode (locks pointer)
- **WASD** - Move forward/backward/left/right
- **Space** - Ascend
- **C** - Descend
- **Shift** - Sprint (move faster)
- **ESC** - Exit fly mode

### Sidebar UI

The renderer includes a unified sidebar UI with tabbed panels for all settings. The sidebar is hidden by default and can be toggled with keyboard shortcuts.

#### Sidebar Configuration

```javascript
const renderer = new SchematicRenderer.SchematicRenderer(
	canvas,
	{},
	{},
	{
		sidebarOptions: {
			enabled: true, // Enable sidebar (default: true)
			position: "right", // "left" or "right" (default: "right")
			width: 320, // Panel width in pixels
			hiddenByDefault: true, // Start with sidebar hidden (default: true)
			collapsedByDefault: true, // Start collapsed (default: true)
			defaultTab: "controls", // Initial tab when opened
			enableKeyboardShortcuts: true, // Enable shortcuts (default: true)

			// Disable specific tabs
			disabledTabs: ["performance", "export"],

			// Custom keyboard shortcuts (override defaults)
			shortcuts: {
				toggleSidebarVisibility: { key: "KeyM", ctrl: true, shift: true },
				showControls: { key: "Digit1", ctrl: true, shift: true },
			},

			// Per-tab configuration
			tabs: {
				controls: {
					label: "Camera",
					shortcut: { key: "KeyK", ctrl: true },
					onActivate: () => console.log("Controls tab opened"),
					onDeactivate: () => console.log("Controls tab closed"),
				},
			},

			// Callbacks
			onVisibilityChange: (visible) => console.log("Sidebar visible:", visible),
			onTabChange: (tabId) => console.log("Active tab:", tabId),
		},
	}
);
```

#### Default Keyboard Shortcuts

All keyboard shortcuts use modifier keys to prevent conflicts with normal typing:

| Action              | Shortcut         | Description                   |
| ------------------- | ---------------- | ----------------------------- |
| Toggle Sidebar      | `Ctrl+U`         | Expand/collapse sidebar       |
| Toggle Visibility   | `Ctrl+\`         | Show/hide entire sidebar      |
| Controls Tab        | `Ctrl+Shift+1`   | Camera & fly mode settings    |
| Render Settings Tab | `Ctrl+Shift+2`   | Rendering options             |
| Capture Tab         | `Ctrl+Shift+3`   | Screenshot capture            |
| Export Tab          | `Ctrl+Shift+4`   | Model export (OBJ, STL, GLTF) |
| Resource Packs Tab  | `Ctrl+Shift+5`   | Resource pack management      |
| Performance Tab     | `Ctrl+Shift+6`   | FPS and performance stats     |
| Close Sidebar       | `Escape`         | Collapse sidebar              |
| Next Tab            | `Ctrl+Tab`       | Cycle to next tab             |
| Previous Tab        | `Ctrl+Shift+Tab` | Cycle to previous tab         |

> **Note:** On macOS, use `Cmd` instead of `Ctrl`.

#### Runtime Sidebar Control

```javascript
// Show/hide sidebar
renderer.sidebar.showSidebar();
renderer.sidebar.hideSidebar();
renderer.sidebar.toggleVisibility();

// Expand/collapse (keeps tab bar visible)
renderer.sidebar.show("controls"); // Show and switch to tab
renderer.sidebar.hide();
renderer.sidebar.toggle();

// Tab management
renderer.sidebar.showTab("capture");
renderer.sidebar.enableTab("performance");
renderer.sidebar.disableTab("export");

// Configure tabs at runtime
renderer.sidebar.configureTab("controls", {
	shortcut: { key: "KeyC", ctrl: true, shift: true },
	onActivate: () => {
		/* custom logic */
	},
});

// Keyboard shortcut control
renderer.sidebar.enableShortcuts();
renderer.sidebar.disableShortcuts();
renderer.sidebar.setShortcut("toggleSidebar", { key: "KeyU", ctrl: true });
renderer.sidebar.setShortcut("showCapture", null); // Disable shortcut

// Get current state
const state = renderer.sidebar.getState();
// { visible: true, activeTab: "controls", enabledTabs: [...] }

// Access individual panels
renderer.sidebar.panels.controls.setFlyModeEnabled(true);
renderer.sidebar.panels.capture.takeScreenshot();
```

#### SSAO and Isometric Mode

SSAO (Screen Space Ambient Occlusion) automatically adjusts when switching between camera modes. Orthographic cameras (isometric) require different SSAO settings than perspective cameras to avoid overly dark shadows.

**Runtime SSAO Adjustment:**

```javascript
// Customize SSAO for isometric mode
renderer.setSSAOPreset("isometric", {
	aoRadius: 0.3, // Smaller radius for orthographic
	distanceFalloff: 0.1, // Less falloff
	intensity: 0.8, // Lower intensity to prevent darkness
});

// Customize SSAO for perspective mode
renderer.setSSAOPreset("perspective", {
	aoRadius: 1.0,
	distanceFalloff: 0.4,
	intensity: 5.0,
});

// Get current presets
const presets = renderer.getSSAOPresets();
console.log(presets);

// Adjust current SSAO directly (without changing presets)
renderer.setSSAOParameters({
	intensity: 2.0,
	qualityMode: "High",
});
```

**Initialization Options:**

```javascript
const renderer = new SchematicRenderer.SchematicRenderer(
	canvas,
	{},
	{},
	{
		postProcessingOptions: {
			enableSSAO: true,
			ssaoPresets: {
				isometric: {
					aoRadius: 0.3,
					distanceFalloff: 0.1,
					intensity: 0.8,
				},
				perspective: {
					aoRadius: 1.0,
					distanceFalloff: 0.4,
					intensity: 5.0,
				},
			},
		},
		cameraOptions: {
			defaultCameraPreset: "isometric", // Start in isometric mode
		},
	}
);
```

## Shared Renderer (Multiple Instances)

When you need **many renderers on one page** (grids, galleries, comparison views,
side-by-side diffs), give them a shared `SchematicRendererContext`. The context loads
the resource pack / texture atlas **once**, shares a single Web Worker pool for mesh
building, and optionally drives every viewport from **one WebGL context** via
render-and-blit. This removes the per-instance asset duplication and the browser's
hard limit on live WebGL contexts (typically ~8–16).

### Creating a context

```javascript
import { SchematicRenderer, SchematicRendererContext } from "schematic-renderer";

// Load the resource pack ONCE, shared by every renderer.
const context = await SchematicRendererContext.create(
	{
		// Same default-pack callback shape as the SchematicRenderer constructor.
		vanillaPack: () => fetch("/pack.zip").then((r) => r.blob()),
	},
	{
		sharedRenderer: true, // one WebGL context for all views (render-and-blit)
		// showUnknownBlocks: false,
		// resourcePackOptions: { ... },
	}
);
```

### Using it across renderers

Pass the `context` in each renderer's options. Renderers that share a context reuse its
Cubane/atlas and worker pool, and skip their own pack loading entirely:

```javascript
for (const canvas of canvases) {
	const renderer = new SchematicRenderer(
		canvas,
		{},
		{}, // no per-instance packs, the context provides them
		{ context }
	);
	await renderer.schematicManager.loadSchematic("build", arrayBuffer);
}
```

- `sharedRenderer: true` renders each view through the context's single offscreen
  WebGL renderer and blits the result onto the view's 2D canvas. Leave it `false` (the
  default) to share only assets + workers while each view keeps its own WebGL context.
- `context.invalidateAll()` requests a redraw on every attached renderer.
- `context.dispose()` terminates the shared worker pool and WebGL renderer; call it when
  tearing down the page. Disposing an individual renderer detaches it from the context
  without disposing the shared resources.

A complete working example (a grid of viewports through one WebGL context) lives in
`test/pages/shared-renderer.html`.

### Persisting across page navigation (SPA / PWA)

On a full page reload the browser tears down everything (WASM, workers, GL context), so
the renderer re-bootstraps from scratch. SPA navigation libraries
[Livewire `wire:navigate`](https://livewire.laravel.com/docs/4.x/navigate), Turbo,
htmx-boost, instead swap the page **without** discarding the JS VM, so the heavy
pipeline can survive the navigation. Two framework-agnostic primitives make this work:

**1. A persistent context registry.** `SchematicRendererContext.acquire(key, factory)`
builds the context once and caches it on a global registry that outlives navigation;
later views reuse it instantly, no atlas rebuild, no WASM re-instantiation, no worker
respawn:

```javascript
// Runs on every page that shows a schematic. First call builds it; the rest are instant.
const context = await SchematicRendererContext.acquire("viewer", () =>
	SchematicRendererContext.create(
		{ vanillaPack: () => fetch("/pack.zip").then((r) => r.blob()) },
		{ sharedRenderer: true }
	)
);

const renderer = new SchematicRenderer(canvas, {}, {}, { context });
await renderer.schematicManager.loadSchematic("build", arrayBuffer);
```

`SchematicRendererContext.release("viewer")` drops a reference but **keeps the context
warm** by default (that's the point, it survives navigation). Pass
`release("viewer", { dispose: true })` to tear it down when the user truly leaves.

**2. Suspend / resume.** `renderer.suspend()` pauses the render loop without freeing
anything; `renderer.resume()` restarts it. Use these when a viewport scrolls off-screen,
or when a canvas is kept alive across navigation via Livewire `@persist` / Turbo
`data-turbo-permanent`.

#### Livewire example

Keep the canvas in a `@persist` block so it survives `wire:navigate`, and pause/resume
around navigation:

```blade
@persist('schematic-viewer')
  <canvas id="viewer" wire:ignore></canvas>
@endpersist
```

```javascript
let renderer;

document.addEventListener("livewire:navigated", async () => {
	const canvas = document.getElementById("viewer");
	if (!canvas) return;

	if (renderer) {
		renderer.resume(); // same persisted canvas just un-pause
	} else {
		const context = await SchematicRendererContext.acquire("viewer", () =>
			SchematicRendererContext.create(packs, { sharedRenderer: true })
		);
		renderer = new SchematicRenderer(canvas, {}, {}, { context });
	}
	await renderer.schematicManager.loadSchematic("build", await fetchSchematic());
});

// Pause while navigating away; the context + GPU stay in memory.
document.addEventListener("livewire:navigating", () => renderer?.suspend());
```

The same shape works for Turbo (`turbo:load` / `turbo:before-render`) or any SPA router
only the event names change.

## Schematic Diff

The diff engine (powered by Nucleation) compares two schematics and classifies every
change into four buckets **added**, **removed**, **changed** (same position, different
block), and **swapped** (block pairs that exchanged places). Each bucket comes back as a
`SchematicWrapper`, so you can count it, inspect it, or load it straight into a renderer
to visualize the change.

```javascript
import { SchematicWrapper } from "nucleation";

const before = new SchematicWrapper();
before.from_data(new Uint8Array(beforeArrayBuffer));

const after = new SchematicWrapper();
after.from_data(new Uint8Array(afterArrayBuffer));

// diff(other, preset, options) → DiffWrapper
const diff = before.diff(after, "structural", {});

// Metrics
console.log(diff.distance); // total weighted edit distance (0 = identical)
console.log(diff.support); // 0..1, fraction of cells explained by the alignment

// Each bucket is a SchematicWrapper of just those blocks
const added = diff.added();
const removed = diff.removed();
const changed = diff.changed();
const swapped = diff.swapped();
console.log(added.get_block_count(), removed.get_block_count());
```

### Presets

The `preset` controls how strictly blocks are compared (e.g. whether orientation /
state / redstone wiring counts as a change):

- `exact` - every block-state property must match.
- `shape` - compares occupancy/geometry, ignoring most state.
- `structural` - structural equivalence (a good general-purpose default).
- `redstone` - redstone-aware comparison.
- `redstone_survival` - redstone comparison tuned for survival-obtainable builds.

### Fingerprints

`wrapper.fingerprint(preset)` returns a stable string hash of a schematic under a given
preset, handy for deduplication or quick equality checks without a full diff:

```javascript
if (a.fingerprint("structural") === b.fingerprint("structural")) {
	// structurally identical
}
```

### Visualizing a diff

Because each bucket is a `SchematicWrapper`, you can render it like any schematic load
`added`/`removed`/`changed`/`swapped` into separate renderers (ideally sharing one
[`SchematicRendererContext`](#shared-renderer-multiple-instances)) to show the change
side by side. A complete interactive example (drag-and-drop a before/after pair, with the
four buckets rendered and the distance/support stats shown) lives in
`test/pages/diff.html`.

## Development

```bash
# Clone the repository
git clone https://github.com/craftlabs-nexus/schematic-renderer.git
cd schematic-renderer

# Install dependencies
npm install

# Start development server
npm start

# Build for production (outputs to /dist)
npm run build

# Rebuild the WASM mesher (needs Rust, the wasm32-unknown-unknown target and wasm-pack)
npm run build:wasm

# Run tests
npm test

# Run linting
npm run lint
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines on how to contribute to this project.

## License

This project is licensed under the GNU Affero General Public License v3.0.
