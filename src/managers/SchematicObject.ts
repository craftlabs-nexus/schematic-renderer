// managers/SchematicObject.ts
import { disposeObject } from "../utils/MemoryLeakFix";
import { CellBox, schematicBox } from "../utils/schematicBox";
import * as THREE from "three";
import { applyLayerRange, CellFilter, LayerRange, shownBy } from "../utils/layerRange";
import {
	SchematicWrapper,
	IoTypeWrapper,
	LayoutFunctionWrapper,
	ExecutionModeWrapper,
	BlockPosition,
	DefinitionRegionWrapper,
	CircuitBuilderWrapper,
	SortStrategyWrapper,
} from "../nucleationExports";
import { WorldMeshBuilder } from "../WorldMeshBuilder";
import { EventEmitter } from "events";
import { SceneManager } from "./SceneManager";
// Removed unused imports since we're no longer using reactive proxy
import { resetPerformanceMetrics } from "../monitoring";
import { SchematicRenderer } from "../SchematicRenderer";
import type { BlockData } from "../types";
import { performanceMonitor } from "../performance/PerformanceMonitor";
import { nextFrame } from "../utils/nextFrame";
import { SchematicExporter } from "../export/SchematicExporter";
import type { ExportOptions, ExportFormat, ExportResult } from "../types/export";

// Define chunk data interface to fix TypeScript errors

import { EditableRegionHighlight } from "./highlight/EditableRegionHighlight";
import { cutChunkFromBatch } from "../utils/batchChunks";
import { holdProgressBar, releaseProgressBar } from "../utils/progressBar";
import { formatBlockString } from "../cubane/blockString";

export class SchematicObject extends EventEmitter {
	// ... existing imports and properties ...
	public name: string;
	public schematicWrapper: SchematicWrapper;
	private schematicRenderer: SchematicRenderer;
	private meshes: THREE.Mesh[] = [];

	private worldMeshBuilder: WorldMeshBuilder;
	private eventEmitter: EventEmitter;
	private sceneManager: SceneManager;
	private chunkMeshes: Map<string, THREE.Object3D[]> = new Map();
	private chunkDimensions: any = {
		chunkWidth: 16,
		chunkHeight: 16,
		chunkLength: 16,
	};

	public id: string;
	public group: THREE.Group;

	// Public properties without underscores
	public position: THREE.Vector3;
	public rotation: THREE.Euler;
	public scale: THREE.Vector3;
	public opacity: number;
	public visible: boolean;

	public meshBoundingBox: [number[], number[]];
	public renderingBounds: {
		min: THREE.Vector3;
		max: THREE.Vector3;
		helper?: THREE.Box3Helper;
		enabled?: boolean;
	};

	// Reactive bounds for direct manipulation
	public bounds: {
		minX: number;
		minY: number;
		minZ: number;
		maxX: number;
		maxY: number;
		maxZ: number;
	};

	// the build that gave the schematic its meshes (the first, or the one made when it was shown after its builds
	// were skipped while hidden); `builds` is every build in flight (the first, rebuilds, chunk rebuilds), which
	// dispose() waits on before it frees the WASM schematic they read
	private meshesReady: Promise<void>;
	private builds: Promise<void> = Promise.resolve();
	// A hidden schematic is not built: its build (the first, or a rebuild) is skipped and made once it is shown
	// (updateMeshVisibility). True while one was skipped and none has been made since.
	private unbuilt = false;
	// The builds of this schematic in flight that may show the progress bar (buildSchematicMeshes, rebuildMesh).
	// The bar they showed is let go once the last of them ends, however it ends: finished, failed or stopped by
	// removal (withBuildProgress).
	private progressBuilds = 0;

	// Cache for dimensions to avoid repeated calls
	private _cachedDimensions: [number, number, number] | null = null;
	/** Goes up whenever the schematic's blocks may have changed (a block set, a rebuild), for caches of what is where. */
	public blocksVersion = 0;
	// Goes up whenever the cell grid is written (fillCellGrid, writeCellGrid): the caps and the box of what shows are
	// of the grid, which a block edit reaches only once its chunk is meshed again, so they are kept by this version.
	private gridVersion = 0;
	// What is shown (setLayerRange, setHiddenGroups): a range of layers and the cell groups left out; the cap meshes
	// drawn for it, and the caps built for this build by filter (cellFilterKey), kept so going back is instant.
	private cellFilter: CellFilter = { range: null, hidden: null };
	// the filter asked for while its caps are built (setCellFilter), until it shows: what is framed, culled and
	// picked stays the filter shown meanwhile
	private wantedFilter: CellFilter | null = null;
	private shownCaps: THREE.Mesh[] = [];
	private capsCache = new Map<string, THREE.Mesh[]>();
	private capsPending = new Map<string, Promise<THREE.Mesh[]>>();
	// the chunks whose connected-texture meshes the caps shown make again for their filter (connectedCapsFor): the
	// build's own of those chunks are hidden meanwhile
	private replacedChunks = new Set<string>();
	// the grid's connected-texture cells (grid index), each with the key of the chunk whose objects draw it
	// (userData.connectedChunk); null when the schematic has none
	private connectedCells: Map<number, string> | null = null;
	private filterCall = 0;
	// Each cell's group (setCellGroups; Sponge order over the schematic's box), and the cells of each group.
	private cellGroupData: Uint16Array | null = null;
	private cellGroupBox: CellBox | null = null;
	private groupCells: Map<number, Int32Array> | null = null;
	// Each cell's palette index + 1 (0: no block), from the batched build, for the caps and the box of what shows.
	private cellGrid: Uint16Array | Uint32Array | null = null;
	private cellGridBox: CellBox | null = null;
	private shownBoxCache: { key: string; box: THREE.Box3 | null } | null = null;
	private blockEntitiesMap: Map<string, any> | null = null;
	// set by dispose(): a build in flight stops and reports nothing
	private disposed = false;
	/** Whether the schematic's WASM wrapper was made for it (from a file's bytes), so dispose() frees it. */
	public ownsWrapper = false;

	constructor(
		schematicRenderer: SchematicRenderer,
		name: string,
		schematicWrapper: SchematicWrapper,
		properties?: Partial<{
			position: THREE.Vector3 | number[];
			rotation: THREE.Euler | number[];
			scale: THREE.Vector3 | number[] | number;
			opacity: number;
			visible: boolean;
			meshBoundingBox?: [number[], number[]];
			renderingBounds?: {
				min: THREE.Vector3 | number[];
				max: THREE.Vector3 | number[];
			};
			// the layers to show from the first build on (setLayerRange)
			layerRange?: LayerRange | null;
			// each cell's group, and the groups hidden from the first build on (setCellGroups, setHiddenGroups)
			cellGroups?: Uint16Array | null;
			hiddenGroups?: Iterable<number> | null;
		}>
	) {
		super();
		this.id = name;
		this.name = name;
		this.schematicWrapper = schematicWrapper;

		// what is shown from the first build on, as setLayerRange and setHiddenGroups take it: a range within the
		// schematic's layers in whole layers (an open end such as maxY Infinity, which left the box of the shown cells
		// looping for good, is the schematic's), or none when it covers them all
		const hidden = properties?.hiddenGroups ? new Set(properties.hiddenGroups) : null;
		this.cellFilter = {
			range: this.layerRangeOf(properties?.layerRange ?? null),
			hidden: hidden?.size ? hidden : null,
		};
		if (properties?.cellGroups) {
			this.cellGroupData = properties.cellGroups;
			this.cellGroupBox = schematicBox(schematicWrapper);
		}

		this.schematicRenderer = schematicRenderer;
		if (!this.schematicRenderer) {
			throw new Error("SchematicRenderer is required.");
		}
		if (!this.schematicRenderer.worldMeshBuilder) {
			throw new Error("WorldMeshBuilder is required.");
		}
		this.worldMeshBuilder = schematicRenderer.worldMeshBuilder as WorldMeshBuilder;
		this.eventEmitter = schematicRenderer.eventEmitter;
		this.sceneManager = schematicRenderer.sceneManager;

		// Initialize properties with default values
		this.position = new THREE.Vector3();
		this.rotation = new THREE.Euler();
		this.scale = new THREE.Vector3(1, 1, 1);
		this.opacity = 1.0;
		this.visible = properties?.visible ?? true;

		// Set initial properties if provided, avoiding Three.js object conflicts
		if (properties) {
			// Handle Three.js objects carefully
			if (properties.position) {
				if (Array.isArray(properties.position)) {
					this.position.set(properties.position[0], properties.position[1], properties.position[2]);
				} else {
					this.position.copy(properties.position);
				}
			}
			if (properties.rotation) {
				if (Array.isArray(properties.rotation)) {
					this.rotation.set(properties.rotation[0], properties.rotation[1], properties.rotation[2]);
				} else {
					this.rotation.copy(properties.rotation);
				}
			}
			if (properties.scale) {
				if (Array.isArray(properties.scale)) {
					this.scale.set(properties.scale[0], properties.scale[1], properties.scale[2]);
				} else if (typeof properties.scale === "number") {
					this.scale.setScalar(properties.scale);
				} else {
					this.scale.copy(properties.scale);
				}
			}
			if (properties.opacity !== undefined) {
				this.opacity = properties.opacity;
			}
			if (properties.visible !== undefined) {
				this.visible = properties.visible;
			}
		}
		if (this.schematicRenderer.options.chunkSideLength) {
			this.chunkDimensions = {
				chunkWidth: this.schematicRenderer.options.chunkSideLength,
				chunkHeight: this.schematicRenderer.options.chunkSideLength,
				chunkLength: this.schematicRenderer.options.chunkSideLength,
			};
		}

		const schematicDimensions = this.getDimensions();
		const tightDimensions = this.getTightDimensions();

		// Use tight bounds for centering if available, otherwise fall back to allocated dimensions
		const centeringDimensions =
			tightDimensions[0] > 0 && tightDimensions[1] > 0 && tightDimensions[2] > 0
				? tightDimensions
				: schematicDimensions;
		this.position = new THREE.Vector3(
			-centeringDimensions[0] / 2 + 0.5, // Center the schematic
			0.5,
			-centeringDimensions[2] / 2 + 0.5 // Center the schematic
		);

		if (properties?.meshBoundingBox) {
			this.meshBoundingBox = properties.meshBoundingBox;
		} else {
			this.meshBoundingBox = [
				this.position.toArray(),
				this.position
					.clone()
					.add(
						new THREE.Vector3(
							schematicDimensions[0],
							schematicDimensions[1],
							schematicDimensions[2]
						)
					)
					.toArray(),
			];
		}

		// Initialize rendering bounds to the full schematic dimensions
		// But they are disabled by default (they won't be used for culling unless explicitly enabled)
		this.renderingBounds = {
			min: new THREE.Vector3(0, 0, 0),
			max: new THREE.Vector3(
				schematicDimensions[0],
				schematicDimensions[1],
				schematicDimensions[2]
			),
			enabled: false, // Disabled by default
		};

		// Apply custom rendering bounds if provided
		if (properties?.renderingBounds) {
			if (Array.isArray(properties.renderingBounds.min)) {
				this.renderingBounds.min = new THREE.Vector3(
					properties.renderingBounds.min[0],
					properties.renderingBounds.min[1],
					properties.renderingBounds.min[2]
				);
			} else if (properties.renderingBounds.min instanceof THREE.Vector3) {
				this.renderingBounds.min = properties.renderingBounds.min.clone();
			}

			if (Array.isArray(properties.renderingBounds.max)) {
				this.renderingBounds.max = new THREE.Vector3(
					properties.renderingBounds.max[0],
					properties.renderingBounds.max[1],
					properties.renderingBounds.max[2]
				);
			} else if (properties.renderingBounds.max instanceof THREE.Vector3) {
				this.renderingBounds.max = properties.renderingBounds.max.clone();
			}
		}

		// Initialize the reactive bounds property with safe implementation
		const self = this;
		this.bounds = {
			get minX() {
				return self.renderingBounds.min.x;
			},
			set minX(value: number) {
				self.renderingBounds.min.x = value;
				self.updateRenderingBounds();
			},
			get maxX() {
				return self.renderingBounds.max.x;
			},
			set maxX(value: number) {
				self.renderingBounds.max.x = value;
				self.updateRenderingBounds();
			},
			get minY() {
				return self.renderingBounds.min.y;
			},
			set minY(value: number) {
				self.renderingBounds.min.y = value;
				self.updateRenderingBounds();
			},
			get maxY() {
				return self.renderingBounds.max.y;
			},
			set maxY(value: number) {
				self.renderingBounds.max.y = value;
				self.updateRenderingBounds();
			},
			get minZ() {
				return self.renderingBounds.min.z;
			},
			set minZ(value: number) {
				self.renderingBounds.min.z = value;
				self.updateRenderingBounds();
			},
			get maxZ() {
				return self.renderingBounds.max.z;
			},
			set maxZ(value: number) {
				self.renderingBounds.max.z = value;
				self.updateRenderingBounds();
			},
			get enabled() {
				return self.renderingBounds.enabled || false;
			},
			set enabled(value: boolean) {
				self.renderingBounds.enabled = value;
				self.updateRenderingBounds();
				self.showRenderingBoundsHelper(value);
			},
			// Reset to full dimensions
			reset() {
				const dimensions = self.getDimensions();
				self.setRenderingBounds(
					new THREE.Vector3(0, 0, 0),
					new THREE.Vector3(dimensions[0], dimensions[1], dimensions[2])
				);
				return "Reset to full dimensions";
			},
			// Toggle helper visibility
			showHelper(visible = true) {
				self.showRenderingBoundsHelper(visible);
				return `Helper ${visible ? "shown" : "hidden"}`;
			},
			// Apply bounds changes (triggers rebuild)
			apply() {
				self.rebuildMesh();
				return "Bounds applied and mesh rebuilt";
			},
		} as any;

		this.group = new THREE.Group();
		this.group.name = name;

		// Build meshes and other initialization
		this.updateTransform();
		this.sceneManager.add(this.group);
		this.group.visible = this.visible;

		// a schematic made hidden is built once it is shown
		this.meshesReady = this.track(this.buildMeshes());

		// Instead of proxying the entire object, set up manual property watchers
		// This avoids interfering with Three.js internal matrix properties
		this.setupPropertyWatchers();
	}

	/**
	 * Set up manual property watchers instead of using reactive proxy
	 * This avoids interference with Three.js internal matrix properties
	 */
	// the property watcher's next check (setupPropertyWatchers); dispose() clears it
	private _propertyWatcherTimer: ReturnType<typeof setTimeout> | null = null;

	private setupPropertyWatchers(): void {
		// Store original values for comparison
		let lastPosition = this.position.clone();
		let lastRotation = this.rotation.clone();
		let lastScale = this.scale.clone();
		let lastOpacity = this.opacity;
		let lastVisible = this.visible;

		// Set up property change detection (it ends when the schematic is disposed: the timer would keep it alive)
		const checkForChanges = () => {
			if (this.disposed) return;
			// Check position
			if (!this.position.equals(lastPosition)) {
				lastPosition = this.position.clone();
				this.updateTransform();
				this.emitPropertyChanged("position", this.position);
			}

			// Check rotation
			if (!this.rotation.equals(lastRotation)) {
				lastRotation = this.rotation.clone();
				this.updateTransform();
				this.emitPropertyChanged("rotation", this.rotation);
			}

			// Check scale
			if (!this.scale.equals(lastScale)) {
				lastScale = this.scale.clone();
				this.updateTransform();
				this.emitPropertyChanged("scale", this.scale);
			}

			// Check opacity
			if (this.opacity !== lastOpacity) {
				lastOpacity = this.opacity;
				this.updateMeshMaterials("opacity");
				this.emitPropertyChanged("opacity", this.opacity);
			}

			// Check visibility
			if (this.visible !== lastVisible) {
				lastVisible = this.visible;
				this.updateMeshVisibility();
				this.emitPropertyChanged("visible", this.visible);
			} else {
				// hidden, rebuilt and shown again between two checks: the rebuild was skipped all the same
				this.buildIfShown();
			}

			// Continue checking periodically - use longer interval (250ms) to reduce overhead
			this._propertyWatcherTimer = setTimeout(checkForChanges, 250);
		};

		// Start the change detection loop
		this._propertyWatcherTimer = setTimeout(checkForChanges, 250);
	}

	/**
	 * Get schematic dimensions (allocated space).
	 * Returns [width, height, length] tuple.
	 */
	public getDimensions(): [number, number, number] {
		if (!this._cachedDimensions) {
			const dimensions = this.schematicWrapper.get_dimensions();
			this._cachedDimensions = [dimensions[0], dimensions[1], dimensions[2]];
		}
		return this._cachedDimensions;
	}

	/**
	 * Get tight dimensions (actual block content, not pre-allocated space)
	 * Returns [width, height, length] or [0, 0, 0] if no blocks exist
	 */
	public getTightDimensions(): [number, number, number] {
		const dimensions = this.schematicWrapper.get_tight_dimensions();
		return [dimensions[0], dimensions[1], dimensions[2]];
	}

	/**
	 * Get tight bounding box min coordinates [x, y, z]
	 * Returns null if no non-air blocks have been placed
	 */
	public getTightBoundsMin(): [number, number, number] | null {
		const min = this.schematicWrapper.get_tight_bounds_min();
		if (!min) return null;
		return [min[0], min[1], min[2]];
	}

	/**
	 * Get tight bounding box max coordinates [x, y, z]
	 * Returns null if no non-air blocks have been placed
	 */
	public getTightBoundsMax(): [number, number, number] | null {
		const max = this.schematicWrapper.get_tight_bounds_max();
		if (!max) return null;
		return [max[0], max[1], max[2]];
	}

	/**
	 * Display detailed performance monitoring results
	 */
	private displayPerformanceResults(sessionData: any): void {
		if (!sessionData) {
			console.warn("displayPerformanceResults called with no data!");
			return;
		}

		// Debug log to check data presence

		// Aggregate metrics from chunk processing data
		let blockCount = 0;
		let meshCount = 0;
		if (sessionData.chunkProcessingData) {
			sessionData.chunkProcessingData.forEach((d: any) => {
				blockCount += d.blockCount || 0;
				meshCount += d.meshCount || 0;
			});
		}

		if (sessionData.breakdown && sessionData.breakdown.length > 0) {
			console.warn("Detailed Breakdown:");
			sessionData.breakdown.forEach((op: any) => {
				console.warn(
					`  - ${op.operationId}: ${op.duration !== undefined ? op.duration.toFixed(2) : "0.00"}ms`
				);
			});
		} else {
			console.warn("No breakdown data available.");
			if (sessionData.timingData) {
				console.log("Raw timing data:", JSON.stringify(sessionData.timingData));
			}
		}
	}

	private emitPropertyChanged(property: string, value: any) {
		this.eventEmitter.emit("schematicPropertyChanged", {
			schematic: this,
			property,
			value,
		});
	}

	private updateTransform(): void {
		this.group.position.copy(this.position);
		this.group.rotation.copy(this.rotation);
		this.group.scale.copy(this.scale);
	}

	public syncTransformFromGroup() {
		this.position.copy(this.group.position);
		this.rotation.copy(this.group.rotation);
		this.scale.copy(this.group.scale);

		// Emit event
		this.emitPropertyChanged("transform", {
			position: this.position,
			rotation: this.rotation,
			scale: this.scale,
		});
	}

	// The objects' own visibility is left alone: hiding the schematic hides its group (updateMeshVisibility), and a
	// cell filter shows or hides the objects of its cells (applyCellFilterTo). Set from the schematic's, an object
	// added while it was hidden stayed hidden once it was shown again.
	private applyPropertiesToObjects(objects: THREE.Object3D[]) {
		objects.forEach((obj) => {
			obj.traverse((child) => {
				if (child instanceof THREE.Mesh) {
					child.castShadow = true;
					child.receiveShadow = true;
					child.frustumCulled = true;
				}
			});
			this.applyOpacityTo(obj);
		});
	}

	// The schematic's faded copies of the materials it draws with while its opacity is below 1, by material, and each
	// faded mesh's own materials. The materials are shared (the palette's, MaterialRegistry's, other schematics'): a
	// fade draws with copies, and leaves them as they are.
	private fadedMaterials = new Map<THREE.Material, THREE.Material>();
	private baseMaterials = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();

	/**
	 * Draws the meshes under `root` at the schematic's opacity: below 1, with copies of their materials at the
	 * material's own opacity times the schematic's (water stays fainter than stone), else with their own materials.
	 */
	private applyOpacityTo(root: THREE.Object3D) {
		const fade = this.opacity < 1;
		root.traverse((o) => {
			if (!(o instanceof THREE.Mesh)) return;
			const base = this.baseMaterials.get(o) ?? o.material;
			if (!fade) {
				if (this.baseMaterials.delete(o)) o.material = base;
				return;
			}
			this.baseMaterials.set(o, base);
			o.material = Array.isArray(base) ? base.map((m) => this.fadedOf(m)) : this.fadedOf(base);
		});
		if (!fade && root === this.group) this.dropFadedMaterials();
	}

	/** The schematic's faded copy of a material, at its opacity times the schematic's. */
	private fadedOf(material: THREE.Material): THREE.Material {
		if (!material) return material;
		let faded = this.fadedMaterials.get(material);
		if (!faded) {
			faded = material.clone();
			this.fadedMaterials.set(material, faded);
		}
		faded.opacity = material.opacity * this.opacity;
		faded.transparent = true;
		return faded;
	}

	/** Disposes the faded copies (the meshes are drawn with their own materials again). */
	private dropFadedMaterials() {
		for (const faded of this.fadedMaterials.values()) faded.dispose();
		this.fadedMaterials.clear();
	}

	/** Gives the meshes under `root` their own materials back, before they are disposed (their references go with them). */
	private unfade(root: THREE.Object3D) {
		root.traverse((o) => {
			if (!(o instanceof THREE.Mesh)) return;
			const base = this.baseMaterials.get(o);
			if (base) {
				o.material = base;
				this.baseMaterials.delete(o);
			}
		});
	}

	/**
	 * Export the schematic using the new modular export system
	 *
	 * @param options Export options including format, quality, and callbacks
	 * @returns Promise resolving to the export result
	 *
	 * @example
	 * // Basic GLB export (recommended)
	 * await schematic.export({ format: 'glb' });
	 *
	 * @example
	 * // Export with options
	 * await schematic.export({
	 *   format: 'gltf',
	 *   quality: 'high',
	 *   normalMode: 'flip',
	 *   filename: 'my_schematic',
	 *   onProgress: (p) => console.log(`${p.progress * 100}%: ${p.message}`)
	 * });
	 */
	public async export(options: ExportOptions = {}): Promise<ExportResult> {
		// Wait for meshes to be ready
		await this.meshesReady;

		const exporter = new SchematicExporter();

		// Set up progress callback to use UI manager if available
		const originalProgress = options.onProgress;
		if (this.schematicRenderer.options.enableProgressBar && this.schematicRenderer.uiManager) {
			this.schematicRenderer.uiManager.showProgressBar(`Exporting ${this.name}`);

			exporter.on("exportProgress", (progress) => {
				this.schematicRenderer.uiManager?.updateProgress(progress.progress, progress.message);
				originalProgress?.(progress);
			});

			exporter.on("exportComplete", () => {
				setTimeout(() => {
					this.schematicRenderer.uiManager?.hideProgressBar();
				}, 1000);
			});

			exporter.on("exportError", () => {
				this.schematicRenderer.uiManager?.hideProgressBar();
			});
		}

		// Merge default options
		const exportOptions: ExportOptions = {
			filename: options.filename || `${this.name}_schematic`,
			format: options.format || "glb",
			quality: options.quality || "high",
			normalMode: options.normalMode || "double-sided", // Default to double-sided for max compatibility
			...options,
		};

		try {
			const result = await exporter.export(this.group, exportOptions);

			// Auto-download if no onComplete callback is provided
			if (!options.onComplete) {
				exporter.download(result);
				// Clean up URL after a delay
				setTimeout(() => exporter.revokeUrl(result), 5000);
			}

			console.log(`Successfully exported schematic "${this.name}" as ${result.filename}`);
			return result;
		} catch (error) {
			console.error("Error exporting schematic:", error);
			throw error;
		}
	}

	/**
	 * Export as GLB (binary GLTF) - recommended for most use cases
	 * @param filename Optional filename (without extension)
	 */
	public async exportAsGLB(filename?: string): Promise<ExportResult> {
		return this.export({
			format: "glb",
			filename: filename || this.name,
		});
	}

	/**
	 * Exports the schematic as a GLTF file
	 * @deprecated Use export() or exportAsGLB() instead for better normal handling
	 * @param options Export options
	 * @returns Promise that resolves when export is complete
	 */
	public async exportAsGLTF(
		options: {
			filename?: string;
			binary?: boolean;
			includeCustomExtensions?: boolean;
			maxTextureSize?: number;
			embedImages?: boolean;
			animations?: THREE.AnimationClip[];
		} = {}
	): Promise<void> {
		// Map old API to new export system
		const format: ExportFormat = options.binary ? "glb" : "gltf";

		await this.export({
			filename: options.filename || `${this.name}_schematic`,
			format,
			includeCustomExtensions: options.includeCustomExtensions,
			maxTextureSize: options.maxTextureSize,
			embedTextures: options.embedImages,
			animations: options.animations,
		});
	}

	private async buildMeshes(): Promise<void> {
		if (this.disposed) return;
		if (!this.visible) {
			// built once it is shown (updateMeshVisibility)
			this.unbuilt = true;
			return;
		}
		this.unbuilt = false;

		const { meshes, chunkMap } = await this.buildSchematicMeshes(this, this.chunkDimensions);
		if (this.disposed) {
			// removed while it was building: what got built is let go, and nothing is reported
			for (const m of meshes) disposeObject(m);
			return;
		}
		this.chunkMeshes = chunkMap;

		// Sign block entities are rendered in a mode-independent pass (the batched/
		// instanced build paths don't process block entities, and signs need both their
		// per-instance NBT text and blockstate facing/rotation).
		try {
			const signMeshes = await this.worldMeshBuilder.buildSignMeshes(this);
			meshes.push(...(signMeshes as THREE.Mesh[]));
		} catch (e) {
			console.warn("[SchematicObject] sign build failed", e);
		}
		if (this.disposed) {
			for (const m of meshes) disposeObject(m);
			return;
		}

		// Apply properties to all objects
		this.applyPropertiesToObjects(meshes);

		// Add to group
		meshes.forEach((obj) => {
			this.group.add(obj);
		});

		this.updateTransform(); // This will apply position, rotation, and scale to the group
		this.group.visible = this.visible;
		this.meshes = meshes as THREE.Mesh[]; // Keep for backward compatibility

		this.group.updateMatrixWorld(true);
		this.group.updateWorldMatrix(true, true);

		// what was asked for before or during the build, with its caps
		const wanted = this.wanted();
		if (wanted.range || wanted.hidden?.size) await this.setCellFilter(wanted);

		// Create initial visualizer for rendering bounds
		if (this.sceneManager.schematicRenderer.options.showRenderingBoundsHelper) {
			this.createRenderingBoundsHelper();
		}

		if (this.disposed) return;
		this.sceneManager.schematicRenderer.options.callbacks?.onSchematicRendered?.(this.name);
		this.eventEmitter.emit("schematicRendered", { id: this.id, name: this.name });
	}

	// Track chunk building progress
	private reportBuildProgress(
		message: string,
		progress: number,
		totalChunks?: number,
		completedChunks?: number
	) {
		// Only show progress if enabled and UI manager exists
		if (this.schematicRenderer.options.enableProgressBar && this.schematicRenderer.uiManager) {
			// Format detailed progress message if chunks are provided
			let progressMessage = message;
			if (totalChunks !== undefined && completedChunks !== undefined) {
				progressMessage = `${message} (${completedChunks}/${totalChunks} chunks)`;
			}

			this.holdProgressBar("Building Schematic");
			this.schematicRenderer.uiManager.updateProgress(progress, progressMessage);
			// hidden once this schematic's builds are over (withBuildProgress), not here: a build of another
			// schematic may still be showing it
		}
	}

	/** Shows the progress bar (with `label`, unless this schematic shows it already) until its builds are over. */
	private holdProgressBar(label: string) {
		const ui = this.schematicRenderer.uiManager;
		if (this.schematicRenderer.options.enableProgressBar && ui) holdProgressBar(ui, this, label);
	}

	/** Runs a build; once it and the rest of this schematic's builds are over, the progress bar they showed goes. */
	private async withBuildProgress<T>(build: () => Promise<T>): Promise<T> {
		this.progressBuilds++;
		try {
			return await build();
		} finally {
			const ui = this.schematicRenderer.uiManager;
			// the bar is shared by every schematic and load (utils/progressBar.ts)
			if (--this.progressBuilds === 0 && ui) releaseProgressBar(ui, this);
		}
	}

	public async buildSchematicMeshes(
		schematicObject: SchematicObject,
		chunkDimensions: any = {
			chunkWidth: 16,
			chunkHeight: 16,
			chunkLength: 16,
		},
		buildMode: "immediate" | "incremental" | "instanced" | "batched" = this.schematicRenderer
			.options.meshBuildingMode || "incremental"
	) {
		return this.withBuildProgress(() =>
			this.buildSchematicMeshesIn(schematicObject, chunkDimensions, buildMode)
		);
	}

	private async buildSchematicMeshesIn(
		schematicObject: SchematicObject,
		chunkDimensions: any,
		buildMode: "immediate" | "incremental" | "instanced" | "batched"
	) {
		// Start performance monitoring session
		const sessionId = performanceMonitor.startSession(this.id, buildMode);
		if (this.schematicRenderer.renderManager?.renderer) {
			performanceMonitor.setRenderer(this.schematicRenderer.renderManager.renderer);
		}

		performanceMonitor.startOperation(`schematic-build-${buildMode}`, {
			schematicId: this.id,
			schematicName: this.name,
			buildMode: buildMode,
			chunkDimensions: chunkDimensions,
		});
		performanceMonitor.takeMemorySnapshot(`schematic-build-${buildMode}-start`);

		// Track initial memory state
		const initialMemory = (performance as any).memory
			? (performance as any).memory.usedJSHeapSize
			: 0;

		try {
			let result;
			switch (buildMode) {
				case "immediate":
					result = await this.buildSchematicMeshesImmediate(schematicObject, chunkDimensions);
					break;
				case "incremental":
					result = await this.buildSchematicMeshesIncremental(schematicObject, chunkDimensions);
					break;
				case "instanced":
					result = await this.buildSchematicMeshesInstanced(schematicObject);
					break;
				case "batched":
					// New high-performance batch mode - merges all chunks into a few meshes
					result = await this.buildSchematicMeshesBatched(schematicObject, chunkDimensions);
					break;
				default:
					throw new Error(
						`Invalid build mode: ${buildMode}. Use 'immediate', 'incremental', 'instanced', or 'batched'.`
					);
			}

			// Track final memory state and record detailed metrics
			const finalMemory = (performance as any).memory
				? (performance as any).memory.usedJSHeapSize
				: 0;
			const memoryDelta = finalMemory - initialMemory;
			// Record detailed chunk processing data
			performanceMonitor.recordChunkProcessing({
				chunkId: `${this.id}-complete`,
				chunkCoords: [0, 0, 0],
				processingTime:
					performance.now() - (performanceMonitor as any).getCurrentOperationStartTime?.() || 0,
				blockCount: result.meshes.length,
				meshCount: result.meshes.length,
				memoryUsed: memoryDelta,
				totalVertices: result.meshes.length * 100, // Estimate
				totalIndices: result.meshes.length * 150, // Estimate
				materialGroups: result.meshes.length,
				blockTypes: ["schematic-complete"], // Summary
				renderingPhases: [],
				blockTypeTimings: new Map(),
				geometryStats: {
					facesCulled: 0,
					facesGenerated: result.meshes.length,
					cullingEfficiency: 0,
					averageVerticesPerBlock: 100,
					textureAtlasUsage: [],
				},
				memoryBreakdown: {
					vertexBuffers: memoryDelta * 0.4,
					indexBuffers: memoryDelta * 0.3,
					materials: memoryDelta * 0.1,
					textures: memoryDelta * 0.1,
					other: memoryDelta * 0.1,
				},
			});

			performanceMonitor.takeMemorySnapshot(`schematic-build-${buildMode}-end`);

			// Ensure main operation is closed BEFORE ending session
			performanceMonitor.endOperation(`schematic-build-${buildMode}`);

			// End performance monitoring session and display results
			const sessionData = performanceMonitor.endSession(sessionId);
			// a build stopped by dispose() reports nothing
			if (sessionData && !this.disposed) {
				// Gate the console breakdown behind an explicit debug flag — rebuilds
				// fire frequently (e.g. slicer scrubbing) and the table is noisy.
				if (this.schematicRenderer.options.debugOptions?.logBuildPerformance) {
					this.displayPerformanceResults(sessionData);
				}

				// Dispatch event for UI components to react
				if (typeof window !== "undefined") {
					window.dispatchEvent(
						new CustomEvent("schematicRenderComplete", {
							detail: sessionData,
						})
					);
				}
			}

			return result;
		} catch (error) {
			performanceMonitor.endOperation(`schematic-build-${buildMode}`); // Ensure closed on error too
			performanceMonitor.endSession(sessionId); // else its monitoring would run on, with no build
			throw error;
		}
	}

	// TRUE lazy loading - minimal memory footprint

	public async buildSchematicMeshesImmediate(
		schematicObject: SchematicObject,
		chunkDimensions: any = {
			chunkWidth: 16,
			chunkHeight: 16,
			chunkLength: 16,
		}
	): Promise<{
		meshes: THREE.Object3D[];
		chunkMap: Map<string, THREE.Object3D[]>;
	}> {
		const overallStartTime = performance.now();
		const schematic = schematicObject.schematicWrapper;

		// STEP 1: Initialize pipeline
		this.reportBuildProgress("Initializing pipeline...", 0.05);

		const palettes = this.getPalettes(schematic);
		performanceMonitor.startOperation("Palette Precomputation");
		await this.worldMeshBuilder.precomputePaletteGeometries(palettes.default, this);
		performanceMonitor.endOperation("Palette Precomputation");

		this.reportBuildProgress("Creating chunk iterator...", 0.1);

		performanceMonitor.startOperation("Chunk Iterator Creation");
		const iterator = schematic.create_lazy_chunk_iterator(
			chunkDimensions.chunkWidth,
			chunkDimensions.chunkHeight,
			chunkDimensions.chunkLength,
			"bottom_up",
			0,
			0,
			0
		);
		performanceMonitor.endOperation("Chunk Iterator Creation");

		const totalChunks = iterator.total_chunks();

		if (totalChunks === 0) {
			this.reportBuildProgress("Schematic build complete (no chunks)", 1.0, 0, 0);
			return { meshes: [], chunkMap: new Map() };
		}

		const chunkMap: Map<string, THREE.Object3D[]> = new Map();
		const renderingBounds = schematicObject.renderingBounds?.enabled
			? schematicObject.renderingBounds
			: undefined;

		let processedChunkCount = 0;
		let totalMeshCount = 0;
		const progressUpdateInterval = Math.max(1, Math.floor(totalChunks / 20));

		this.reportBuildProgress("Processing chunks with minimal memory...", 0.15, totalChunks, 0);

		performanceMonitor.startOperation("Process All Chunks");

		// Parallel Processing Logic
		const CONCURRENCY_LIMIT = navigator.hardwareConcurrency || 4;
		const activePromises: Promise<void>[] = [];

		// Helper to dispatch a chunk task
		const processChunk = async (chunkData: any) => {
			const { chunk_x, chunk_y, chunk_z, blocks } = chunkData;

			// Bounds culling
			if (renderingBounds?.enabled) {
				const chunkMinX = chunk_x * chunkDimensions.chunkWidth;
				const chunkMinY = chunk_y * chunkDimensions.chunkHeight;
				const chunkMinZ = chunk_z * chunkDimensions.chunkLength;
				const chunkMaxX = chunkMinX + chunkDimensions.chunkWidth;
				const chunkMaxY = chunkMinY + chunkDimensions.chunkHeight;
				const chunkMaxZ = chunkMinZ + chunkDimensions.chunkLength;

				if (
					chunkMaxX < renderingBounds.min.x ||
					chunkMinX > renderingBounds.max.x ||
					chunkMaxY < renderingBounds.min.y ||
					chunkMinY > renderingBounds.max.y ||
					chunkMaxZ < renderingBounds.min.z ||
					chunkMinZ > renderingBounds.max.z
				) {
					processedChunkCount++;
					if (processedChunkCount % progressUpdateInterval === 0) {
						this.reportBuildProgress(
							"Processing chunks (bounds culled)...",
							0.15 + (processedChunkCount / totalChunks) * 0.8,
							totalChunks,
							processedChunkCount
						);
					}
					return;
				}
			}

			// Process chunk
			const chunkMeshes = await this.worldMeshBuilder.getChunkMesh(
				{
					blocks: blocks,
					chunk_x,
					chunk_y,
					chunk_z,
				},
				schematicObject,
				renderingBounds
			);

			processedChunkCount++;
			// removed while this chunk was meshed: what came back is let go
			if (this.disposed) {
				for (const m of chunkMeshes ?? []) disposeObject(m);
				return;
			}

			if (chunkMeshes && chunkMeshes.length > 0) {
				// Store chunk reference for management
				const chunkKey = `${chunk_x},${chunk_y},${chunk_z}`;
				chunkMap.set(chunkKey, chunkMeshes);

				// Apply properties and add to scene
				this.applyPropertiesToObjects(chunkMeshes);
				chunkMeshes.forEach((mesh) => {
					this.group.add(mesh);
				});
				// On-demand rendering: newly-added chunk geometry must trigger a draw.
				this.schematicRenderer.invalidate();

				totalMeshCount += chunkMeshes.length;
			}

			// Update progress occasionally
			if (processedChunkCount % progressUpdateInterval === 0) {
				this.reportBuildProgress(
					"Processing chunks...",
					0.15 + (processedChunkCount / totalChunks) * 0.8,
					totalChunks,
					processedChunkCount
				);
			}
		};

		// Iterate and dispatch tasks (removal stops it)
		while (!this.disposed && iterator.has_next()) {
			const chunkData = iterator.next();
			if (!chunkData) break;

			// Wait if concurrency limit reached
			if (activePromises.length >= CONCURRENCY_LIMIT) {
				await Promise.race(activePromises);
			}

			// Start new task
			const promise = processChunk(chunkData).then(() => {
				// Remove self from active promises
				const idx = activePromises.indexOf(promise);
				if (idx > -1) activePromises.splice(idx, 1);
			});
			activePromises.push(promise);
		}

		// Wait for remaining tasks
		await Promise.all(activePromises);

		performanceMonitor.endOperation("Process All Chunks");
		if (this.disposed) return { meshes: [], chunkMap: new Map() };

		this.reportBuildProgress("Finalizing scene...", 0.95, totalChunks, processedChunkCount);

		this.group.updateMatrixWorld(true);

		const totalTime = performance.now() - overallStartTime;

		// Return meshes from scene graph (not from accumulator!)
		const finalMeshes = Array.from(this.group.children);

		// Dispatch completion event
		if (typeof window !== "undefined") {
			window.dispatchEvent(
				new CustomEvent("schematicRenderComplete", {
					detail: {
						schematicId: this.id,
						schematicName: this.name,
						totalChunks: totalChunks,
						processedChunks: processedChunkCount,
						buildTimeMs: totalTime,
						meshCount: totalMeshCount,
						optimized: true,
						immediate: true,
						trueLazy: true, // Flag for true lazy loading
					},
				})
			);
		}

		// Log final stats
		const renderer = this.schematicRenderer.renderManager?.renderer;
		if (renderer && renderer.info) {
			console.log(
				`FINAL TRUE LAZY STATS - Draw Calls: ${renderer.info.render.calls}, Tris: ${renderer.info.render.triangles}`
			);
			console.log(
				`Memory - Geometries: ${renderer.info.memory.geometries}, Textures: ${renderer.info.memory.textures}`
			);
		}

		const paletteStats = this.worldMeshBuilder.getPaletteStats();
		console.log(
			`Palette Cache - ${paletteStats.paletteSize} block types, ${(
				paletteStats.memoryEstimate /
				1024 /
				1024
			).toFixed(1)}MB`
		);

		this.reportBuildProgress("TRUE lazy build complete", 1.0, totalChunks, processedChunkCount);

		return { meshes: finalMeshes, chunkMap };
	}

	/**
	 * Build, for every chunk, a flat list of its neighbours' boundary blocks so the
	 * mesher can cull faces that sit on a chunk seam. Runs in a single pass over all
	 * blocks (extract each chunk's 6 boundary planes) plus a cheap assembly pass, so
	 * cost is linear in block count — and it reduces output geometry, which usually
	 * makes large schematics render faster overall.
	 *
	 * Coordinates are world-space; a chunk (cx,cy,cz) spans [cx*W .. cx*W+W-1] etc.
	 * Returns a map of "cx,cy,cz" -> Int32Array of [x, y, z, paletteIndex, …].
	 */
	private computeChunkAprons(
		allChunks: Array<{ chunk_x: number; chunk_y: number; chunk_z: number; blocks: any }>,
		dims: { chunkWidth: number; chunkHeight: number; chunkLength: number }
	): Map<string, Int32Array> {
		const W = dims.chunkWidth;
		const H = dims.chunkHeight;
		const L = dims.chunkLength;
		const key = (cx: number, cy: number, cz: number) => `${cx},${cy},${cz}`;

		const forEachBlock = (
			blocks: any,
			cb: (x: number, y: number, z: number, idx: number) => void
		) => {
			if (blocks instanceof Int32Array) {
				for (let i = 0; i < blocks.length; i += 4) {
					cb(blocks[i], blocks[i + 1], blocks[i + 2], blocks[i + 3]);
				}
			} else if (Array.isArray(blocks)) {
				for (const b of blocks) cb(b[0], b[1], b[2], b[3]);
			}
		};

		type Faces = {
			negX: number[];
			posX: number[];
			negY: number[];
			posY: number[];
			negZ: number[];
			posZ: number[];
		};

		// Pass 1: extract each chunk's six boundary planes.
		const facesByKey = new Map<string, Faces>();
		for (const c of allChunks) {
			const planeNegX = c.chunk_x * W;
			const planePosX = c.chunk_x * W + W - 1;
			const planeNegY = c.chunk_y * H;
			const planePosY = c.chunk_y * H + H - 1;
			const planeNegZ = c.chunk_z * L;
			const planePosZ = c.chunk_z * L + L - 1;
			const f: Faces = { negX: [], posX: [], negY: [], posY: [], negZ: [], posZ: [] };
			forEachBlock(c.blocks, (x, y, z, idx) => {
				if (x === planeNegX) f.negX.push(x, y, z, idx);
				if (x === planePosX) f.posX.push(x, y, z, idx);
				if (y === planeNegY) f.negY.push(x, y, z, idx);
				if (y === planePosY) f.posY.push(x, y, z, idx);
				if (z === planeNegZ) f.negZ.push(x, y, z, idx);
				if (z === planePosZ) f.posZ.push(x, y, z, idx);
			});
			facesByKey.set(key(c.chunk_x, c.chunk_y, c.chunk_z), f);
		}

		// Pass 2: each chunk's apron is the union of its neighbours' facing planes.
		const aprons = new Map<string, Int32Array>();
		for (const c of allChunks) {
			const cx = c.chunk_x;
			const cy = c.chunk_y;
			const cz = c.chunk_z;
			const parts: number[][] = [];
			const add = (k: string, pick: (f: Faces) => number[]) => {
				const f = facesByKey.get(k);
				if (f) parts.push(pick(f));
			};
			add(key(cx + 1, cy, cz), (f) => f.negX);
			add(key(cx - 1, cy, cz), (f) => f.posX);
			add(key(cx, cy + 1, cz), (f) => f.negY);
			add(key(cx, cy - 1, cz), (f) => f.posY);
			add(key(cx, cy, cz + 1), (f) => f.negZ);
			add(key(cx, cy, cz - 1), (f) => f.posZ);

			let total = 0;
			for (const p of parts) total += p.length;
			if (total === 0) continue;

			const apron = new Int32Array(total);
			let offset = 0;
			for (const p of parts) {
				apron.set(p, offset);
				offset += p.length;
			}
			aprons.set(key(cx, cy, cz), apron);
		}

		return aprons;
	}

	// Also fix the incremental version
	public async buildSchematicMeshesIncremental(
		schematicObject: SchematicObject,
		chunkDimensions: any = {
			chunkWidth: 16,
			chunkHeight: 16,
			chunkLength: 16,
		}
	): Promise<{
		meshes: THREE.Object3D[];
		chunkMap: Map<string, THREE.Object3D[]>;
	}> {
		const overallStartTime = performance.now();
		const renderer = this.schematicRenderer.renderManager?.renderer;
		const schematic = schematicObject.schematicWrapper;

		// Initialize pipeline
		const palettes = this.getPalettes(schematic);
		await this.worldMeshBuilder.precomputePaletteGeometries(palettes.default, this);

		// CRITICAL: Wait for JSZip's async postMessage queue to drain
		// JSZip uses setImmediate (via postMessage) which continues after await returns
		await new Promise((resolve) => setTimeout(resolve, 100));

		const iterator = schematic.create_lazy_chunk_iterator(
			chunkDimensions.chunkWidth,
			chunkDimensions.chunkHeight,
			chunkDimensions.chunkLength,
			"bottom_up",
			0,
			0,
			0
		);

		const totalChunks = iterator.total_chunks();

		if (totalChunks === 0) {
			this.reportBuildProgress("Schematic build complete (no chunks)", 1.0, 0, 0);
			return { meshes: [], chunkMap: new Map() };
		}

		const chunkMap: Map<string, THREE.Object3D[]> = new Map();
		let totalMeshCount = 0;

		this.reportBuildProgress("Processing optimized chunks...", 0, totalChunks, 0);

		const renderingBounds = schematicObject.renderingBounds?.enabled
			? schematicObject.renderingBounds
			: undefined;

		let processedChunkCount = 0;

		performanceMonitor.startOperation("schematic-build-incremental");
		performanceMonitor.startOperation("Process All Chunks");

		return new Promise(async (resolvePromise, rejectPromise) => {
			try {
				// PERFORMANCE FIX: Batch all worker calls to avoid per-await event loop overhead
				// Collect all chunk data first
				const allChunks: Array<{ chunk_x: number; chunk_y: number; chunk_z: number; blocks: any }> =
					[];

				while (iterator.has_next()) {
					const chunkData = iterator.next();
					if (!chunkData) break;

					const { chunk_x, chunk_y, chunk_z, blocks } = chunkData;

					// Bounds culling
					if (renderingBounds?.enabled) {
						const chunkMinX = chunk_x * chunkDimensions.chunkWidth;
						const chunkMinY = chunk_y * chunkDimensions.chunkHeight;
						const chunkMinZ = chunk_z * chunkDimensions.chunkLength;
						const chunkMaxX = chunkMinX + chunkDimensions.chunkWidth;
						const chunkMaxY = chunkMinY + chunkDimensions.chunkHeight;
						const chunkMaxZ = chunkMinZ + chunkDimensions.chunkLength;

						if (
							chunkMaxX < renderingBounds.min.x ||
							chunkMinX > renderingBounds.max.x ||
							chunkMaxY < renderingBounds.min.y ||
							chunkMinY > renderingBounds.max.y ||
							chunkMaxZ < renderingBounds.min.z ||
							chunkMinZ > renderingBounds.max.z
						) {
							continue; // Skip culled chunks
						}
					}

					allChunks.push({ chunk_x, chunk_y, chunk_z, blocks });
				}

				// Build a 1-voxel "apron" of each chunk's neighbours so faces on chunk
				// seams cull against the adjacent chunk (otherwise internal faces — most
				// visibly water — show along every boundary).
				const chunkAprons = this.computeChunkAprons(allChunks, chunkDimensions);

				// Process in batches to avoid overwhelming the worker pool
				const BATCH_SIZE = 8; // Match worker count
				const totalChunksToProcess = allChunks.length;

				for (let batchStart = 0; batchStart < totalChunksToProcess; batchStart += BATCH_SIZE) {
					if (this.disposed) break; // removed: no more batches
					const batchEnd = Math.min(batchStart + BATCH_SIZE, totalChunksToProcess);
					const batch = allChunks.slice(batchStart, batchEnd);

					// Send all chunks in this batch to workers simultaneously
					const batchPromises = batch.map(({ chunk_x, chunk_y, chunk_z, blocks }) =>
						this.worldMeshBuilder
							.getChunkMesh(
								{
									blocks,
									chunk_x,
									chunk_y,
									chunk_z,
									apronBlocks: chunkAprons.get(`${chunk_x},${chunk_y},${chunk_z}`),
								},
								schematicObject,
								renderingBounds
							)
							.then((meshes) => ({ chunk_x, chunk_y, chunk_z, meshes }))
					);

					// Await entire batch at once - single yield point!
					const batchResults = await Promise.all(batchPromises);
					if (this.disposed) {
						// removed while the batch was meshed: what came back is let go
						for (const { meshes } of batchResults) for (const m of meshes ?? []) disposeObject(m);
						break;
					}

					// Add all batch results to scene
					for (const { chunk_x, chunk_y, chunk_z, meshes } of batchResults) {
						processedChunkCount++;

						if (meshes && meshes.length > 0) {
							const chunkKey = `${chunk_x},${chunk_y},${chunk_z}`;
							chunkMap.set(chunkKey, meshes);

							this.applyPropertiesToObjects(meshes);
							meshes.forEach((mesh) => this.group.add(mesh));
							totalMeshCount += meshes.length;
							// On-demand rendering: trigger a draw for the new chunks.
							this.schematicRenderer.invalidate();
						}
					}

					// Log progress every batch
					console.log(
						`[SceneAdd] batch=${Math.floor(batchStart / BATCH_SIZE) + 1} processed=${processedChunkCount}/${totalChunksToProcess} children=${this.group.children.length}`
					);

					this.reportBuildProgress(
						"Processing chunks...",
						processedChunkCount / totalChunksToProcess,
						totalChunksToProcess,
						processedChunkCount
					);
				}

				if (this.disposed) {
					performanceMonitor.endOperation("Process All Chunks");
					performanceMonitor.endOperation("schematic-build-incremental");
					resolvePromise({ meshes: [], chunkMap: new Map() });
					return;
				}

				// Final render
				if (this.schematicRenderer.renderManager && renderer) {
					const renderStartTime = performance.now();
					this.schematicRenderer.renderManager.render();
					const renderTime = performance.now() - renderStartTime;
					console.log(
						`[RenderTiming] FINAL meshes=${this.group.children.length} renderMs=${renderTime.toFixed(0)}`
					);
				}

				// Complete
				performanceMonitor.endOperation("Process All Chunks");
				this.group.updateMatrixWorld(true);

				const finalMeshes = Array.from(this.group.children);

				if (typeof window !== "undefined") {
					window.dispatchEvent(
						new CustomEvent("schematicRenderComplete", {
							detail: {
								schematicId: this.id,
								schematicName: this.name,
								totalChunks: totalChunks,
								processedChunks: processedChunkCount,
								buildTimeMs: performance.now() - overallStartTime,
								meshCount: totalMeshCount,
								optimized: true,
								incremental: true,
								batchedWorkers: true,
							},
						})
					);
				}

				this.reportBuildProgress("Build complete", 1.0, totalChunks, processedChunkCount);
				performanceMonitor.endOperation("schematic-build-incremental");

				resolvePromise({ meshes: finalMeshes, chunkMap });
			} catch (error) {
				performanceMonitor.endOperation("Process All Chunks");
				performanceMonitor.endOperation("schematic-build-incremental");
				console.error(`[SchematicObject] Error during batched processing:`, error);
				rejectPromise(error);
			}
		});
	}

	/**
	/**
	 * Clip a list of chunks against renderingBounds before they're handed to
	 * the batched worker. `processChunksBatched` doesn't accept bounds, so we
	 * cull whole chunks that fall outside the slice and rewrite the block
	 * Int32Arrays of chunks that overlap.
	 */
	private applyBoundsToChunks(
		chunks: Array<{ blocks: Int32Array; chunk_x: number; chunk_y: number; chunk_z: number }>,
		bounds: { min: THREE.Vector3; max: THREE.Vector3 },
		chunkDimensions: { chunkWidth: number; chunkHeight: number; chunkLength: number }
	): Array<{ blocks: Int32Array; chunk_x: number; chunk_y: number; chunk_z: number }> {
		const out: Array<{ blocks: Int32Array; chunk_x: number; chunk_y: number; chunk_z: number }> =
			[];
		const minX = bounds.min.x;
		const minY = bounds.min.y;
		const minZ = bounds.min.z;
		const maxX = bounds.max.x;
		const maxY = bounds.max.y;
		const maxZ = bounds.max.z;

		for (const c of chunks) {
			const chunkMinX = c.chunk_x * chunkDimensions.chunkWidth;
			const chunkMinY = c.chunk_y * chunkDimensions.chunkHeight;
			const chunkMinZ = c.chunk_z * chunkDimensions.chunkLength;
			const chunkMaxX = chunkMinX + chunkDimensions.chunkWidth;
			const chunkMaxY = chunkMinY + chunkDimensions.chunkHeight;
			const chunkMaxZ = chunkMinZ + chunkDimensions.chunkLength;

			// Whole chunk outside bounds — drop it.
			if (
				chunkMaxX <= minX ||
				chunkMinX >= maxX ||
				chunkMaxY <= minY ||
				chunkMinY >= maxY ||
				chunkMaxZ <= minZ ||
				chunkMinZ >= maxZ
			) {
				continue;
			}

			// Whole chunk inside bounds — keep as-is, no per-block filter.
			if (
				chunkMinX >= minX &&
				chunkMaxX <= maxX &&
				chunkMinY >= minY &&
				chunkMaxY <= maxY &&
				chunkMinZ >= minZ &&
				chunkMaxZ <= maxZ
			) {
				out.push(c);
				continue;
			}

			// Partial overlap — filter the block list.
			const blocks = c.blocks;
			const filtered: number[] = [];
			for (let i = 0; i < blocks.length; i += 4) {
				const x = blocks[i];
				const y = blocks[i + 1];
				const z = blocks[i + 2];
				if (x >= minX && x < maxX && y >= minY && y < maxY && z >= minZ && z < maxZ) {
					filtered.push(x, y, z, blocks[i + 3]);
				}
			}
			if (filtered.length > 0) {
				out.push({
					blocks: new Int32Array(filtered),
					chunk_x: c.chunk_x,
					chunk_y: c.chunk_y,
					chunk_z: c.chunk_z,
				});
			}
		}
		return out;
	}

	/**
	 * High-performance batched build mode
	 *
	 * Processes all chunks through a single worker that accumulates geometry,
	 * then returns just a few merged meshes (one per category: solid, transparent, etc.)
	 *
	 * Benefits:
	 * - Creates only 2-3 THREE.Mesh objects instead of hundreds
	 * - Drastically reduces main thread work
	 * - Best for large schematics where mesh count is the bottleneck
	 */
	public async buildSchematicMeshesBatched(
		schematicObject: SchematicObject,
		chunkDimensions: any = {
			chunkWidth: 16,
			chunkHeight: 16,
			chunkLength: 16,
		}
	): Promise<{
		meshes: THREE.Object3D[];
		chunkMap: Map<string, THREE.Object3D[]>;
	}> {
		const overallStartTime = performance.now();
		const schematic = schematicObject.schematicWrapper;

		// STEP 1: Initialize pipeline
		this.reportBuildProgress("Initializing batched pipeline...", 0.05);

		const palettes = this.getPalettes(schematic);
		performanceMonitor.startOperation("Palette Precomputation");
		await this.worldMeshBuilder.precomputePaletteGeometries(palettes.default, this);
		performanceMonitor.endOperation("Palette Precomputation");

		// STEP 2: Create chunk iterator
		this.reportBuildProgress("Creating chunk iterator...", 0.1);

		performanceMonitor.startOperation("Chunk Iterator Creation");
		const iterator = schematic.create_lazy_chunk_iterator(
			chunkDimensions.chunkWidth,
			chunkDimensions.chunkHeight,
			chunkDimensions.chunkLength,
			"bottom_up",
			0,
			0,
			0
		);
		performanceMonitor.endOperation("Chunk Iterator Creation");

		const totalChunks = iterator.total_chunks();

		if (totalChunks === 0) {
			this.reportBuildProgress("Schematic build complete (no chunks)", 1.0, 0, 0);
			return { meshes: [], chunkMap: new Map() };
		}

		// STEP 3: Collect all chunk data
		this.reportBuildProgress("Collecting chunk data...", 0.15, totalChunks, 0);

		const allChunks: Array<{
			blocks: Int32Array;
			chunk_x: number;
			chunk_y: number;
			chunk_z: number;
		}> = [];

		while (iterator.has_next()) {
			const chunkData = iterator.next();
			if (!chunkData || chunkData.blocks.length === 0) continue;

			// Convert blocks to Int32Array
			const blocks = chunkData.blocks;
			let blocksArray: Int32Array;

			if (blocks instanceof Int32Array) {
				blocksArray = blocks;
			} else {
				blocksArray = new Int32Array(blocks.length * 4);
				for (let i = 0; i < blocks.length; i++) {
					const block = blocks[i];
					blocksArray[i * 4] = block[0];
					blocksArray[i * 4 + 1] = block[1];
					blocksArray[i * 4 + 2] = block[2];
					blocksArray[i * 4 + 3] = block[3];
				}
			}

			allChunks.push({
				blocks: blocksArray,
				chunk_x: chunkData.chunk_x,
				chunk_y: chunkData.chunk_y,
				chunk_z: chunkData.chunk_z,
			});
		}

		// Apply rendering bounds: drop whole chunks that don't intersect, and
		// filter individual blocks in chunks that overlap the slice. The
		// batched worker path doesn't accept renderingBounds, so we strip
		// the blocks here before they ever leave the main thread.
		const bounds = schematicObject.renderingBounds?.enabled
			? schematicObject.renderingBounds
			: undefined;
		const chunksToProcess: Array<{
			blocks: Int32Array;
			chunk_x: number;
			chunk_y: number;
			chunk_z: number;
			apronBlocks?: Int32Array;
		}> = bounds ? this.applyBoundsToChunks(allChunks, bounds, chunkDimensions) : allChunks;

		// every cell's block, for the caps of what a filter hides and the box of what it shows
		this.fillCellGrid(chunksToProcess);

		// Attach each chunk's neighbour "apron" so faces on chunk seams cull against
		// the adjacent chunk (computed from the bounds-filtered set so it matches what
		// actually renders). Built once, linear in block count.
		const chunkAprons = this.computeChunkAprons(chunksToProcess, chunkDimensions);
		for (const c of chunksToProcess) {
			c.apronBlocks = chunkAprons.get(`${c.chunk_x},${c.chunk_y},${c.chunk_z}`);
		}

		// STEP 4: Process all chunks in batch mode
		this.reportBuildProgress("Processing chunks in BATCH mode...", 0.2, totalChunks, 0);
		performanceMonitor.startOperation("Process All Chunks");

		let processedCount = 0;
		const batchedMeshes = await this.worldMeshBuilder.processChunksBatched(
			chunksToProcess,
			(processed, total) => {
				processedCount = processed;
				const progress = 0.2 + (processed / total) * 0.7;
				this.reportBuildProgress(`Batch processing chunks...`, progress, total, processed);
			},
			this
		);

		performanceMonitor.endOperation("Process All Chunks");
		if (this.disposed) {
			for (const m of batchedMeshes) disposeObject(m);
			return { meshes: [], chunkMap: new Map() };
		}

		// STEP 5: Add meshes to scene
		this.reportBuildProgress(
			"Adding batched meshes to scene...",
			0.95,
			totalChunks,
			processedCount
		);

		// Add the meshes in frame-sized slices of vertices: each slice is rendered (which uploads it to
		// the GPU) before the next frame, so a huge build never stalls one frame on uploads, while a small
		// one goes up at once. (A fixed two meshes a frame made every small object, such as a chunk's
		// connected-texture blocks, cost a whole frame.) nextFrame also goes on in a hidden tab.
		const VERTICES_PER_FRAME = 1_000_000;
		let sliceVertices = 0;
		for (let i = 0; i < batchedMeshes.length; i++) {
			const mesh = batchedMeshes[i];
			if (this.disposed) {
				// removed while they went up: the rest are let go (those added went with the group)
				for (const m of batchedMeshes.slice(i)) disposeObject(m);
				return { meshes: [], chunkMap: new Map() };
			}
			if (this.filtering()) this.applyCellFilterTo(mesh, this.cellFilter);
			this.group.add(mesh);
			mesh.traverse((o) => {
				if (o instanceof THREE.Mesh) sliceVertices += o.geometry?.attributes?.position?.count ?? 0;
			});
			const last = i === batchedMeshes.length - 1;
			if (last || sliceVertices >= VERTICES_PER_FRAME) {
				this.schematicRenderer.renderManager?.render();
				sliceVertices = 0;
				if (!last) await nextFrame();
			}
		}

		this.group.updateMatrixWorld(true);

		const totalTime = performance.now() - overallStartTime;

		this.reportBuildProgress("Build complete!", 1.0, totalChunks, processedCount);

		// Dispatch completion event (not for a schematic removed by then)
		if (typeof window !== "undefined") {
			setTimeout(() => {
				if (this.disposed) return;
				window.dispatchEvent(
					new CustomEvent("schematicRenderComplete", {
						detail: {
							schematicId: this.id,
							schematicName: this.name,
							totalChunks,
							processedChunks: processedCount,
							buildTimeMs: totalTime,
							meshCount: batchedMeshes.length,
							optimized: true,
							batched: true,
						},
					})
				);
			}, 100);
		}

		return {
			meshes: batchedMeshes,
			chunkMap: new Map([["batched", batchedMeshes]]),
		};
	}

	public async buildSchematicMeshesInstanced(schematicObject: SchematicObject): Promise<{
		meshes: THREE.Object3D[];
		chunkMap: Map<string, THREE.Object3D[]>;
	}> {
		const overallStartTime = performance.now();

		// Initialize instanced rendering
		await this.worldMeshBuilder.precomputePaletteGeometries(
			this.getPalettes(this.schematicWrapper).default,
			this
		);

		this.worldMeshBuilder.enableInstancedRendering(this.group, true);

		// Render entire schematic using instanced rendering
		await this.worldMeshBuilder.renderSchematicInstanced(schematicObject);

		const totalTime = performance.now() - overallStartTime;

		// Return instanced meshes from scene graph
		const instancedMeshes = Array.from(this.group.children);
		if (this.disposed) return { meshes: [], chunkMap: new Map() };

		// Dispatch completion event
		if (typeof window !== "undefined") {
			window.dispatchEvent(
				new CustomEvent("schematicRenderComplete", {
					detail: {
						schematicId: this.id,
						schematicName: this.name,
						buildTimeMs: totalTime,
						meshCount: instancedMeshes.length,
						optimized: true,
						instanced: true, // Flag for instanced rendering
					},
				})
			);
		}

		return { meshes: instancedMeshes, chunkMap: new Map() };
	}

	/**
	 * Creates or updates the rendering bounds helper visualization
	 */
	private createRenderingBoundsHelper(visible: boolean = true): void {
		// Update the visualizer if it exists
		if (this.renderingBounds.helper) {
			this.group.remove(this.renderingBounds.helper);
		}

		if (visible && this.renderingBounds.enabled) {
			// Create a box to represent the rendering bounds
			const box = new THREE.Box3(
				this.renderingBounds.min.clone().add(new THREE.Vector3(-0.5, -0.5, -0.5)),
				this.renderingBounds.max.clone().add(new THREE.Vector3(-0.5, -0.5, -0.5))
			);

			// Create a box helper to visualize the bounds
			const helper = new THREE.Box3Helper(box, new THREE.Color(0x00ff00));
			this.renderingBounds.helper = helper;
			this.group.add(helper);
		} else {
			this.renderingBounds.helper = undefined;
		}
	}

	/**
	 * Sets the rendering bounds for this schematic
	 * @param min Minimum coordinates for rendering
	 * @param max Maximum coordinates for rendering
	 * @param showHelper Whether to show a visual helper for the bounds
	 */
	public setRenderingBounds(
		min: THREE.Vector3 | number[],
		max: THREE.Vector3 | number[],
		showHelper: boolean = true
	): void {
		if (this.disposed) return; // removed: its schematic may be freed
		// Convert arrays to Vector3 if needed
		if (Array.isArray(min)) {
			min = new THREE.Vector3(min[0], min[1], min[2]);
		}
		if (Array.isArray(max)) {
			max = new THREE.Vector3(max[0], max[1], max[2]);
		}

		// Update the rendering bounds
		this.renderingBounds.min = min.clone();
		this.renderingBounds.max = max.clone();

		// Create/update the visualizer if requested
		this.createRenderingBoundsHelper(showHelper);

		// Rebuild mesh to apply the rendering bounds
		this.rebuildMesh();
	}

	/**
	 * Updates rendering bounds without triggering rebuild - just emits change event
	 */
	private updateRenderingBounds(): void {
		// Just emit change event, don't rebuild automatically
		this.emitPropertyChanged("renderingBounds", {
			min: this.renderingBounds.min.toArray(),
			max: this.renderingBounds.max.toArray(),
			enabled: this.renderingBounds.enabled,
		});
	}

	/**
	 * Shows or hides the rendering bounds helper
	 * @param visible Whether the helper should be visible
	 */
	public showRenderingBoundsHelper(visible: boolean): void {
		this.createRenderingBoundsHelper(visible);
	}

	/**
	 * Resets the rendering bounds to include the full schematic
	 */
	public resetRenderingBounds(): void {
		const dimensions = this.getDimensions();
		this.setRenderingBounds(
			new THREE.Vector3(0, 0, 0),
			new THREE.Vector3(dimensions[0], dimensions[1], dimensions[2])
		);
	}

	public async getMeshes(): Promise<THREE.Object3D[]> {
		await this.meshesReady;
		return Array.from(this.group.children);
	}

	// Update chunk management methods to handle Object3D
	public getChunkObjectsAt(
		chunkX: number,
		chunkY: number,
		chunkZ: number
	): THREE.Object3D[] | null {
		const key = `${chunkX},${chunkY},${chunkZ}`;
		return this.chunkMeshes.get(key) || null;
	}

	public setChunkObjectsAt(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		objects: THREE.Object3D[]
	) {
		const key = `${chunkX},${chunkY},${chunkZ}`;
		this.chunkMeshes.set(key, objects);
	}

	// Keep the old method names for backward compatibility
	public getChunkMeshAt(chunkX: number, chunkY: number, chunkZ: number): THREE.Mesh[] | null {
		return this.getChunkObjectsAt(chunkX, chunkY, chunkZ) as THREE.Mesh[] | null;
	}

	public setChunkMeshAt(chunkX: number, chunkY: number, chunkZ: number, meshes: THREE.Mesh[]) {
		this.setChunkObjectsAt(chunkX, chunkY, chunkZ, meshes);
	}

	// Optimized material update method
	private updateMeshMaterials(property: "opacity") {
		// copies at the material's own opacity times the schematic's, or the meshes' own materials again
		this.applyOpacityTo(this.group);
		this.schematicRenderer.invalidate?.();
		// Emit event if necessary
		this.emitPropertyChanged("material", { property, value: this.opacity });
	}

	private updateMeshVisibility() {
		this.group.visible = this.visible;
		this.buildIfShown();
		// Emit event if necessary
		this.emitPropertyChanged("visibility", this.visible);
	}

	// Shown after a build was skipped while it was hidden: it is built now, and getMeshes() waits for that build.
	private buildIfShown() {
		if (this.visible && this.unbuilt && !this.disposed)
			this.meshesReady = this.track(this.buildMeshes());
	}

	public async updateMesh(): Promise<void> {
		if (this.disposed) return; // removed: its schematic may be freed
		return this.track(this.updateMeshNow());
	}

	private async updateMeshNow() {
		// Remove old meshes from the scene (shared materials are released, not disposed: MemoryLeakFix.disposeObject)
		this.unfade(this.group);
		this.meshes.forEach((mesh) => disposeObject(mesh));

		// Clear chunk meshes
		this.chunkMeshes.clear();
		// hidden, it is built once it is shown
		await this.buildMeshes();
	}

	public async rebuildMesh(): Promise<void> {
		if (this.disposed) return; // removed: its schematic may be freed
		return this.track(this.withBuildProgress(() => this.rebuildMeshNow()));
	}

	/** A build counted among those dispose() waits on before it frees the WASM schematic. */
	private track<T>(build: Promise<T>): Promise<T> {
		const over = build.then(
			() => undefined,
			() => undefined
		);
		this.builds = Promise.all([this.builds, over]).then(() => undefined);
		return build;
	}

	private async rebuildMeshNow() {
		performanceMonitor.startOperation(`rebuildMesh-${this.name}`);
		this.blocksVersion++;
		// a filter call still building its caps would add caps of the old blocks: the rebuild applies the filter
		this.filterCall++;
		this.clearCaps();

		// Show progress bar if enabled in renderer options (hidden once the rebuild is over: withBuildProgress)
		const renderer = this.sceneManager?.schematicRenderer;
		if (renderer?.options.enableProgressBar && renderer.uiManager) {
			this.holdProgressBar(`Rebuilding ${this.name}`);
			renderer.uiManager.updateProgress(0.1, "Disposing old meshes...");
		}

		// Remove old meshes from the scene (shared materials are released, not disposed: MemoryLeakFix.disposeObject)
		this.unfade(this.group);
		this.meshes.forEach((mesh) => disposeObject(mesh));

		// Also clear ALL children from the group, EXCEPT regions
		// Create a copy of children to iterate over safely
		const children = [...this.group.children];
		let removedCount = 0;

		for (const child of children) {
			// Skip regions - regions are parented to the schematic group and have names starting with "region_"
			// We check 'name' because 'id' is an internal three.js integer
			if (child.name && child.name.startsWith("region_")) {
				continue;
			}

			this.group.remove(child);
			removedCount++;
			disposeObject(child);
		}

		// Clear chunk meshes and update progress
		this.chunkMeshes.clear();
		this.meshes = [];

		if (renderer?.options.enableProgressBar && renderer.uiManager) {
			renderer.uiManager.updateProgress(0.2, "Building new meshes...");
		}

		// hidden, it is built once it is shown
		await this.buildMeshes();

		performanceMonitor.endOperation(`rebuildMesh-${this.name}`);
	}

	public getSchematicWrapper(): SchematicWrapper {
		return this.schematicWrapper;
	}

	public getRegions(): EditableRegionHighlight[] {
		return this.schematicRenderer.regionManager?.getRegionsForSchematic(this.id) || [];
	}

	public getRegion(name: string): EditableRegionHighlight | undefined {
		// First try scoped name
		const scopedName = `${this.id}_${name}`;
		const region = this.schematicRenderer.regionManager?.getRegion(scopedName);
		if (region) return region;

		// Fallback to raw name if user created it manually without scoping
		return this.schematicRenderer.regionManager?.getRegion(name);
	}

	public createRegion(
		name: string,
		min: { x: number; y: number; z: number },
		maxOrOptions?: { x: number; y: number; z: number } | { color?: number; opacity?: number },
		options?: { color?: number; opacity?: number }
	): EditableRegionHighlight {
		const scopedName = `${this.id}_${name}`;

		let max: { x: number; y: number; z: number };
		let finalOptions = options;

		// Check if 3rd argument (maxOrOptions) is a point (has x, y, z)
		if (
			maxOrOptions &&
			typeof maxOrOptions === "object" &&
			"x" in maxOrOptions &&
			"y" in maxOrOptions &&
			"z" in maxOrOptions
		) {
			max = maxOrOptions as { x: number; y: number; z: number };
		} else {
			// It's options or undefined, so default max to min (single block region)
			max = min;
			// If it's defined (options), use it as options
			if (maxOrOptions) {
				finalOptions = maxOrOptions as { color?: number; opacity?: number };
			}
		}

		return this.schematicRenderer.regionManager!.createRegion(
			scopedName,
			min,
			max,
			this.id,
			finalOptions
		);
	}

	// ========================================================================
	// Definition Region Methods
	// ========================================================================

	/**
	 * Track whether definition regions are currently visible for this schematic
	 */
	private _definitionRegionsVisible: boolean = false;

	/**
	 * Whether definition regions from schematic metadata are currently visible
	 */
	public get definitionRegionsVisible(): boolean {
		return this._definitionRegionsVisible;
	}

	/**
	 * Load definition regions from this schematic's metadata.
	 * Definition regions are stored in NucleationDefinitions metadata,
	 * typically created via CircuitBuilder, Insign, or direct API calls.
	 *
	 * @param autoShow - Whether to immediately show the regions (default: true based on renderer options)
	 * @returns Array of created region names
	 */
	public loadDefinitionRegions(autoShow?: boolean): string[] {
		if (!this.schematicRenderer.regionManager) {
			console.warn(
				"[SchematicObject] RegionManager not available, cannot load definition regions."
			);
			return [];
		}

		const shouldShow =
			autoShow ?? this.schematicRenderer.options.definitionRegionOptions?.showOnLoad ?? true;
		const regionNames = this.schematicRenderer.regionManager.loadDefinitionRegionsFromSchematic(
			this.id,
			shouldShow
		);

		this._definitionRegionsVisible = shouldShow && regionNames.length > 0;

		return regionNames;
	}

	/**
	 * Show all definition regions for this schematic
	 */
	public showDefinitionRegions(): void {
		this.schematicRenderer.regionManager?.showDefinitionRegions(this.id);
		this._definitionRegionsVisible = true;
	}

	/**
	 * Hide all definition regions for this schematic
	 */
	public hideDefinitionRegions(): void {
		this.schematicRenderer.regionManager?.hideDefinitionRegions(this.id);
		this._definitionRegionsVisible = false;
	}

	/**
	 * Toggle visibility of all definition regions for this schematic
	 * @returns The new visibility state
	 */
	public toggleDefinitionRegions(): boolean {
		const isVisible =
			this.schematicRenderer.regionManager?.toggleDefinitionRegions(this.id) ?? false;
		this._definitionRegionsVisible = isVisible;
		return isVisible;
	}

	/**
	 * Check if this schematic has any definition regions loaded
	 */
	public hasDefinitionRegions(): boolean {
		return this.schematicRenderer.regionManager?.hasDefinitionRegions(this.id) ?? false;
	}

	/**
	 * Get the names of all definition regions for this schematic
	 */
	public getDefinitionRegionNames(): string[] {
		// First get regions from schematic wrapper metadata
		const metadataRegions = this.schematicWrapper.getDefinitionRegionNames();
		return Array.from(metadataRegions);
	}

	/**
	 * Get a definition region by its original name (from schematic metadata).
	 * Returns the EditableRegionHighlight if loaded, or undefined.
	 */
	public getDefinitionRegion(name: string): EditableRegionHighlight | undefined {
		const scopedName = `${this.id}_defRegion_${name}`;
		return this.schematicRenderer.regionManager?.getRegion(scopedName);
	}

	/**
	 * Remove all loaded definition regions for this schematic
	 */
	public removeDefinitionRegions(): void {
		this.schematicRenderer.regionManager?.removeDefinitionRegions(this.id);
		this._definitionRegionsVisible = false;
	}

	/**
	 * Creates a callable JavaScript function from this schematic using region-based IO.
	 * This allows you to treat the schematic as a black-box function in JS.
	 *
	 * @param inputs List of input definitions
	 * @param outputs List of output definitions
	 * @returns A callable object to run the circuit
	 */
	public createCircuitFunction(
		inputs: Array<{
			name: string;
			bits: number;
			region:
				| { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }
				| string
				| DefinitionRegionWrapper;
			signed?: boolean;
			mode?: "binary" | "signal";
			blockFilter?: string | string[];
			sort?: string | SortStrategyWrapper;
		}>,
		outputs: Array<{
			name: string;
			bits: number;
			region:
				| { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }
				| string
				| DefinitionRegionWrapper;
			signed?: boolean;
			mode?: "binary" | "signal";
			blockFilter?: string | string[];
			sort?: string | SortStrategyWrapper;
		}>
	) {
		// Dynamic import to avoid circular dependencies if any, and access the exported builders
		// We use the schematicWrapper instance we already have

		// 1. Build the Circuit using CircuitBuilderWrapper
		// This uses the new high-level API which handles layout building and executor creation
		let builder = new CircuitBuilderWrapper(this.schematicWrapper);

		// Helper to resolve region
		const resolveRegion = (
			region:
				| { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }
				| string
				| DefinitionRegionWrapper,
			filters?: string | string[]
		) => {
			let defRegion: DefinitionRegionWrapper;

			if (region instanceof DefinitionRegionWrapper) {
				defRegion = region;
			} else if (typeof region === "string") {
				// Try using getRegion to handle scoping automatically
				const regionObj = this.getRegion(region);
				if (!regionObj) {
					throw new Error(`Region '${region}' not found in RegionManager`);
				}
				// Use the region's native conversion method, passing the schematic for filtering
				defRegion = regionObj.toDefinitionRegion(this.schematicWrapper);
			} else {
				// It's a simple bounds object
				defRegion = DefinitionRegionWrapper.fromBounds(
					new BlockPosition(region.min.x, region.min.y, region.min.z),
					new BlockPosition(region.max.x, region.max.y, region.max.z)
				);
			}

			// Apply additional filters from arguments if provided
			// Note: If the region itself already applied filters (in toDefinitionRegion),
			// these will be applied ON TOP (intersection or union depending on intent, here usually filtering further)
			// But actually, toDefinitionRegion returns the filtered points.
			// filterByBlock returns a subset. So applying another filterByBlock intersects.

			// However, the previous logic was: if filters provided, filter the box.
			// Now: if region has internal filters, it returns filtered points.
			// If we also provide filters here, we probably want to apply them too.

			if (filters) {
				const filterList = Array.isArray(filters) ? filters : [filters];
				if (filterList.length > 0) {
					// Apply first filter
					const filteredRegion = defRegion.filterByBlock(this.schematicWrapper, filterList[0]);

					// Apply subsequent filters and union results (OR logic)
					for (let i = 1; i < filterList.length; i++) {
						const nextFiltered = defRegion.filterByBlock(this.schematicWrapper, filterList[i]);
						filteredRegion.unionInto(nextFiltered);
						nextFiltered.free();
					}

					// If defRegion was created locally or returned new from toDefinitionRegion, we should free it
					if (!(region instanceof DefinitionRegionWrapper)) {
						defRegion.free();
					}

					defRegion = filteredRegion;
				}
			}

			return defRegion;
		};

		// Helper to resolve sort strategy
		const resolveSort = (sort?: string | SortStrategyWrapper): SortStrategyWrapper | undefined => {
			if (!sort) return undefined;
			if (sort instanceof SortStrategyWrapper) return sort;
			if (typeof sort === "string") {
				return SortStrategyWrapper.fromString(sort);
			}
			return undefined;
		};

		// Add Inputs
		for (const input of inputs) {
			// If using signal mode (packed4), force bits to be at least 4 to match layout expectations
			const effectiveBits = input.mode === "signal" && input.bits < 4 ? 4 : input.bits;

			const type = input.signed
				? IoTypeWrapper.signedInt(effectiveBits)
				: IoTypeWrapper.unsignedInt(effectiveBits);

			const region = resolveRegion(input.region, input.blockFilter);
			const sortStrategy = resolveSort(input.sort);

			if (input.mode === "signal") {
				const layout = LayoutFunctionWrapper.packed4();
				if (sortStrategy) {
					builder = builder.withInputSorted(input.name, type, layout, region, sortStrategy);
				} else {
					builder = builder.withInput(input.name, type, layout, region);
				}
			} else {
				// Use Auto for default/binary mode
				if (sortStrategy) {
					builder = builder.withInputAutoSorted(input.name, type, region, sortStrategy);
				} else {
					builder = builder.withInputAuto(input.name, type, region);
				}
			}
		}

		// Add Outputs
		for (const output of outputs) {
			// If using signal mode (packed4), force bits to be at least 4 to match layout expectations
			const effectiveBits = output.mode === "signal" && output.bits < 4 ? 4 : output.bits;

			const type = output.signed
				? IoTypeWrapper.signedInt(effectiveBits)
				: IoTypeWrapper.unsignedInt(effectiveBits);

			const region = resolveRegion(output.region, output.blockFilter);
			const sortStrategy = resolveSort(output.sort);

			if (output.mode === "signal") {
				const layout = LayoutFunctionWrapper.packed4();
				if (sortStrategy) {
					builder = builder.withOutputSorted(output.name, type, layout, region, sortStrategy);
				} else {
					builder = builder.withOutput(output.name, type, layout, region);
				}
			} else {
				// Use Auto for default/binary mode
				if (sortStrategy) {
					builder = builder.withOutputAutoSorted(output.name, type, region, sortStrategy);
				} else {
					builder = builder.withOutputAuto(output.name, type, region);
				}
			}
		}

		// Build directly to executor
		const executor = builder.build();

		// 4. Return the Interface
		return {
			run: (
				inputValues: Record<string, number | boolean>,
				maxTicks = 1000,
				mode: "stable" | "fixed" = "stable"
			) => {
				// Sanitize inputs: Convert booleans to numbers (1/0)
				const sanitizedInputs: Record<string, number> = {};
				for (const [key, val] of Object.entries(inputValues)) {
					sanitizedInputs[key] = typeof val === "boolean" ? (val ? 1 : 0) : val;
				}

				let executionMode;
				if (mode === "fixed") {
					executionMode = ExecutionModeWrapper.fixedTicks(maxTicks);
				} else {
					executionMode = ExecutionModeWrapper.untilStable(2, maxTicks);
				}

				const result = executor.execute(sanitizedInputs, executionMode);
				return result;
			},
			reset: () => executor.reset(),
			sync: async () => {
				const updatedSchematic = executor.syncToSchematic();
				// Update the wrapper reference to the new state
				this.schematicWrapper = updatedSchematic;
				// Rebuild visuals
				await this.rebuildMesh();
				// Return the current outputs for convenience
				// Note: This requires polling the outputs again from the executor if we want the latest values
				// But since syncToSchematic consumes the simulation state, we might not be able to query outputs directly afterwards
				// unless we re-create the executor or if syncToSchematic keeps the simulation alive.
				// Based on mchprs logic, sync usually updates the schematic data.
			},
			executor,
		};
	}

	private getPalettes(schematic: SchematicWrapper): any {
		// Safety check for get_all_palettes
		if (typeof schematic.get_all_palettes === "function") {
			return schematic.get_all_palettes();
		}

		console.warn("[SchematicObject] get_all_palettes missing, falling back to get_palette");

		// Fallback to get_palette
		if (typeof schematic.get_palette === "function") {
			return { default: schematic.get_palette() };
		}

		console.error("[SchematicObject] Both get_all_palettes and get_palette are missing!");
		return { default: [] };
	}

	public getBlockEntitiesMap(): Map<string, any> {
		if (this.blockEntitiesMap === null) {
			this.blockEntitiesMap = new Map();
			const entities = this.schematicWrapper.get_all_block_entities() || [];
			for (const entity of entities) {
				if (entity && entity.position && entity.position.length === 3) {
					const key = `${entity.position[0]},${entity.position[1]},${entity.position[2]}`;
					this.blockEntitiesMap.set(key, entity);
				}
			}
		}
		return this.blockEntitiesMap;
	}

	public async setBlockNoRebuild(position: THREE.Vector3 | number[], blockType: string) {
		if (this.disposed) return; // removed: its schematic may be freed
		// performanceMonitor.startOperation("setBlockNoRebuild"); // Too much overhead for bulk operations
		if (Array.isArray(position)) {
			position = new THREE.Vector3(position[0], position[1], position[2]);
		}

		this.schematicWrapper.set_block(position.x, position.y, position.z, blockType);

		// Invalidate cached dimensions since we modified the schematic
		this._cachedDimensions = null;
		this.blockEntitiesMap = null;
		this.blocksVersion++;

		// performanceMonitor.endOperation("setBlockNoRebuild");
	}

	public async setBlockWithNbt(
		position: THREE.Vector3 | number[],
		blockType: string,
		nbtData: Record<string, string>
	) {
		if (this.disposed) return; // removed: its schematic may be freed
		performanceMonitor.startOperation("setBlockWithNbt");
		if (Array.isArray(position)) {
			position = new THREE.Vector3(position[0], position[1], position[2]);
		}

		this.schematicWrapper.setBlockWithNbt(position.x, position.y, position.z, blockType, nbtData);
		this.blocksVersion++;
		performanceMonitor.endOperation("setBlockWithNbt");
	}

	/**
	 * Compiles Insign annotations from sign blocks in the schematic
	 * @returns Raw Insign data (DslMap) or null if compilation fails
	 */
	public compileInsign(): any {
		try {
			return this.schematicWrapper.compileInsign();
		} catch (e) {
			console.warn("[SchematicObject] Insign compilation failed:", e);
			return null;
		}
	}

	public async setBlock(position: THREE.Vector3 | number[], blockType: string) {
		if (Array.isArray(position)) {
			position = new THREE.Vector3(position[0], position[1], position[2]);
		}
		await this.setBlockNoRebuild(position, blockType);

		await this.rebuildChunkAtPosition(position);
	}

	// Optimized batch block setting
	public async setBlocks(blocks: [THREE.Vector3 | number[], string][]) {
		const affectedChunks = new Set<string>();
		let startTime = performance.now();
		performanceMonitor.startOperation("setBlocks");
		console.log("Setting blocks");
		resetPerformanceMetrics();

		// Batch all block updates first
		for (let [position, blockType] of blocks) {
			if (Array.isArray(position)) {
				position = new THREE.Vector3(position[0], position[1], position[2]);
			}
			await this.setBlockNoRebuild(position, blockType);
			for (const [x, y, z] of this.chunksEditedAt(position)) affectedChunks.add(`${x},${y},${z}`);
		}
		console.log("Blocks set");
		performanceMonitor.endOperation("setBlocks");
		console.log("Time to set blocks:", performance.now() - startTime + "ms");

		startTime = performance.now();
		console.log("Rebuilding chunks");

		// Rebuild all affected chunks in parallel
		const rebuildPromises: Promise<void>[] = [];
		for (const chunk of affectedChunks) {
			const [chunkX, chunkY, chunkZ] = chunk.split(",").map((v) => parseInt(v));
			rebuildPromises.push(this.rebuildChunk(chunkX, chunkY, chunkZ));
		}

		// Wait for all chunks to rebuild
		await Promise.all(rebuildPromises);
		console.log("Chunks rebuilt in", performance.now() - startTime + "ms");
	}

	public async copyRegionFromSchematic(
		sourceSchematicName: string,
		sourceMin?: THREE.Vector3 | number[],
		sourceMax?: THREE.Vector3 | number[],
		targetPosition?: THREE.Vector3 | number[],
		excludeBlocks?: string[],
		rebuild: boolean = false
	) {
		const sourceSchematic =
			this.sceneManager?.schematicRenderer?.schematicManager?.getSchematic(sourceSchematicName);
		if (!sourceSchematic) {
			throw new Error(`Schematic ${sourceSchematicName} not found`);
		}
		if (Array.isArray(sourceMin)) {
			sourceMin = new THREE.Vector3(sourceMin[0], sourceMin[1], sourceMin[2]);
		}
		if (Array.isArray(sourceMax)) {
			sourceMax = new THREE.Vector3(sourceMax[0], sourceMax[1], sourceMax[2]);
		}
		if (Array.isArray(targetPosition)) {
			targetPosition = new THREE.Vector3(targetPosition[0], targetPosition[1], targetPosition[2]);
		}

		const sourceDimensions = sourceSchematic.getDimensions();

		if (!sourceMin) {
			sourceMin = new THREE.Vector3(0, 0, 0);
		}
		if (!sourceMax) {
			sourceMax = new THREE.Vector3(
				sourceDimensions[0] - 1,
				sourceDimensions[1] - 1,
				sourceDimensions[2] - 1
			);
		}

		if (!targetPosition) {
			targetPosition = new THREE.Vector3(0, 0, 0);
		}

		if (!excludeBlocks) {
			excludeBlocks = [];
		}

		await this.schematicWrapper.copy_region(
			sourceSchematic.schematicWrapper,
			sourceMin.x,
			sourceMin.y,
			sourceMin.z,
			sourceMax.x,
			sourceMax.y,
			sourceMax.z,
			targetPosition.x,
			targetPosition.y,
			targetPosition.z,
			excludeBlocks
		);

		if (rebuild) {
			await this.rebuildMesh();
		}
	}

	public getBlock(position: THREE.Vector3 | number[]): string | undefined {
		if (Array.isArray(position)) {
			position = new THREE.Vector3(position[0], position[1], position[2]);
		}
		return this.schematicWrapper.get_block(position.x, position.y, position.z);
	}

	public debugBlock(position: THREE.Vector3 | { x: number; y: number; z: number }) {
		const x = Math.floor(position.x);
		const y = Math.floor(position.y);
		const z = Math.floor(position.z);

		console.log(`🔍 Debug Block at (${x}, ${y}, ${z}):`);
		const blockType = this.schematicWrapper.get_block(x, y, z);
		console.log(`Type: ${blockType}`);

		try {
			// @ts-ignore
			const blockState = this.schematicWrapper.get_block_with_properties?.(x, y, z);
			if (blockState) {
				console.log(`Properties:`, blockState.properties());
			}
		} catch (e) {
			console.warn("Could not get block properties:", e);
		}

		try {
			const sim = this.schematicWrapper.create_simulation_world();
			console.log(`Redstone Power: ${sim.get_redstone_power(x, y, z)}`);
			// @ts-ignore
			if (sim.is_lit) {
				// @ts-ignore
				console.log(`Is Lit: ${sim.is_lit(x, y, z)}`);
			}
			sim.free();
		} catch (e) {
			console.warn("Could not check simulation state:", e);
		}
	}

	public async replaceBlock(replaceBlock: string, newBlock: string) {
		const blocks: [THREE.Vector3, string][] = [];
		const dimensions = this.getDimensions();
		for (let x = 0; x < dimensions[0]; x++) {
			for (let y = 0; y < dimensions[1]; y++) {
				for (let z = 0; z < dimensions[2]; z++) {
					const block = this.schematicWrapper.get_block(x, y, z);
					if (block === replaceBlock) {
						blocks.push([new THREE.Vector3(x, y, z), newBlock]);
					}
				}
			}
		}
		await this.setBlocks(blocks);
	}

	public async addCube(
		position: THREE.Vector3 | number[],
		size: THREE.Vector3 | number[],
		blockType: string
	): Promise<SchematicObject> {
		if (Array.isArray(position)) {
			position = new THREE.Vector3(position[0], position[1], position[2]);
		}
		if (Array.isArray(size)) {
			size = new THREE.Vector3(size[0], size[1], size[2]);
		}

		const blocks: [THREE.Vector3, string][] = [];
		for (let x = 0; x < size.x; x++) {
			for (let y = 0; y < size.y; y++) {
				for (let z = 0; z < size.z; z++) {
					blocks.push([position.clone().add(new THREE.Vector3(x, y, z)), blockType]);
				}
			}
		}

		await this.setBlocks(blocks);
		return this;
	}

	/** Remeshes what an edit of the block at `position` can change: its chunk, and the neighbours it borders. */
	public async rebuildChunkAtPosition(position: THREE.Vector3) {
		await Promise.all(this.chunksEditedAt(position).map(([x, y, z]) => this.rebuildChunk(x, y, z)));
	}

	/**
	 * The chunks an edit of the block at `position` can change: its own, and for each face of its chunk it lies on,
	 * the neighbour across that face, whose faces against it the block covered or now covers (a block removed there
	 * left a hole in the neighbour). A block inside its chunk changes only that chunk.
	 */
	private chunksEditedAt(position: THREE.Vector3): Array<[number, number, number]> {
		const { chunkWidth: w, chunkHeight: h, chunkLength: l } = this.chunkDimensions;
		const { x, y, z } = this.getChunkCoordinates(position);
		const chunks: Array<[number, number, number]> = [[x, y, z]];
		// where the block is in its chunk, on each axis (0 to size - 1, for negative coordinates too)
		const at = (v: number, size: number) => ((Math.floor(v) % size) + size) % size;
		const ax = at(position.x, w),
			ay = at(position.y, h),
			az = at(position.z, l);
		if (ax === 0) chunks.push([x - 1, y, z]);
		if (ax === w - 1) chunks.push([x + 1, y, z]);
		if (ay === 0) chunks.push([x, y - 1, z]);
		if (ay === h - 1) chunks.push([x, y + 1, z]);
		if (az === 0) chunks.push([x, y, z - 1]);
		if (az === l - 1) chunks.push([x, y, z + 1]);
		return chunks;
	}

	public rebuildAllChunks(): void {
		// Rebuild all chunks by triggering a full mesh rebuild
		this.rebuildMesh();
	}

	private getChunkCoordinates(position: THREE.Vector3): {
		x: number;
		y: number;
		z: number;
	} {
		return {
			x: Math.floor(position.x / this.chunkDimensions.chunkWidth),
			y: Math.floor(position.y / this.chunkDimensions.chunkHeight),
			z: Math.floor(position.z / this.chunkDimensions.chunkLength),
		};
	}

	public async rebuildChunk(chunkX: number, chunkY: number, chunkZ: number): Promise<void> {
		if (this.disposed) return; // removed: its schematic may be freed
		// not built while hidden: the build made once it is shown meshes the edit with the rest
		if (this.unbuilt) return;
		return this.track(this.rebuildChunkNow(chunkX, chunkY, chunkZ));
	}

	private async rebuildChunkNow(chunkX: number, chunkY: number, chunkZ: number) {
		const chunkOffset = {
			x: chunkX * this.chunkDimensions.chunkWidth,
			y: chunkY * this.chunkDimensions.chunkHeight,
			z: chunkZ * this.chunkDimensions.chunkLength,
		};

		// Check if chunk is outside rendering bounds - if so, just remove it
		if (this.renderingBounds) {
			const chunkMaxX = chunkOffset.x + this.chunkDimensions.chunkWidth;
			const chunkMaxY = chunkOffset.y + this.chunkDimensions.chunkHeight;
			const chunkMaxZ = chunkOffset.z + this.chunkDimensions.chunkLength;

			// If the chunk is completely outside rendering bounds, just remove it
			if (
				chunkMaxX <= this.renderingBounds.min.x ||
				chunkOffset.x >= this.renderingBounds.max.x ||
				chunkMaxY <= this.renderingBounds.min.y ||
				chunkOffset.y >= this.renderingBounds.max.y ||
				chunkMaxZ <= this.renderingBounds.min.z ||
				chunkOffset.z >= this.renderingBounds.max.z
			) {
				this.removeChunkObjects(chunkX, chunkY, chunkZ);
				return;
			}
		}

		// The chunk is meshed against this schematic's palette, built again if an edit added a block to it (the last
		// palette built may be another schematic's)
		await this.worldMeshBuilder.precomputePaletteGeometries(
			this.getPalettes(this.schematicWrapper).default,
			this
		);
		if (this.disposed) return;

		// Use WASM optimization to get both blocks and pre-filtered entities
		// Cast to any as TS definitions might not be up to date immediately
		let chunkData: any;
		let blocks: any[];
		let entities: any[] | undefined;

		// Check if the new method exists (it should with nucleation 0.1.116)
		if ((this.schematicWrapper as any).getChunkData) {
			chunkData = (this.schematicWrapper as any).getChunkData(
				chunkX,
				chunkY,
				chunkZ,
				this.chunkDimensions.chunkWidth,
				this.chunkDimensions.chunkHeight,
				this.chunkDimensions.chunkLength
			);
			blocks = chunkData.blocks;
			entities = chunkData.entities;
		} else {
			// Fallback for older versions
			blocks = this.schematicWrapper.get_chunk_blocks_indices(
				chunkOffset.x,
				chunkOffset.y,
				chunkOffset.z,
				this.chunkDimensions.chunkWidth,
				this.chunkDimensions.chunkHeight,
				this.chunkDimensions.chunkLength
			);
		}

		// its faces on its seams culled against the neighbours' blocks, as in a full build
		const apronBlocks = this.chunkApron(chunkX, chunkY, chunkZ);

		// Remove old chunk objects from the scene
		this.removeChunkObjects(chunkX, chunkY, chunkZ);

		// Build new chunk objects using the optimized format
		const newChunkObjects = await this.worldMeshBuilder.getChunkMesh(
			{
				blocks: blocks, // This is already in format: [[x,y,z,paletteIndex],...]
				chunk_x: chunkX,
				chunk_y: chunkY,
				chunk_z: chunkZ,
				apronBlocks,
			},
			this,
			this.renderingBounds,
			entities // Pass pre-filtered entities if available
		);

		// Apply properties to the new objects
		this.applyPropertiesToObjects(newChunkObjects);

		newChunkObjects.forEach((obj) => {
			this.group.add(obj);
		});

		// Update the chunk object reference in chunkMeshes map
		this.setChunkObjectsAt(chunkX, chunkY, chunkZ, newChunkObjects);

		// the grid follows the edit, what is shown holds for the new objects, and the caps come from the edited blocks
		this.writeCellGrid(chunkOffset, blocks, `${chunkX},${chunkY},${chunkZ}`);
		const wanted = this.wanted();
		if (wanted.range || wanted.hidden?.size) await this.setCellFilter(wanted);
	}

	/**
	 * The blocks of the neighbouring chunks' planes that face a chunk (flat [x, y, z, paletteIndex, ...]), as
	 * computeChunkAprons gives each chunk of a full build: the mesher culls the chunk's faces on its seams against them
	 * (they are never drawn). Those outside the rendering bounds are left out, as the batched build leaves them out.
	 * Undefined when there are none.
	 */
	private chunkApron(chunkX: number, chunkY: number, chunkZ: number): Int32Array | undefined {
		const { chunkWidth: w, chunkHeight: h, chunkLength: l } = this.chunkDimensions;
		const x = chunkX * w,
			y = chunkY * h,
			z = chunkZ * l;
		// each neighbour's plane against this chunk: offset, then size
		const planes: Array<[number, number, number, number, number, number]> = [
			[x - 1, y, z, 1, h, l],
			[x + w, y, z, 1, h, l],
			[x, y - 1, z, w, 1, l],
			[x, y + h, z, w, 1, l],
			[x, y, z - 1, w, h, 1],
			[x, y, z + l, w, h, 1],
		];
		const bounds = this.renderingBounds?.enabled ? this.renderingBounds : null;
		const apron: number[] = [];
		for (const plane of planes) {
			for (const [bx, by, bz, index] of this.schematicWrapper.get_chunk_blocks_indices(...plane)) {
				if (
					bounds &&
					!(
						bx >= bounds.min.x &&
						bx < bounds.max.x &&
						by >= bounds.min.y &&
						by < bounds.max.y &&
						bz >= bounds.min.z &&
						bz < bounds.max.z
					)
				)
					continue;
				apron.push(bx, by, bz, index);
			}
		}
		return apron.length ? Int32Array.from(apron) : undefined;
	}

	// ===== DISPOSAL =====

	/** Whether dispose() has run (the schematic was removed). */
	public isDisposed(): boolean {
		return this.disposed;
	}

	/**
	 * Lets go of everything the schematic holds once it is removed (SchematicManager.removeSchematic): stops its
	 * property watcher (a timer that would otherwise keep it, and all it holds, alive for good), drops its meshes,
	 * cell grids, caps and caches, and frees the WASM schematic it was made from once every build in flight (the first,
	 * rebuilds, chunk rebuilds) has stopped. A build still running stops at its next chunk and reports nothing, and
	 * none starts after. The scene objects are the caller's to
	 * dispose (disposeGroup on `group`).
	 */
	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this._propertyWatcherTimer) clearTimeout(this._propertyWatcherTimer);
		this._propertyWatcherTimer = null;
		this.clearCaps();
		// the meshes get their own materials back, to be released with them (disposeGroup), and the copies go
		this.unfade(this.group);
		this.dropFadedMaterials();
		this.meshes = [];
		this.chunkMeshes.clear();
		this.cellGrid = null;
		this.cellGridBox = null;
		this.connectedCells = null;
		this.cellGroupData = null;
		this.groupCells = null;
		this.shownBoxCache = null;
		this.blockEntitiesMap = null;
		delete (this as { _entitySpatialCache?: unknown })._entitySpatialCache;
		const wrapper = this.ownsWrapper ? this.schematicWrapper : null;
		void this.builds.then(() => {
			// its palette goes once no other schematic draws with it
			this.worldMeshBuilder.releasePalette?.(this);
			try {
				wrapper?.free();
			} catch (e) {
				console.warn("[SchematicObject] could not free the schematic", e);
			}
		});
	}

	// ===== CELLS SHOWN =====
	//
	// A range of layers (setLayerRange) and groups of cells (setHiddenGroups: a caller's labels from setCellGroups,
	// such as the parts of a build) can be hidden without meshing again: the WASM mesher orders each mesh's triangles
	// by material, layer and cell group, a filter points each material's groups at the index ranges of what it shows
	// (utils/layerRange.ts), the objects of a block (signs, block entities, connected-texture blocks with several
	// materials) are shown or hidden with their cell, and the faces the hidden cells covered on the shown ones are
	// drawn by cap meshes built for that filter (WorldMeshBuilder.buildCaps) and kept for the next time. The picture is
	// the one a build of the shown cells alone gives.

	/** The layers shown (setLayerRange; the last asked for, while its caps are built), or null for all of them. */
	public getLayerRange(): LayerRange | null {
		const range = this.wanted().range;
		return range ? { ...range } : null;
	}

	/** The cell groups hidden (setHiddenGroups; the last asked for, while its caps are built), ascending. */
	public getHiddenGroups(): number[] {
		return [...(this.wanted().hidden ?? [])].sort((a, b) => a - b);
	}

	/** The filter last asked for: the one shown, or one whose caps are being built. */
	private wanted(): CellFilter {
		return this.wantedFilter ?? this.cellFilter;
	}

	/**
	 * Shows only the layers `minY` to `maxY - 1` (schematic y; null: every layer), the hidden cell groups staying
	 * hidden. Resolves true once it shows (a later call takes over from one still building its caps), or false when
	 * this build cannot (meshes without layer runs: greedy meshing, the instanced or WebGPU paths, the JavaScript
	 * mesher); rebuild with renderingBounds then. Before the first build, the range is kept and the build starts
	 * with it.
	 */
	public async setLayerRange(range: LayerRange | null): Promise<boolean> {
		if (this.disposed) return false; // removed: its schematic may be freed
		return this.setCellFilter({ range: this.layerRangeOf(range), hidden: this.wanted().hidden });
	}

	/**
	 * Shows the layers of `layerRange` (null: all) less the cells of `hiddenGroups` (null: none) in one step: one
	 * set of caps for both. Resolves as setLayerRange does.
	 */
	public async showCells(
		layerRange: LayerRange | null,
		hiddenGroups: Iterable<number> | null
	): Promise<boolean> {
		if (this.disposed) return false; // removed: its schematic may be freed
		const hidden = hiddenGroups ? new Set(hiddenGroups) : null;
		return this.setCellFilter({ range: this.layerRangeOf(layerRange), hidden });
	}

	/**
	 * A range within the schematic's layers, in whole layers (a fractional end takes in the layer it cuts; an end
	 * left open, NaN or infinite, is the schematic's), or null when it covers them all.
	 */
	private layerRangeOf(range: LayerRange | null): LayerRange | null {
		if (!range) return null;
		const box = schematicBox(this.schematicWrapper);
		const bottom = box.min[1],
			top = box.max[1] + 1;
		const minY = Number.isNaN(range.minY) ? bottom : Math.max(bottom, Math.floor(range.minY));
		const maxY = Number.isNaN(range.maxY) ? top : Math.min(top, Math.ceil(range.maxY));
		return minY > bottom || maxY < top ? { minY, maxY } : null;
	}

	/**
	 * Hides the cells of these groups (setCellGroups; null or empty: none), the layer range staying as it is. Resolves
	 * as setLayerRange does.
	 */
	public async setHiddenGroups(groups: Iterable<number> | null): Promise<boolean> {
		if (this.disposed) return false; // removed: its schematic may be freed
		const hidden = groups ? new Set(groups) : null;
		return this.setCellFilter({
			range: this.wanted().range,
			hidden: hidden?.size ? hidden : null,
		});
	}

	/**
	 * Labels every cell with a group (Sponge order over the schematic's bounding box: index
	 * ((y - minY) * length + (z - minZ)) * width + (x - minX); null: all in group 0), for setHiddenGroups. The
	 * meshes are ordered by group, so a build that has them already is built again.
	 */
	public async setCellGroups(groups: Uint16Array | null): Promise<void> {
		if (this.disposed) return; // removed: its schematic may be freed
		this.cellGroupData = groups;
		this.cellGroupBox = groups ? schematicBox(this.schematicWrapper) : null;
		this.groupCells = null;
		if (this.meshes.length) await this.rebuildMesh();
	}

	/** A cell's group (setCellGroups), 0 for one without. */
	public cellGroupAt(x: number, y: number, z: number): number {
		const data = this.cellGroupData,
			box = this.cellGroupBox;
		if (!data || !box) return 0;
		const i = cellIndex(box, x, y, z);
		return i < 0 ? 0 : (data[i] ?? 0);
	}

	/** The groups of some blocks ([x, y, z, paletteIndex] flat or as arrays) for the mesher; none without groups. */
	public cellGroupsOf(
		blocks: Int32Array | ArrayLike<number> | number[][]
	): Uint16Array | undefined {
		if (!this.cellGroupData) return undefined;
		if (blocks instanceof Int32Array) {
			const out = new Uint16Array(blocks.length / 4);
			for (let i = 0; i < out.length; i++)
				out[i] = this.cellGroupAt(blocks[i * 4], blocks[i * 4 + 1], blocks[i * 4 + 2]);
			return out;
		}
		const list = blocks as number[][];
		return Uint16Array.from(list, (b) => this.cellGroupAt(b[0], b[1], b[2]));
	}

	/** Whether a cell shows under the layer range and hidden groups shown. */
	public isCellShown(x: number, y: number, z: number): boolean {
		return shownBy(y, this.cellGroupAt(x, y, z), this.cellFilter);
	}

	/** A key of what is shown: the block and cell grid versions, the layer range and the hidden groups. */
	public cellFilterKey(): string {
		return `${this.blocksVersion}.${this.gridKey()}`;
	}

	/** A key of what the cell grid shows: its version, the layer range and the hidden groups (caps, shownCellBox). */
	private gridKey(filter: CellFilter = this.cellFilter): string {
		// kept for the filter and grid it is of: the camera asks for it every frame (fitNearPlane)
		const memo = this.gridKeyMemo;
		if (memo?.filter === filter && memo.version === this.gridVersion) return memo.key;
		const r = filter.range;
		const hidden = [...(filter.hidden ?? [])].sort((a, b) => a - b);
		const key = `${this.gridVersion}|${r ? `${r.minY}-${r.maxY}` : "all"}|${hidden.join(",")}`;
		this.gridKeyMemo = { filter, version: this.gridVersion, key };
		return key;
	}
	private gridKeyMemo: { filter: CellFilter; version: number; key: string } | null = null;

	/** Whether every mesh of the build knows its layers and groups (runs in its geometry, or a cell of its own). */
	public canShowLayerRange(): boolean {
		let ok = true;
		const check = (o: THREE.Object3D, tagged: boolean) => {
			const isTagged = tagged || o.userData.layerY !== undefined;
			if (o instanceof THREE.Mesh && !isTagged && !o.geometry?.userData?.layerIndex) ok = false;
			for (const child of o.children) check(child, isTagged);
		};
		for (const mesh of this.meshes) check(mesh, false);
		return ok;
	}

	private filtering(): boolean {
		return !!(this.cellFilter.range || this.cellFilter.hidden?.size);
	}

	/**
	 * Shows a filter once its caps are built; until then the filter shown stays (what is framed, the near plane,
	 * picking), and getLayerRange / getHiddenGroups say the one asked for. A later call, a rebuild or removal takes
	 * over from one still building its caps.
	 */
	private async setCellFilter(asked: CellFilter): Promise<boolean> {
		if (this.disposed) return false;
		if (this.meshes.length && !this.canShowLayerRange()) return false;
		const filter = { range: asked.range, hidden: asked.hidden?.size ? asked.hidden : null };
		const call = ++this.filterCall;
		if (!this.meshes.length) {
			// not built yet (or being built again): the build applies it
			this.cellFilter = filter;
			this.wantedFilter = null;
			return true;
		}
		this.wantedFilter = filter;

		const caps = filter.range || filter.hidden ? await this.capsFor(filter) : [];
		if (this.disposed) return false;
		if (call !== this.filterCall) return true;

		this.cellFilter = filter;
		this.wantedFilter = null;
		this.replacedChunks = new Set(
			caps.map((cap) => cap.userData.replacesChunk).filter((chunk) => chunk !== undefined)
		);
		this.applyCellFilterTo(this.group, this.cellFilter);
		for (const cap of this.shownCaps) {
			this.group.remove(cap);
			// kept for later in the cache, but not on the GPU: its buffers go up again if it is shown again
			if (!caps.includes(cap)) cap.geometry.dispose();
		}
		this.shownCaps = caps;
		for (const cap of caps) this.group.add(cap);
		this.group.updateMatrixWorld(true);
		this.schematicRenderer.renderManager?.render?.();
		this.eventEmitter.emit("cellFilterChanged", {
			schematic: this,
			range: this.getLayerRange(),
			hiddenGroups: this.getHiddenGroups(),
		});
		return true;
	}

	/** Points the meshes under `root` at what `filter` shows, and shows the objects of the cells it shows only. */
	private applyCellFilterTo(root: THREE.Object3D, filter: CellFilter) {
		const all = !filter.range && !filter.hidden;
		root.traverse((o) => {
			if (o.userData.layerCap) return;
			// a chunk's connected-texture meshes made again for the filter stand in for the build's own
			const replaced =
				o.userData.connectedChunk !== undefined &&
				this.replacedChunks.has(o.userData.connectedChunk);
			if (o.userData.layerY !== undefined)
				o.visible = !replaced && shownBy(o.userData.layerY, o.userData.cellGroup ?? 0, filter);
			else if (o.userData.connectedChunk !== undefined) o.visible = !replaced;
			const geometry = (o as THREE.Mesh).geometry;
			const index = geometry?.userData?.layerIndex;
			if (index) applyLayerRange(geometry, index, all ? null : filter);
		});
	}

	/** The cap meshes of a filter, built once per filter and build. */
	private async capsFor(filter: CellFilter): Promise<THREE.Mesh[]> {
		const key = this.gridKey(filter);
		const caps = this.capsCache.get(key);
		if (caps) {
			// the most recently used last, so the oldest go first (rememberCaps)
			this.capsCache.delete(key);
			this.capsCache.set(key, caps);
			return caps;
		}
		// a call for the same filter while its caps are built waits for them
		let pending = this.capsPending.get(key);
		if (!pending) {
			pending = this.buildCapsFor(filter, key).finally(() => {
				if (this.capsPending.get(key) === pending) this.capsPending.delete(key);
			});
			this.capsPending.set(key, pending);
		}
		return pending;
	}

	/** Builds a filter's caps (capsFor) and keeps them under `key`. */
	private async buildCapsFor(filter: CellFilter, key: string): Promise<THREE.Mesh[]> {
		// meshed against this schematic's palette, whichever was built last (buildCaps says when it cannot)
		const version = this.gridVersion;
		const [blockCaps, connected] = await Promise.all([
			this.worldMeshBuilder.buildCaps(this.capPieces(filter), this),
			this.connectedCapsFor(filter),
		]);
		const caps = [...blockCaps, ...connected];
		if (this.disposed || version !== this.gridVersion) {
			// the blocks changed meanwhile (a rebuild, a chunk rebuild): these are of the old ones
			this.disposeCaps(caps);
			return [];
		}
		for (const cap of caps) cap.userData.layerCap = true;
		this.applyPropertiesToObjects(caps);
		this.rememberCaps(key, caps);
		return caps;
	}

	/**
	 * The cell grid as a filter sees it: its size, each cell's group, the cells it shows, and the hidden cells that
	 * can border a shown one (the layers just outside the range, and the cells of the hidden groups in it; those just
	 * outside it are in those layers). Null without a grid.
	 */
	private gridView(filter: CellFilter) {
		const grid = this.cellGrid,
			box = this.cellGridBox;
		if (this.disposed || !grid || !box) return null;
		const [W, H, L] = [0, 1, 2].map((a) => box.max[a] - box.min[a] + 1);
		const layer = W * L;
		// each cell's group as the meshes have it (cellGroupAt), read straight from the groups on the grid's box
		const data = this.cellGroupData;
		const aligned = data && sameBox(this.cellGroupBox, box) ? data : null;
		const groupOf = aligned
			? (i: number) => aligned[i]
			: data
				? (i: number) =>
						this.cellGroupAt(
							(i % W) + box.min[0],
							Math.floor(i / layer) + box.min[1],
							Math.floor((i % layer) / W) + box.min[2]
						)
				: () => 0;
		const lo = filter.range ? filter.range.minY - box.min[1] : 0,
			hi = filter.range ? filter.range.maxY - 1 - box.min[1] : H - 1;
		// the one test of what shows, as the meshes' runs, the objects and isCellShown take it (shownBy)
		const shown = (i: number) => shownBy(Math.floor(i / layer) + box.min[1], groupOf(i), filter);
		const forEachBorderHidden = (visit: (h: number) => void) => {
			for (const y of [lo - 1, hi + 1]) {
				if (!filter.range || y < 0 || y >= H) continue;
				for (let i = y * layer, end = i + layer; i < end; i++) visit(i);
			}
			if (!filter.hidden || !data) return; // without groups every cell is in group 0: all shown or all hidden
			if (aligned) {
				for (const g of filter.hidden) {
					for (const i of this.cellsOfGroup(g)) {
						const y = Math.floor(i / layer);
						if (y >= lo && y <= hi) visit(i);
					}
				}
				return;
			}
			// groups over another box: the cells of the range, one by one
			for (let y = Math.max(lo, 0); y <= Math.min(hi, H - 1); y++)
				for (let i = y * layer, end = i + layer; i < end; i++)
					if (filter.hidden.has(groupOf(i))) visit(i);
		};
		return { grid, box, W, H, L, layer, lo, hi, groupOf, shown, forEachBorderHidden };
	}

	/**
	 * The shown cells beside hidden ones, in chunk-sized pieces, each with the hidden cells beside its cells as its
	 * apron (what WorldMeshBuilder.buildCaps takes).
	 */
	private capPieces(filter: CellFilter) {
		const view = this.gridView(filter);
		if (!view) return [];
		const { grid, box, W, H, L, layer, groupOf, shown } = view;

		type Piece = {
			blocks: number[];
			apron: number[];
			groups: number[];
			origin: [number, number, number];
		};
		const pieces = new Map<number, Piece>();
		const taken = new Uint8Array(grid.length); // 1: a shown cell in its piece
		const pieceOf = (x: number, y: number, z: number) => {
			const cx = Math.floor(x / 16),
				cy = Math.floor(y / 16),
				cz = Math.floor(z / 16);
			const key = (cx * 4096 + cy) * 4096 + cz;
			let piece = pieces.get(key);
			if (!piece)
				pieces.set(
					key,
					(piece = { blocks: [], apron: [], groups: [], origin: [cx * 16, cy * 16, cz * 16] })
				);
			return piece;
		};
		const steps = [1, -1, layer, -layer, W, -W];
		const given: Piece[] = []; // the pieces the hidden cell visited is in the apron of already
		const visit = (h: number) => {
			if (!grid[h]) return;
			const hy = Math.floor(h / layer),
				hz = Math.floor((h % layer) / W),
				hx = h % W;
			given.length = 0;
			for (let d = 0; d < 6; d++) {
				// a neighbour inside the box
				if ((d === 0 && hx === W - 1) || (d === 1 && hx === 0)) continue;
				if ((d === 2 && hy === H - 1) || (d === 3 && hy === 0)) continue;
				if ((d === 4 && hz === L - 1) || (d === 5 && hz === 0)) continue;
				const n = h + steps[d];
				if (!grid[n] || !shown(n)) continue;
				const nx = n % W,
					ny = Math.floor(n / layer),
					nz = Math.floor((n % layer) / W);
				const [x, y, z] = [nx + box.min[0], ny + box.min[1], nz + box.min[2]];
				const piece = pieceOf(x, y, z);
				if (!taken[n]) {
					taken[n] = 1;
					piece.blocks.push(x, y, z, grid[n] - 1);
					piece.groups.push(groupOf(n));
				}
				// once a piece, however many of its cells it borders
				if (given.includes(piece)) continue;
				given.push(piece);
				piece.apron.push(hx + box.min[0], hy + box.min[1], hz + box.min[2], grid[h] - 1);
			}
		};
		view.forEachBorderHidden(visit);
		return [...pieces.values()]
			.filter((p) => p.blocks.length)
			.map((p) => ({
				blocks: Int32Array.from(p.blocks),
				apron: Int32Array.from(p.apron),
				cellGroups: Uint16Array.from(p.groups),
				origin: p.origin,
			}));
	}

	/**
	 * The connected-texture (Fusion) meshes a filter changes. Cubane culls such a block's faces against the same
	 * block beside it and picks its tiles from the blocks around it, reading the schematic, and the palette has no
	 * geometry of theirs for the worker's caps: a shown one beside a hidden cell is made again with the hidden cells
	 * as air. Each chunk with such a block gets its shown connected blocks made again for the filter (tagged
	 * replacesChunk), and the build's own connected meshes of that chunk are hidden while they show
	 * (applyCellFilterTo). Nothing to do, and nothing looked at, without connected blocks.
	 */
	private async connectedCapsFor(filter: CellFilter): Promise<THREE.Mesh[]> {
		const cells = this.connectedCells;
		const view = cells?.size ? this.gridView(filter) : null;
		if (!cells || !view) return [];
		const { grid, box, W, H, L, layer, shown } = view;
		// the chunks of the shown connected blocks with a hidden cell among the 26 around them
		const chunks = new Set<string>();
		view.forEachBorderHidden((h) => {
			if (!grid[h]) return;
			const hx = h % W,
				hy = Math.floor(h / layer),
				hz = Math.floor((h % layer) / W);
			for (let dy = -1; dy <= 1; dy++)
				for (let dz = -1; dz <= 1; dz++)
					for (let dx = -1; dx <= 1; dx++) {
						const x = hx + dx,
							y = hy + dy,
							z = hz + dz;
						if (x < 0 || y < 0 || z < 0 || x >= W || y >= H || z >= L) continue;
						const n = (y * L + z) * W + x;
						const chunk = cells.get(n);
						if (chunk !== undefined && shown(n)) chunks.add(chunk);
					}
		});
		if (chunks.size === 0) return [];
		const hiddenAt = (x: number, y: number, z: number) => {
			const i = cellIndex(box, x, y, z);
			return i >= 0 && grid[i] !== 0 && !shown(i);
		};
		// those chunks' shown connected blocks
		const byChunk = new Map<string, number[][]>();
		for (const [i, chunk] of cells) {
			if (!chunks.has(chunk) || !shown(i)) continue;
			const block = [
				(i % W) + box.min[0],
				Math.floor(i / layer) + box.min[1],
				Math.floor((i % layer) / W) + box.min[2],
				grid[i] - 1,
			];
			const list = byChunk.get(chunk);
			if (list) list.push(block);
			else byChunk.set(chunk, [block]);
		}
		const out: THREE.Mesh[] = [];
		for (const [key, blocks] of byChunk) {
			const meshes = await this.worldMeshBuilder.buildConnectedMeshes(blocks, this, hiddenAt);
			if (this.disposed) {
				// removed meanwhile: no more chunks are made (they read the freed schematic), and these go
				this.disposeCaps([...out, ...(meshes as THREE.Mesh[])]);
				return [];
			}
			for (const mesh of meshes) {
				mesh.userData.replacesChunk = key;
				out.push(mesh as THREE.Mesh);
			}
		}
		return out;
	}

	/** Lets go of caps for good: their geometry, and the material references connected ones hold. */
	private disposeCaps(caps: THREE.Mesh[]) {
		for (const cap of caps) {
			this.unfade(cap);
			disposeObject(cap);
		}
	}

	/** The cells (grid indices) of a group, from the cell groups, worked out once for all groups. */
	private cellsOfGroup(group: number): Int32Array {
		if (!this.groupCells) {
			const data = this.cellGroupData ?? new Uint16Array(0);
			// counting sort: each group's cells one after another in one array, a view per group
			const counts = new Uint32Array(65536);
			for (let i = 0; i < data.length; i++) counts[data[i]]++;
			const starts = new Uint32Array(65537);
			for (let g = 0; g < 65536; g++) starts[g + 1] = starts[g] + counts[g];
			const all = new Int32Array(data.length);
			const fill = starts.slice(0, 65536);
			for (let i = 0; i < data.length; i++) all[fill[data[i]]++] = i;
			const lists = new Map<number, Int32Array>();
			for (let g = 0; g < 65536; g++)
				if (counts[g]) lists.set(g, all.subarray(starts[g], starts[g + 1]));
			this.groupCells = lists;
		}
		return this.groupCells.get(group) ?? new Int32Array(0);
	}

	/** Every cell's block from the chunks a build meshes (air left out), in the grid capPieces reads. */
	private fillCellGrid(
		chunks: Array<{ blocks: Int32Array; chunk_x: number; chunk_y: number; chunk_z: number }>
	) {
		const box = schematicBox(this.schematicWrapper);
		const size = [0, 1, 2].reduce((n, a) => n * (box.max[a] - box.min[a] + 1), 1);
		const paletteSize = this.worldMeshBuilder.getPaletteSize?.(this) ?? 0;
		this.cellGrid = paletteSize < 0xffff ? new Uint16Array(size) : new Uint32Array(size);
		this.cellGridBox = box;
		this.gridVersion++;
		this.shownBoxCache = null;
		const air = this.worldMeshBuilder.airPaletteIndices(this);
		const connecting = this.worldMeshBuilder.connectingPaletteOf?.(this);
		const connected = connecting?.size ? new Map<number, string>() : null;
		this.connectedCells = connected;
		for (const { blocks, chunk_x, chunk_y, chunk_z } of chunks) {
			const chunk = `${chunk_x},${chunk_y},${chunk_z}`;
			for (let i = 0; i < blocks.length; i += 4) {
				if (air.has(blocks[i + 3])) continue;
				const c = cellIndex(box, blocks[i], blocks[i + 1], blocks[i + 2]);
				if (c < 0) continue;
				this.cellGrid[c] = blocks[i + 3] + 1;
				if (connected && connecting?.has(blocks[i + 3])) connected.set(c, chunk);
			}
		}
	}

	/** A chunk's cells in the grid again, after a chunk rebuild (`chunk`: its key, as its objects are tagged). */
	private writeCellGrid(offset: { x: number; y: number; z: number }, blocks: unknown, chunk = "") {
		const grid = this.cellGrid,
			box = this.cellGridBox;
		if (!grid || !box) return;
		const { chunkWidth, chunkHeight, chunkLength } = this.chunkDimensions;
		const connected = this.connectedCells;
		for (let y = offset.y; y < offset.y + chunkHeight; y++)
			for (let z = offset.z; z < offset.z + chunkLength; z++)
				for (let x = offset.x; x < offset.x + chunkWidth; x++) {
					const c = cellIndex(box, x, y, z);
					if (c < 0) continue;
					grid[c] = 0;
					connected?.delete(c);
				}
		const air = this.worldMeshBuilder.airPaletteIndices(this);
		const connecting = this.worldMeshBuilder.connectingPaletteOf?.(this);
		const put = (x: number, y: number, z: number, p: number) => {
			if (air.has(p)) return;
			const c = cellIndex(box, x, y, z);
			if (c < 0) return;
			grid[c] = p + 1;
			if (connecting?.has(p)) (this.connectedCells ??= new Map()).set(c, chunk);
		};
		// [x, y, z, paletteIndex] flat, or one array a block
		if (ArrayBuffer.isView(blocks)) {
			const flat = blocks as unknown as ArrayLike<number>;
			for (let i = 0; i + 3 < flat.length; i += 4)
				put(flat[i], flat[i + 1], flat[i + 2], flat[i + 3]);
		} else if (Array.isArray(blocks)) {
			for (const b of blocks as ArrayLike<number>[]) put(b[0], b[1], b[2], b[3]);
		}
		this.gridVersion++;
		this.shownBoxCache = null;
	}

	/** The box (schematic coordinates, cells' edges) of the cells shown, or null when none is or there is no grid. */
	private shownCellBox(): THREE.Box3 | null {
		const key = this.gridKey();
		if (this.shownBoxCache?.key === key) return this.shownBoxCache.box;
		const view = this.gridView(this.cellFilter);
		if (!view) return null;
		const { grid, box, W, H, L, shown } = view;
		const min = [Infinity, Infinity, Infinity],
			max = [-Infinity, -Infinity, -Infinity];
		for (let y = Math.max(view.lo, 0); y <= Math.min(view.hi, H - 1); y++)
			for (let z = 0; z < L; z++)
				for (let x = 0, i = (y * L + z) * W; x < W; x++, i++) {
					if (!grid[i] || !shown(i)) continue;
					if (x < min[0]) min[0] = x;
					if (x > max[0]) max[0] = x;
					if (y < min[1]) min[1] = y;
					if (y > max[1]) max[1] = y;
					if (z < min[2]) min[2] = z;
					if (z > max[2]) max[2] = z;
				}
		const result =
			min[0] === Infinity
				? null
				: new THREE.Box3(
						new THREE.Vector3(
							min[0] + box.min[0] - 0.5,
							min[1] + box.min[1] - 0.5,
							min[2] + box.min[2] - 0.5
						),
						new THREE.Vector3(
							max[0] + box.min[0] + 0.5,
							max[1] + box.min[1] + 0.5,
							max[2] + box.min[2] + 0.5
						)
					);
		this.shownBoxCache = { key, box: result };
		return result;
	}

	/**
	 * Keeps a filter's caps for later, the least recently used dropped past CAPS_CACHE_BYTES of arrays or
	 * CAPS_CACHE_COUNT filters (and any of an older cell grid); those shown stay.
	 */
	private rememberCaps(key: string, caps: THREE.Mesh[]) {
		const version = `${this.gridVersion}|`;
		this.capsCache.set(key, caps);
		let bytes = 0;
		for (const kept of this.capsCache.values()) bytes += capsBytes(kept);
		for (const [k, old] of this.capsCache) {
			if (k === key || old.some((c) => this.shownCaps.includes(c))) continue;
			const over =
				bytes > SchematicObject.CAPS_CACHE_BYTES ||
				this.capsCache.size > SchematicObject.CAPS_CACHE_COUNT;
			if (!over && k.startsWith(version)) continue;
			this.disposeCaps(old);
			this.capsCache.delete(k);
			bytes -= capsBytes(old);
		}
	}

	// How much of the caps built for other filters is kept for going back to them (rememberCaps): the arrays of a
	// large build's caps run to megabytes a filter, and a few dozen layers stepped through kept far more than they
	// were worth. The caps not shown are kept off the GPU.
	static CAPS_CACHE_BYTES = 32 * 1024 * 1024;
	static CAPS_CACHE_COUNT = 16;

	/** Drops every cap (a rebuild makes new meshes; the old caps are of the old blocks). */
	private clearCaps() {
		for (const cap of this.shownCaps) this.group.remove(cap);
		this.shownCaps = [];
		for (const caps of this.capsCache.values()) this.disposeCaps(caps);
		this.replacedChunks = new Set();
		this.capsCache.clear();
	}

	// A chunk's objects go: its own (a chunk mesh), and in a batched build what the batches hold of it (its
	// connected-texture meshes, and its triangles in the batched meshes, which span many chunks: cut out in place).
	private removeChunkObjects(chunkX: number, chunkY: number, chunkZ: number) {
		const key = `${chunkX},${chunkY},${chunkZ}`;
		const oldChunkObjects = this.getChunkObjectsAt(chunkX, chunkY, chunkZ);
		if (oldChunkObjects) {
			oldChunkObjects.forEach((obj) => {
				// its geometry and own materials disposed, shared ones released (MemoryLeakFix.disposeObject)
				this.unfade(obj);
				disposeObject(obj);
			});
			this.chunkMeshes.delete(key);
		}
		const batched = this.chunkMeshes.get("batched");
		if (!batched) return;
		const gone = new Set<THREE.Object3D>();
		for (const obj of batched) {
			if (obj.userData.connectedChunk === key) {
				this.unfade(obj);
				disposeObject(obj);
				gone.add(obj);
			} else if (obj instanceof THREE.Mesh) {
				cutChunkFromBatch(obj.geometry, key);
			}
		}
		if (gone.size) {
			this.chunkMeshes.set(
				"batched",
				batched.filter((obj) => !gone.has(obj))
			);
			this.meshes = this.meshes.filter((obj) => !gone.has(obj));
		}
		this.schematicRenderer.invalidate?.();
	}

	public containsPosition(position: THREE.Vector3): boolean {
		// Calculate the bounds of the schematic
		const dimensions = this.getDimensions();
		const min = this.position.clone();
		const max = min
			.clone()
			.add(new THREE.Vector3(dimensions[0], dimensions[1], dimensions[2]).multiply(this.scale));

		return (
			position.x >= min.x &&
			position.x <= max.x &&
			position.y >= min.y &&
			position.y <= max.y &&
			position.z >= min.z &&
			position.z <= max.z
		);
	}

	public getSchematicCenter(): THREE.Vector3 {
		const box = this.getTightWorldBox();
		return box.getCenter(new THREE.Vector3());
	}

	/**
	 * Get the world-space bounding box of the schematic's actual block content
	 */
	public getTightWorldBox(): THREE.Box3 {
		// with some cells hidden, the box of those shown
		const shown = this.filtering() ? this.shownCellBox() : null;
		if (shown) {
			this.group.updateMatrixWorld(true);
			return shown.clone().applyMatrix4(this.group.matrixWorld);
		}
		const tightMin = this.getTightBoundsMin();
		const tightDimensions = this.getTightDimensions();
		const hasTightBounds =
			tightMin !== null &&
			tightDimensions[0] > 0 &&
			tightDimensions[1] > 0 &&
			tightDimensions[2] > 0;

		// the cells' edges: a block's geometry is centred on its cell (x - 0.5 to x + 0.5), as shownCellBox frames it
		const box = new THREE.Box3();
		if (hasTightBounds) {
			box.min.set(tightMin[0], tightMin[1], tightMin[2]);
			box.max.set(
				tightMin[0] + tightDimensions[0],
				tightMin[1] + tightDimensions[1],
				tightMin[2] + tightDimensions[2]
			);
		} else {
			const dims = this.getDimensions();
			box.min.set(0, 0, 0);
			box.max.set(dims[0], dims[1], dims[2]);
		}
		box.translate(new THREE.Vector3(-0.5, -0.5, -0.5));

		// Apply the group's transform
		this.group.updateMatrixWorld(true);
		box.applyMatrix4(this.group.matrixWorld);

		return box;
	}

	public centerInScene() {
		const averagePosition = this.getSchematicCenter();
		const newSchematicPosition = new THREE.Vector3(
			this.position.x - averagePosition.x,
			this.position.y - averagePosition.y,
			this.position.z - averagePosition.z
		);
		this.position.copy(newSchematicPosition);
		this.updateTransform();
	}

	public centerInScenePlane() {
		const averagePosition = this.getSchematicCenter();
		const newSchematicPosition = new THREE.Vector3(
			this.position.x - averagePosition.x,
			0,
			this.position.z - averagePosition.z
		);
		this.position.copy(newSchematicPosition);
		this.updateTransform();
	}

	public setPosition(position: THREE.Vector3 | number[]): void {
		if (Array.isArray(position)) {
			this.position = new THREE.Vector3(position[0], position[1], position[2]);
			this.updateTransform();
			return;
		}
		this.position = position;
		this.updateTransform();
	}

	public setRotation(rotation: THREE.Euler | number[]): void {
		if (Array.isArray(rotation)) {
			this.rotation = new THREE.Euler(rotation[0], rotation[1], rotation[2]);
			return;
		}
		this.rotation = rotation;
	}

	public setScale(scale: THREE.Vector3 | number[]): void {
		if (Array.isArray(scale)) {
			this.scale = new THREE.Vector3(scale[0], scale[1], scale[2]);
			return;
		}
		this.scale = scale;
	}

	public getWorldPosition(): THREE.Vector3 {
		return this.group.getWorldPosition(new THREE.Vector3());
	}

	public getBoundingBox(): [number[], number[]] {
		// Get the actual world-space bounds after centering
		this.group.updateMatrixWorld();
		const box = new THREE.Box3().setFromObject(this.group);

		const min = [box.min.x, box.min.y, box.min.z];
		const max = [box.max.x, box.max.y, box.max.z];

		return [min, max];
	}

	// Optimized getAllBlocks method with optional filtering
	public getAllBlocks(filter?: (block: BlockData) => boolean): BlockData[] {
		const dimensions = this.getDimensions();
		const blocks: BlockData[] = [];

		for (let x = 0; x < dimensions[0]; x++) {
			for (let y = 0; y < dimensions[1]; y++) {
				for (let z = 0; z < dimensions[2]; z++) {
					const blockName = this.schematicWrapper.get_block(x, y, z);
					if (blockName && blockName !== "minecraft:air") {
						// Get block properties using the correct method name
						let properties = {};
						try {
							const blockWithProps = this.schematicWrapper.get_block_with_properties?.(x, y, z);
							if (blockWithProps) {
								// Extract properties from BlockStateWrapper if available
								properties = blockWithProps.properties || {};
							}
						} catch (error) {
							// Fallback to empty properties if method doesn't exist or fails
							properties = {};
						}

						const blockData: BlockData = {
							x,
							y,
							z,
							name: blockName,
							properties: properties,
							chunk_x: Math.floor(x / this.chunkDimensions.chunkWidth),
							chunk_y: Math.floor(y / this.chunkDimensions.chunkHeight),
							chunk_z: Math.floor(z / this.chunkDimensions.chunkLength),
							// one string per state, its properties sorted, as the caches keyed by block string take it
							stateKey: formatBlockString(blockName, properties),
						};

						// Apply filter if provided
						if (!filter || filter(blockData)) {
							blocks.push(blockData);
						}
					}
				}
			}
		}

		return blocks;
	}

	/**
	 * Creates an object with properties and methods for easily manipulating rendering bounds
	 * Useful for console manipulation and testing
	 * @returns Settings object with properties and methods
	 */
	public createBoundsControls(): any {
		const dimensions = this.getDimensions();
		const [width, height, depth] = dimensions;

		const settings = {
			minX: this.renderingBounds.min.x,
			maxX: this.renderingBounds.max.x,
			minY: this.renderingBounds.min.y,
			maxY: this.renderingBounds.max.y,
			minZ: this.renderingBounds.min.z,
			maxZ: this.renderingBounds.max.z,

			// Apply a specific axis
			applyX: () => {
				const min = this.renderingBounds.min.clone();
				const max = this.renderingBounds.max.clone();
				min.x = settings.minX;
				max.x = settings.maxX;
				this.setRenderingBounds(min, max);
				return `X axis bounds set to [${settings.minX}, ${settings.maxX}]`;
			},

			applyY: () => {
				const min = this.renderingBounds.min.clone();
				const max = this.renderingBounds.max.clone();
				min.y = settings.minY;
				max.y = settings.maxY;
				this.setRenderingBounds(min, max);
				return `Y axis bounds set to [${settings.minY}, ${settings.maxY}]`;
			},

			applyZ: () => {
				const min = this.renderingBounds.min.clone();
				const max = this.renderingBounds.max.clone();
				min.z = settings.minZ;
				max.z = settings.maxZ;
				this.setRenderingBounds(min, max);
				return `Z axis bounds set to [${settings.minZ}, ${settings.maxZ}]`;
			},

			// Apply all axes
			applyAll: () => {
				this.setRenderingBounds(
					[settings.minX, settings.minY, settings.minZ],
					[settings.maxX, settings.maxY, settings.maxZ]
				);
				return `All bounds set to min:[${settings.minX}, ${settings.minY}, ${settings.minZ}], max:[${settings.maxX}, ${settings.maxY}, ${settings.maxZ}]`;
			},

			// Reset to full dimensions
			reset: () => {
				this.resetRenderingBounds();
				// Update local settings to match
				settings.minX = 0;
				settings.maxX = width;
				settings.minY = 0;
				settings.maxY = height;
				settings.minZ = 0;
				settings.maxZ = depth;
				return `Reset rendering bounds to full dimensions: [${width}, ${height}, ${depth}]`;
			},

			// Toggle helper visibility
			toggleHelper: (visible = true) => {
				this.showRenderingBoundsHelper(visible);
				return `Rendering bounds helper ${visible ? "shown" : "hidden"}`;
			},

			// Get current bounds
			getCurrentBounds: () => {
				return {
					min: this.renderingBounds.min.toArray(),
					max: this.renderingBounds.max.toArray(),
				};
			},

			// Sync from current bounds
			syncFromCurrent: () => {
				settings.minX = this.renderingBounds.min.x;
				settings.maxX = this.renderingBounds.max.x;
				settings.minY = this.renderingBounds.min.y;
				settings.maxY = this.renderingBounds.max.y;
				settings.minZ = this.renderingBounds.min.z;
				settings.maxZ = this.renderingBounds.max.z;
				return "Settings synchronized with current bounds";
			},

			// Slice from one side (useful for slider UI)
			sliceX: (value: number) => {
				settings.maxX = value;
				return settings.applyX();
			},

			sliceY: (value: number) => {
				settings.maxY = value;
				return settings.applyY();
			},

			sliceZ: (value: number) => {
				settings.maxZ = value;
				return settings.applyZ();
			},
		};

		return settings;
	}
}

/** A cell's index in a box's grid (Sponge order: x fastest, then z, then y), or -1 outside it. */
function cellIndex(box: CellBox, x: number, y: number, z: number): number {
	const W = box.max[0] - box.min[0] + 1,
		L = box.max[2] - box.min[2] + 1;
	const lx = x - box.min[0],
		ly = y - box.min[1],
		lz = z - box.min[2];
	if (lx < 0 || ly < 0 || lz < 0 || lx >= W || lz >= L || y > box.max[1]) return -1;
	return (ly * L + lz) * W + lx;
}

/** The bytes of some caps' arrays (their attributes and indices). */
function capsBytes(caps: THREE.Mesh[]): number {
	let bytes = 0;
	for (const cap of caps) {
		const geometry = cap.geometry;
		for (const attribute of Object.values(geometry.attributes))
			bytes += (attribute as THREE.BufferAttribute).array?.byteLength ?? 0;
		bytes += geometry.index?.array.byteLength ?? 0;
	}
	return bytes;
}

const sameBox = (a: CellBox | null, b: CellBox | null) =>
	!!a && !!b && a.min.every((v, i) => v === b.min[i]) && a.max.every((v, i) => v === b.max[i]);
