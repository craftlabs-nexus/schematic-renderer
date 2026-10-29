//! High-performance WASM mesh builder for voxel geometry merging
//! 
//! This module provides Rust implementations of geometry merging and face culling
//! that are significantly faster than the JavaScript equivalents.
//!
//! Includes greedy meshing to merge coplanar faces into larger quads.

use wasm_bindgen::prelude::*;
use js_sys::{Float32Array, Int8Array, Int16Array, Int32Array, Uint16Array, Uint32Array, Array, Object, Reflect};
use std::collections::HashMap;

// Constants matching the JavaScript implementation
const POSITION_SCALE: f32 = 1024.0;
const NORMAL_SCALE: f32 = 127.0;

/// Face direction for greedy meshing
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum FaceDir {
    PosX = 0, // East  (+X)
    NegX = 1, // West  (-X)
    PosY = 2, // Up    (+Y)
    NegY = 3, // Down  (-Y)
    PosZ = 4, // South (+Z)
    NegZ = 5, // North (-Z)
}

impl FaceDir {
    fn normal(&self) -> (f32, f32, f32) {
        match self {
            FaceDir::PosX => (1.0, 0.0, 0.0),
            FaceDir::NegX => (-1.0, 0.0, 0.0),
            FaceDir::PosY => (0.0, 1.0, 0.0),
            FaceDir::NegY => (0.0, -1.0, 0.0),
            FaceDir::PosZ => (0.0, 0.0, 1.0),
            FaceDir::NegZ => (0.0, 0.0, -1.0),
        }
    }
    
    fn delta(&self) -> (i32, i32, i32) {
        match self {
            FaceDir::PosX => (1, 0, 0),
            FaceDir::NegX => (-1, 0, 0),
            FaceDir::PosY => (0, 1, 0),
            FaceDir::NegY => (0, -1, 0),
            FaceDir::PosZ => (0, 0, 1),
            FaceDir::NegZ => (0, 0, -1),
        }
    }
    
    /// Get the face index for occlusion flags (matches the existing convention)
    fn occlusion_face_index(&self) -> u32 {
        match self {
            FaceDir::PosX => 1, // East
            FaceDir::NegX => 0, // West
            FaceDir::PosY => 3, // Up
            FaceDir::NegY => 2, // Down
            FaceDir::PosZ => 5, // South
            FaceDir::NegZ => 4, // North
        }
    }
    
    /// Get the opposite face index for checking neighbor occlusion
    fn opposite_occlusion_index(&self) -> u32 {
        match self {
            FaceDir::PosX => 0, // West face of neighbor
            FaceDir::NegX => 1, // East face of neighbor
            FaceDir::PosY => 2, // Down face of neighbor
            FaceDir::NegY => 3, // Up face of neighbor
            FaceDir::PosZ => 4, // North face of neighbor
            FaceDir::NegZ => 5, // South face of neighbor
        }
    }
}

/// A face to be potentially merged in greedy meshing
#[derive(Clone)]
struct GreedyFace {
    // Block position
    bx: i32,
    by: i32,
    bz: i32,
    // Material index for grouping
    material_index: u32,
    // UV region from the original texture (for tiling)
    uv_min: (f32, f32),
    uv_max: (f32, f32),
}

/// A merged quad from greedy meshing
struct MergedQuad {
    // Starting position
    x: i32,
    y: i32,
    z: i32,
    // Size in the two axes perpendicular to normal
    width: i32,
    height: i32,
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
    
    #[wasm_bindgen(js_namespace = console)]
    fn error(s: &str);
}

/// Initialize the WASM module with better panic messages
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

/// Palette geometry entry - stores precomputed geometry for a block type
#[wasm_bindgen]
pub struct PaletteEntry {
    index: u32,
    occlusion_flags: u32,
    // Geometry data stored as flat arrays
    positions: Vec<f32>,      // [x, y, z, x, y, z, ...]
    normals: Vec<f32>,        // [nx, ny, nz, ...]
    uvs: Vec<f32>,            // [u, v, u, v, ...]
    indices: Vec<u32>,        // Triangle indices
    material_index: u32,
    vertex_count: u32,
}

#[wasm_bindgen]
impl PaletteEntry {
    #[wasm_bindgen(constructor)]
    pub fn new(
        index: u32,
        occlusion_flags: u32,
        positions: Float32Array,
        normals: Float32Array,
        uvs: Float32Array,
        indices: Uint32Array,
        material_index: u32,
    ) -> PaletteEntry {
        PaletteEntry {
            index,
            occlusion_flags,
            positions: positions.to_vec(),
            normals: normals.to_vec(),
            uvs: uvs.to_vec(),
            indices: indices.to_vec(),
            material_index,
            vertex_count: (positions.length() / 3) as u32,
        }
    }
}

/// Main mesh builder that holds palette data and performs chunk building
#[wasm_bindgen]
pub struct MeshBuilder {
    palette: Vec<Option<PaletteEntryData>>,
    // Accumulators for batch mode - one per category
    accumulators: std::collections::HashMap<String, GeometryAccumulator>,
    batch_mode: bool,
}

/// Internal palette entry data (not exposed to JS)
struct PaletteEntryData {
    occlusion_flags: u32,
    geometries: Vec<GeometryData>,
    category: String,
    /// who its full sides hide: SOLID_CULL_KEY when they are opaque, else its block id (src/workers/faceCulling.ts)
    cull_key: String,
    /// the fluid it holds: FLUID_NONE, FLUID_WATER (water and waterlogged blocks) or FLUID_LAVA
    fluid: u32,
}

struct GeometryData {
    positions: Vec<f32>,
    normals: Vec<f32>,
    uvs: Vec<f32>,
    indices: Vec<u32>,
    material_index: u32,
    /// the fluid this geometry is (a waterlogged block's water), FLUID_NONE for the block's own shape
    fluid: u32,
}

const SOLID_CULL_KEY: &str = "solid";
const FLUID_NONE: u32 = 0;

/// Whether a face on the boundary of a block keyed `self_key`, facing `neighbour`, is hidden by it, as the game
/// decides: `side` is the neighbour's side toward the face (its occlusion bit), `face_fluid` whether the face is the
/// block's fluid. An opaque full side hides any face; a fluid's face is hidden by the same fluid; a see-through full
/// side hides only the same block's face. src/workers/faceCulling.ts (faceHiddenBy) decides the same.
fn face_hidden_by(self_key: &str, face_fluid: u32, neighbour: &PaletteEntryData, side: u32) -> bool {
    let covers = (neighbour.occlusion_flags & (1 << side)) != 0;
    if covers && neighbour.cull_key == SOLID_CULL_KEY {
        return true;
    }
    if face_fluid != FLUID_NONE {
        return neighbour.fluid == face_fluid;
    }
    covers && neighbour.cull_key == self_key
}

/// Accumulator for batch mode - collects geometry across multiple chunks
struct GeometryAccumulator {
    positions: Vec<i16>,
    normals: Vec<i8>,
    uvs: Vec<f32>,
    indices: Vec<u32>,
    groups: Vec<(u32, u32, u32)>, // (start, count, materialIndex)
    vertex_count: u32,
    index_count: u32,
}

#[wasm_bindgen]
impl MeshBuilder {
    #[wasm_bindgen(constructor)]
    pub fn new() -> MeshBuilder {
        MeshBuilder {
            palette: Vec::new(),
            accumulators: std::collections::HashMap::new(),
            batch_mode: false,
        }
    }
    
    /// Enable batch mode - chunks will be accumulated instead of returned immediately
    #[wasm_bindgen]
    pub fn start_batch(&mut self) {
        self.batch_mode = true;
        self.accumulators.clear();
    }
    
    /// Disable batch mode and return all accumulated geometry
    #[wasm_bindgen]
    pub fn finish_batch(&mut self) -> Result<JsValue, JsValue> {
        self.batch_mode = false;
        
        let results = Array::new();
        
        for (category, acc) in &self.accumulators {
            if acc.vertex_count == 0 {
                continue;
            }
            
            // Create JS typed arrays
            let positions_arr = Int16Array::new_with_length(acc.positions.len() as u32);
            positions_arr.copy_from(&acc.positions);
            
            let normals_arr = Int8Array::new_with_length(acc.normals.len() as u32);
            normals_arr.copy_from(&acc.normals);
            
            let uvs_arr = Float32Array::new_with_length(acc.uvs.len() as u32);
            uvs_arr.copy_from(&acc.uvs);
            
            // Use 32-bit indices for large batches
            let indices_arr: JsValue = if acc.vertex_count > 65535 {
                let arr = Uint32Array::new_with_length(acc.indices.len() as u32);
                arr.copy_from(&acc.indices);
                arr.into()
            } else {
                let arr = Uint16Array::new_with_length(acc.indices.len() as u32);
                let indices_u16: Vec<u16> = acc.indices.iter().map(|&x| x as u16).collect();
                arr.copy_from(&indices_u16);
                arr.into()
            };
            
            // Create groups array
            let groups_arr = Array::new();
            for (start, count, mat_index) in &acc.groups {
                let group_obj = Object::new();
                Reflect::set(&group_obj, &"start".into(), &JsValue::from(*start)).ok();
                Reflect::set(&group_obj, &"count".into(), &JsValue::from(*count)).ok();
                Reflect::set(&group_obj, &"materialIndex".into(), &JsValue::from(*mat_index)).ok();
                groups_arr.push(&group_obj);
            }
            
            let result = Object::new();
            Reflect::set(&result, &"category".into(), &JsValue::from_str(category)).ok();
            Reflect::set(&result, &"positions".into(), &positions_arr).ok();
            Reflect::set(&result, &"normals".into(), &normals_arr).ok();
            Reflect::set(&result, &"uvs".into(), &uvs_arr).ok();
            Reflect::set(&result, &"indices".into(), &indices_arr).ok();
            Reflect::set(&result, &"groups".into(), &groups_arr).ok();
            Reflect::set(&result, &"vertexCount".into(), &JsValue::from(acc.vertex_count)).ok();
            
            results.push(&result);
        }
        
        self.accumulators.clear();
        
        let output = Object::new();
        Reflect::set(&output, &"meshes".into(), &results).ok();
        Reflect::set(&output, &"origin".into(), &Array::of3(&0.into(), &0.into(), &0.into())).ok();
        
        Ok(output.into())
    }
    
    /// Clear accumulators without returning data
    #[wasm_bindgen]
    pub fn clear_batch(&mut self) {
        self.accumulators.clear();
        self.batch_mode = false;
    }
    
    /// Get batch mode status
    #[wasm_bindgen]
    pub fn is_batch_mode(&self) -> bool {
        self.batch_mode
    }

    /// Update palette with geometry data from JavaScript
    /// palette_data is an array of objects with: { index, occlusionFlags, category, cullKey, fluid, geometries: [...] }
    /// (each geometry: { positions, normals, uvs, indices, materialIndex, fluid })
    #[wasm_bindgen]
    pub fn update_palette(&mut self, palette_data: &Array) {
        // Clear and resize palette
        self.palette.clear();
        
        for i in 0..palette_data.length() {
            let item = palette_data.get(i);
            if let Ok(obj) = item.dyn_into::<Object>() {
                let index = Reflect::get(&obj, &"index".into())
                    .ok()
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0) as usize;
                
                let occlusion_flags = Reflect::get(&obj, &"occlusionFlags".into())
                    .ok()
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0) as u32;
                
                let category = Reflect::get(&obj, &"category".into())
                    .ok()
                    .and_then(|v| v.as_string())
                    .unwrap_or_else(|| "solid".to_string());

                let cull_key = Reflect::get(&obj, &"cullKey".into())
                    .ok()
                    .and_then(|v| v.as_string())
                    .unwrap_or_else(|| category.clone());

                let fluid = Reflect::get(&obj, &"fluid".into())
                    .ok()
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0) as u32;

                // Ensure palette is large enough
                while self.palette.len() <= index {
                    self.palette.push(None);
                }
                
                // Parse geometries array
                let mut geometries = Vec::new();
                if let Ok(geoms_val) = Reflect::get(&obj, &"geometries".into()) {
                    if let Ok(geoms_arr) = geoms_val.dyn_into::<Array>() {
                        for j in 0..geoms_arr.length() {
                            if let Ok(geom_obj) = geoms_arr.get(j).dyn_into::<Object>() {
                                let positions = Self::get_float32_array(&geom_obj, "positions");
                                let normals = Self::get_float32_array(&geom_obj, "normals");
                                let uvs = Self::get_float32_array(&geom_obj, "uvs");
                                let indices = Self::get_uint_array(&geom_obj, "indices");
                                let material_index = Reflect::get(&geom_obj, &"materialIndex".into())
                                    .ok()
                                    .and_then(|v| v.as_f64())
                                    .unwrap_or(0.0) as u32;
                                let geom_fluid = Reflect::get(&geom_obj, &"fluid".into())
                                    .ok()
                                    .and_then(|v| v.as_f64())
                                    .unwrap_or(0.0) as u32;

                                geometries.push(GeometryData {
                                    positions,
                                    normals,
                                    uvs,
                                    indices,
                                    material_index,
                                    fluid: geom_fluid,
                                });
                            }
                        }
                    }
                }
                
                self.palette[index] = Some(PaletteEntryData {
                    occlusion_flags,
                    geometries,
                    category,
                    cull_key,
                    fluid,
                });
            }
        }
    }

    fn get_float32_array(obj: &Object, key: &str) -> Vec<f32> {
        Reflect::get(obj, &key.into())
            .ok()
            .and_then(|v| v.dyn_into::<Float32Array>().ok())
            .map(|arr| arr.to_vec())
            .unwrap_or_default()
    }

    fn get_uint_array(obj: &Object, key: &str) -> Vec<u32> {
        if let Ok(val) = Reflect::get(obj, &key.into()) {
            // Try Uint32Array first
            if let Ok(arr) = val.clone().dyn_into::<Uint32Array>() {
                return arr.to_vec();
            }
            // Fall back to Uint16Array
            if let Ok(arr) = val.dyn_into::<Uint16Array>() {
                return arr.to_vec().into_iter().map(|x| x as u32).collect();
            }
        }
        Vec::new()
    }

    /// Build a chunk mesh from block data
    /// 
    /// blocks: Int32Array with [x, y, z, paletteIndex] for each block
    /// chunk_origin: [originX, originY, originZ]
    /// 
    /// Returns a JavaScript object with the merged mesh data
    ///
    /// `cell_groups` gives each block a group (one per block, or empty for all in group 0): a caller's label for
    /// cells it may hide together, such as a part of the build. Each mesh's triangles are ordered by material, then
    /// layer (the block's y), then group, and `layers` lists the runs as flat [layer, group, start, count, ...]
    /// index ranges, so the layers and groups shown are a few index ranges per material (a viewer shows some of
    /// them without meshing again). `groups` cover everything, as before.
    #[wasm_bindgen]
    pub fn build_chunk(
        &self,
        blocks: &Int32Array,
        origin_x: i32,
        origin_y: i32,
        origin_z: i32,
        apron_blocks: &Int32Array,
        cell_groups: &Uint16Array,
    ) -> Result<JsValue, JsValue> {
        self.build_chunk_mode(blocks, origin_x, origin_y, origin_z, apron_blocks, cell_groups, false)
    }

    /// The faces of `blocks` that build_chunk culls because of a block in the apron, and only those: when a
    /// viewer hides some cells (other layers, other groups), the faces of the cells it shows that the hidden
    /// ones covered. `blocks` are shown cells beside hidden ones; the apron is the hidden cells beside them. A
    /// face a block of `blocks` covers stays culled. Laid out as build_chunk's.
    #[wasm_bindgen]
    pub fn build_caps(
        &self,
        blocks: &Int32Array,
        origin_x: i32,
        origin_y: i32,
        origin_z: i32,
        apron_blocks: &Int32Array,
        cell_groups: &Uint16Array,
    ) -> Result<JsValue, JsValue> {
        self.build_chunk_mode(blocks, origin_x, origin_y, origin_z, apron_blocks, cell_groups, true)
    }

    /// build_chunk, or build_caps (`caps`).
    #[allow(clippy::too_many_arguments)]
    fn build_chunk_mode(
        &self,
        blocks: &Int32Array,
        origin_x: i32,
        origin_y: i32,
        origin_z: i32,
        apron_blocks: &Int32Array,
        cell_groups: &Uint16Array,
        caps: bool,
    ) -> Result<JsValue, JsValue> {
        let blocks_vec = blocks.to_vec();
        let groups_vec = cell_groups.to_vec();
        let block_count = blocks_vec.len() / 4;
        
        if block_count == 0 {
            return Ok(Self::create_empty_result());
        }
        
        // Calculate bounds
        let (min_x, min_y, min_z, max_x, max_y, max_z) = self.calculate_bounds(&blocks_vec);
        
        let size_x = (max_x - min_x + 1) as usize;
        let size_y = (max_y - min_y + 1) as usize;
        let size_z = (max_z - min_z + 1) as usize;
        
        // Build voxel map with padding
        let pad = 1usize;
        let stride_y = size_x + 2 * pad;
        let stride_z = (size_x + 2 * pad) * (size_y + 2 * pad);
        let map_size = stride_z * (size_z + 2 * pad);
        
        let mut voxel_map = vec![0i32; map_size];
        
        // Helper to get index in voxel map
        let get_index = |x: i32, y: i32, z: i32| -> usize {
            let lx = (x - min_x) as usize + pad;
            let ly = (y - min_y) as usize + pad;
            let lz = (z - min_z) as usize + pad;
            lx + ly * stride_y + lz * stride_z
        };
        
        // Populate voxel map
        for i in 0..block_count {
            let base = i * 4;
            let x = blocks_vec[base];
            let y = blocks_vec[base + 1];
            let z = blocks_vec[base + 2];
            let palette_idx = blocks_vec[base + 3];
            voxel_map[get_index(x, y, z)] = palette_idx + 1; // +1 so 0 means empty
        }

        // the apron's cells marked (negative) for caps, which keep only the faces they cull
        Self::populate_apron(
            apron_blocks, &mut voxel_map, stride_y, stride_z, pad,
            min_x, min_y, min_z, max_x, max_y, max_z, caps,
        );

        // Group blocks by category and palette index
        let mut category_batches: std::collections::HashMap<String, std::collections::HashMap<u32, Vec<usize>>> = 
            std::collections::HashMap::new();
        
        for i in 0..block_count {
            let base = i * 4;
            let palette_idx = blocks_vec[base + 3] as u32;
            
            if let Some(Some(palette_entry)) = self.palette.get(palette_idx as usize) {
                let category = &palette_entry.category;
                
                category_batches
                    .entry(category.clone())
                    .or_default()
                    .entry(palette_idx)
                    .or_default()
                    .push(i);
            }
        }
        
        // Process each category and merge geometries
        let results = Array::new();
        
        for (category, palette_map) in category_batches {
            let merged = self.merge_category_geometries(
                &category,
                &palette_map,
                &blocks_vec,
                &voxel_map,
                &get_index,
                origin_x,
                origin_y,
                origin_z,
                min_x,
                min_y,
                min_z,
                &groups_vec,
                caps,
            );

            if let Some(mesh_data) = merged {
                results.push(&mesh_data);
            }
        }
        
        // Create result object
        let result = Object::new();
        Reflect::set(&result, &"meshes".into(), &results)?;
        
        let origin = Array::new();
        origin.push(&JsValue::from(origin_x));
        origin.push(&JsValue::from(origin_y));
        origin.push(&JsValue::from(origin_z));
        Reflect::set(&result, &"origin".into(), &origin)?;
        
        Ok(result.into())
    }

    /// Write neighbouring chunks' boundary blocks (flat [x, y, z, palette_idx, …],
    /// world coords) into the 1-voxel apron of the voxel map so faces on a chunk
    /// seam cull against the adjacent chunk. These are used for occlusion lookup
    /// only — they are never meshed (the build loops iterate real blocks). Cells
    /// outside the padded volume are skipped, and real blocks are never overwritten.
    #[allow(clippy::too_many_arguments)]
    fn populate_apron(
        apron_blocks: &Int32Array,
        voxel_map: &mut [i32],
        stride_y: usize,
        stride_z: usize,
        pad: usize,
        min_x: i32,
        min_y: i32,
        min_z: i32,
        max_x: i32,
        max_y: i32,
        max_z: i32,
        marked: bool,
    ) {
        let apron_vec = apron_blocks.to_vec();
        let apron_count = apron_vec.len() / 4;
        let pad_i = pad as i32;
        for i in 0..apron_count {
            let base = i * 4;
            let x = apron_vec[base];
            let y = apron_vec[base + 1];
            let z = apron_vec[base + 2];
            // Keep only cells inside the padded volume. Done in i32 BEFORE the usize
            // cast, since an apron coord can be min-1 (a negative local offset).
            if x < min_x - pad_i || x > max_x + pad_i
                || y < min_y - pad_i || y > max_y + pad_i
                || z < min_z - pad_i || z > max_z + pad_i
            {
                continue;
            }
            let lx = (x - min_x + pad_i) as usize;
            let ly = (y - min_y + pad_i) as usize;
            let lz = (z - min_z + pad_i) as usize;
            let idx = lx + ly * stride_y + lz * stride_z;
            if voxel_map[idx] == 0 {
                let value = apron_vec[base + 3] + 1;
                voxel_map[idx] = if marked { -value } else { value };
            }
        }
    }

    fn calculate_bounds(&self, blocks: &[i32]) -> (i32, i32, i32, i32, i32, i32) {
        let mut min_x = i32::MAX;
        let mut min_y = i32::MAX;
        let mut min_z = i32::MAX;
        let mut max_x = i32::MIN;
        let mut max_y = i32::MIN;
        let mut max_z = i32::MIN;
        
        let block_count = blocks.len() / 4;
        for i in 0..block_count {
            let base = i * 4;
            let x = blocks[base];
            let y = blocks[base + 1];
            let z = blocks[base + 2];
            
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            min_z = min_z.min(z);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
            max_z = max_z.max(z);
        }
        
        (min_x, min_y, min_z, max_x, max_y, max_z)
    }

    fn merge_category_geometries<F>(
        &self,
        category: &str,
        palette_map: &std::collections::HashMap<u32, Vec<usize>>,
        blocks: &[i32],
        voxel_map: &[i32],
        get_index: &F,
        origin_x: i32,
        origin_y: i32,
        origin_z: i32,
        _min_x: i32,
        _min_y: i32,
        _min_z: i32,
        cell_groups: &[u16],
        caps: bool,
    ) -> Option<JsValue>
    where
        F: Fn(i32, i32, i32) -> usize,
    {
        // First pass: count total vertices and indices needed
        let mut total_verts = 0usize;
        let mut total_indices = 0usize;
        
        // Collect all geometry instances to process
        // each geometry with its position, its block (for its own cull key) and its cell group
        let mut instances: Vec<(i32, i32, i32, &GeometryData, &PaletteEntryData, u16)> = Vec::new();
        
        // Sort palette indices for consistent ordering
        let mut sorted_palette_indices: Vec<_> = palette_map.keys().collect();
        sorted_palette_indices.sort();
        
        for &palette_idx in &sorted_palette_indices {
            if let Some(Some(palette_entry)) = self.palette.get(*palette_idx as usize) {
                if let Some(block_indices) = palette_map.get(palette_idx) {
                    for &block_idx in block_indices {
                        let base = block_idx * 4;
                        let x = blocks[base];
                        let y = blocks[base + 1];
                        let z = blocks[base + 2];
                        let group = cell_groups.get(block_idx).copied().unwrap_or(0);

                        for geom in &palette_entry.geometries {
                            let vert_count = geom.positions.len() / 3;
                            total_verts += vert_count;
                            total_indices += geom.indices.len();
                            instances.push((x, y, z, geom, palette_entry, group));
                        }
                    }
                }
            }
        }
        
        if total_verts == 0 {
            return None;
        }
        
        // Allocate output buffers
        let mut merged_positions: Vec<i16> = Vec::with_capacity(total_verts * 3);
        let mut merged_normals: Vec<i8> = Vec::with_capacity(total_verts * 3);
        let mut merged_uvs: Vec<f32> = Vec::with_capacity(total_verts * 2);
        // the kept triangles' indices (offset to the merged vertices) by (material, layer, group), in key order
        let mut buckets: std::collections::BTreeMap<(u32, i32, u16), Vec<u32>> = std::collections::BTreeMap::new();
        let mut v_offset = 0u32;
        
        // Process each geometry instance
        for (px, py, pz, geom, owner, group) in instances {
            let num_local_verts = geom.positions.len() / 3;
            
            // Perform face culling - collect valid indices
            let mut valid_indices: Vec<u32> = Vec::new();
            
            let local_indices = &geom.indices;
            let mut j = 0;
            while j < local_indices.len() {
                let idx0 = local_indices[j] as usize;
                let idx1 = local_indices[j + 1] as usize;
                let idx2 = local_indices[j + 2] as usize;
                
                let mut is_visible = true;
                // whether the neighbour that culled the face is in the apron (marked for caps)
                let mut culled_by_apron = false;

                // Get face normal from first vertex
                if geom.normals.len() > idx0 * 3 + 2 {
                    let nx = geom.normals[idx0 * 3];
                    let ny = geom.normals[idx0 * 3 + 1];
                    let nz = geom.normals[idx0 * 3 + 2];
                    
                    let dx = nx.round() as i32;
                    let dy = ny.round() as i32;
                    let dz = nz.round() as i32;
                    
                    // Only cull axis-aligned faces
                    if dx.abs() + dy.abs() + dz.abs() == 1 {
                        // Check if face is flush with block edge: geometry is centred, so +-0.5 on its
                        // axis (0.0 and 1.0 also matched, as if blocks ran from 0 to 1, and culled faces
                        // in the block's middle plane, such as a repeater torch's side)
                        let v0x = geom.positions[idx0 * 3];
                        let v0y = geom.positions[idx0 * 3 + 1];
                        let v0z = geom.positions[idx0 * 3 + 2];
                        
                        const EPSILON: f32 = 0.01;
                        let is_flush = match (dx, dy, dz) {
                            (1, 0, 0) => (v0x - 0.5).abs() < EPSILON,
                            (-1, 0, 0) => (v0x + 0.5).abs() < EPSILON,
                            (0, 1, 0) => (v0y - 0.5).abs() < EPSILON,
                            (0, -1, 0) => (v0y + 0.5).abs() < EPSILON,
                            (0, 0, 1) => (v0z - 0.5).abs() < EPSILON,
                            (0, 0, -1) => (v0z + 0.5).abs() < EPSILON,
                            _ => false,
                        };
                        
                        if is_flush {
                            // Check neighbor
                            let neighbor_idx = get_index(px + dx, py + dy, pz + dz);
                            let neighbor_val = voxel_map[neighbor_idx];
                            
                            if neighbor_val != 0 {
                                let neighbor_palette_idx = (neighbor_val.abs() - 1) as usize;
                                if let Some(Some(neighbor_entry)) = self.palette.get(neighbor_palette_idx) {
                                    // Map direction to face index for occlusion check
                                    let neighbor_face_index = match (dx, dy, dz) {
                                        (1, 0, 0) => 0,  // West face of neighbor
                                        (-1, 0, 0) => 1, // East face of neighbor
                                        (0, 1, 0) => 2,  // Down face of neighbor
                                        (0, -1, 0) => 3, // Up face of neighbor
                                        (0, 0, 1) => 4,  // North face of neighbor
                                        (0, 0, -1) => 5, // South face of neighbor
                                        _ => 6,
                                    };
                                    
                                    if neighbor_face_index < 6 {
                                        // an opaque side hides any face, a see-through one only the
                                        // same block's, a fluid's face only the same fluid
                                        if face_hidden_by(&owner.cull_key, geom.fluid, neighbor_entry, neighbor_face_index) {
                                            is_visible = false;
                                            culled_by_apron = neighbor_val < 0;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                
                // a mesh keeps what is visible; caps keep what a hidden cell (the apron) covered
                let keep = if caps { !is_visible && culled_by_apron } else { is_visible };
                if keep {
                    valid_indices.push(local_indices[j]);
                    valid_indices.push(local_indices[j + 1]);
                    valid_indices.push(local_indices[j + 2]);
                }
                
                j += 3;
            }
            
            if valid_indices.is_empty() {
                continue;
            }
            
            // Copy vertex data with position quantization
            for v in 0..num_local_verts {
                // Position relative to chunk origin
                let rx = (px - origin_x) as f32 + geom.positions[v * 3];
                let ry = (py - origin_y) as f32 + geom.positions[v * 3 + 1];
                let rz = (pz - origin_z) as f32 + geom.positions[v * 3 + 2];
                
                // Quantize
                merged_positions.push((rx * POSITION_SCALE) as i16);
                merged_positions.push((ry * POSITION_SCALE) as i16);
                merged_positions.push((rz * POSITION_SCALE) as i16);
                
                // Normals
                if geom.normals.len() > v * 3 + 2 {
                    merged_normals.push((geom.normals[v * 3] * NORMAL_SCALE) as i8);
                    merged_normals.push((geom.normals[v * 3 + 1] * NORMAL_SCALE) as i8);
                    merged_normals.push((geom.normals[v * 3 + 2] * NORMAL_SCALE) as i8);
                } else {
                    merged_normals.push(0);
                    merged_normals.push(127);
                    merged_normals.push(0);
                }
                
                // UVs
                if geom.uvs.len() > v * 2 + 1 {
                    merged_uvs.push(geom.uvs[v * 2]);
                    merged_uvs.push(geom.uvs[v * 2 + 1]);
                } else {
                    merged_uvs.push(0.0);
                    merged_uvs.push(0.0);
                }
            }
            
            // Indices with the vertex offset, into the block's (material, layer, group) bucket
            let bucket = buckets.entry((geom.material_index, py, group)).or_default();
            for idx in &valid_indices {
                bucket.push(*idx + v_offset);
            }

            v_offset += num_local_verts as u32;
        }

        // The buckets in order: one group per material, its layers ascending within it
        let mut merged_indices: Vec<u32> = Vec::with_capacity(total_indices);
        let mut groups: Vec<(u32, u32, u32)> = Vec::new(); // (start, count, materialIndex)
        let mut layer_runs: Vec<i32> = Vec::with_capacity(buckets.len() * 4); // layer, group, start, count
        for ((mat_index, layer, group), bucket) in &buckets {
            let start = merged_indices.len() as u32;
            merged_indices.extend_from_slice(bucket);
            let count = bucket.len() as u32;
            layer_runs.push(*layer);
            layer_runs.push(*group as i32);
            layer_runs.push(start as i32);
            layer_runs.push(count as i32);
            match groups.last_mut() {
                Some((_, group_count, group_mat)) if *group_mat == *mat_index => *group_count += count,
                _ => groups.push((start, count, *mat_index)),
            }
        }
        
        // Create JavaScript typed arrays from our data
        let positions_arr = Int16Array::new_with_length(merged_positions.len() as u32);
        positions_arr.copy_from(&merged_positions);
        
        let normals_arr = Int8Array::new_with_length(merged_normals.len() as u32);
        normals_arr.copy_from(&merged_normals);
        
        let uvs_arr = Float32Array::new_with_length(merged_uvs.len() as u32);
        uvs_arr.copy_from(&merged_uvs);
        
        let indices_arr = if v_offset > 65535 {
            let arr = Uint32Array::new_with_length(merged_indices.len() as u32);
            arr.copy_from(&merged_indices);
            arr.into()
        } else {
            let arr = Uint16Array::new_with_length(merged_indices.len() as u32);
            let indices_u16: Vec<u16> = merged_indices.iter().map(|&x| x as u16).collect();
            arr.copy_from(&indices_u16);
            arr.into()
        };
        
        // Create groups array
        let groups_arr = Array::new();
        for (start, count, mat_index) in groups {
            let group_obj = Object::new();
            Reflect::set(&group_obj, &"start".into(), &JsValue::from(start)).ok();
            Reflect::set(&group_obj, &"count".into(), &JsValue::from(count)).ok();
            Reflect::set(&group_obj, &"materialIndex".into(), &JsValue::from(mat_index)).ok();
            groups_arr.push(&group_obj);
        }
        
        let layers_arr = Int32Array::new_with_length(layer_runs.len() as u32);
        layers_arr.copy_from(&layer_runs);

        // Create result object
        let result = Object::new();
        Reflect::set(&result, &"category".into(), &JsValue::from_str(category)).ok();
        Reflect::set(&result, &"positions".into(), &positions_arr).ok();
        Reflect::set(&result, &"normals".into(), &normals_arr).ok();
        Reflect::set(&result, &"uvs".into(), &uvs_arr).ok();
        Reflect::set(&result, &"indices".into(), &indices_arr).ok();
        Reflect::set(&result, &"groups".into(), &groups_arr).ok();
        Reflect::set(&result, &"layers".into(), &layers_arr).ok();

        Some(result.into())
    }

    fn create_empty_result() -> JsValue {
        let result = Object::new();
        Reflect::set(&result, &"meshes".into(), &Array::new()).ok();
        let origin = Array::new();
        origin.push(&JsValue::from(0));
        origin.push(&JsValue::from(0));
        origin.push(&JsValue::from(0));
        Reflect::set(&result, &"origin".into(), &origin).ok();
        result.into()
    }
    
    /// Build a chunk mesh with greedy meshing optimization
    /// 
    /// This merges coplanar faces of the same material into larger quads,
    /// dramatically reducing vertex count for large flat surfaces.
    #[wasm_bindgen]
    pub fn build_chunk_greedy(
        &self,
        blocks: &Int32Array,
        origin_x: i32,
        origin_y: i32,
        origin_z: i32,
        apron_blocks: &Int32Array,
    ) -> Result<JsValue, JsValue> {
        let blocks_vec = blocks.to_vec();
        let block_count = blocks_vec.len() / 4;
        
        if block_count == 0 {
            return Ok(Self::create_empty_result());
        }
        
        // Calculate bounds
        let (min_x, min_y, min_z, max_x, max_y, max_z) = self.calculate_bounds(&blocks_vec);
        
        let size_x = (max_x - min_x + 1) as usize;
        let size_y = (max_y - min_y + 1) as usize;
        let size_z = (max_z - min_z + 1) as usize;
        
        // Build voxel map with padding
        let pad = 1usize;
        let stride_y = size_x + 2 * pad;
        let stride_z = stride_y * (size_y + 2 * pad);
        let map_size = stride_z * (size_z + 2 * pad);
        
        let mut voxel_map = vec![0i32; map_size];
        
        let get_index = |x: i32, y: i32, z: i32| -> usize {
            let lx = (x - min_x) as usize + pad;
            let ly = (y - min_y) as usize + pad;
            let lz = (z - min_z) as usize + pad;
            lx + ly * stride_y + lz * stride_z
        };
        
        // Populate voxel map
        for i in 0..block_count {
            let base = i * 4;
            let x = blocks_vec[base];
            let y = blocks_vec[base + 1];
            let z = blocks_vec[base + 2];
            let palette_idx = blocks_vec[base + 3];
            voxel_map[get_index(x, y, z)] = palette_idx + 1;
        }

        Self::populate_apron(
            apron_blocks, &mut voxel_map, stride_y, stride_z, pad,
            min_x, min_y, min_z, max_x, max_y, max_z, false,
        );

        // Collect visible faces grouped by direction and material
        // Key: (direction, material_index), Value: list of faces
        let mut face_groups: HashMap<(FaceDir, u32), Vec<GreedyFace>> = HashMap::new();
        
        let directions = [
            FaceDir::PosX, FaceDir::NegX,
            FaceDir::PosY, FaceDir::NegY,
            FaceDir::PosZ, FaceDir::NegZ,
        ];
        
        // For each block, check each face direction
        for i in 0..block_count {
            let base = i * 4;
            let bx = blocks_vec[base];
            let by = blocks_vec[base + 1];
            let bz = blocks_vec[base + 2];
            let palette_idx = blocks_vec[base + 3] as usize;
            
            let palette_entry = match self.palette.get(palette_idx) {
                Some(Some(entry)) => entry,
                _ => continue,
            };
            
            // Skip non-solid blocks for greedy meshing (they have complex geometry)
            if palette_entry.category != "solid" {
                continue;
            }
            // a block drawn elsewhere (a connected-texture block, meshed per position): in the palette for its
            // neighbours to cull against, with no geometry of its own here
            if palette_entry.geometries.is_empty() {
                continue;
            }
            
            // Get material index from first geometry (assuming solid blocks have one material)
            let material_index = palette_entry.geometries
                .first()
                .map(|g| g.material_index)
                .unwrap_or(0);
            
            for &dir in &directions {
                let (dx, dy, dz) = dir.delta();
                let neighbor_idx = get_index(bx + dx, by + dy, bz + dz);
                let neighbor_val = voxel_map[neighbor_idx];
                
                // Check if this face is visible (no occluding neighbor)
                let is_visible = if neighbor_val > 0 {
                    let neighbor_palette_idx = (neighbor_val - 1) as usize;
                    if let Some(Some(neighbor_entry)) = self.palette.get(neighbor_palette_idx) {
                        // Check if neighbor occludes this face (an opaque side, or the same block's)
                        let opp_face_idx = dir.opposite_occlusion_index();
                        !face_hidden_by(&palette_entry.cull_key, FLUID_NONE, neighbor_entry, opp_face_idx)
                    } else {
                        true
                    }
                } else {
                    true // No neighbor = visible
                };
                
                if is_visible {
                    let key = (dir, material_index);
                    face_groups.entry(key).or_default().push(GreedyFace {
                        bx, by, bz,
                        material_index,
                        // Standard unit quad UVs - will be scaled based on merged size
                        uv_min: (0.0, 0.0),
                        uv_max: (1.0, 1.0),
                    });
                }
            }
        }
        
        // Now perform greedy meshing for each face group
        let mut merged_positions: Vec<i16> = Vec::new();
        let mut merged_normals: Vec<i8> = Vec::new();
        let mut merged_uvs: Vec<f32> = Vec::new();
        let mut merged_indices: Vec<u32> = Vec::new();
        let mut groups: Vec<(u32, u32, u32)> = Vec::new();
        let mut current_group: Option<(u32, u32, u32)> = None;
        let mut v_offset = 0u32;
        
        for ((dir, material_index), faces) in &face_groups {
            if faces.is_empty() {
                continue;
            }
            
            // Run greedy meshing for this direction + material combo
            let merged_quads = self.greedy_merge_faces(*dir, faces, min_x, min_y, min_z, max_x, max_y, max_z);
            
            let (nx, ny, nz) = dir.normal();
            let nx_i8 = (nx * NORMAL_SCALE) as i8;
            let ny_i8 = (ny * NORMAL_SCALE) as i8;
            let nz_i8 = (nz * NORMAL_SCALE) as i8;
            
            for quad in &merged_quads {
                // Generate 4 vertices for the quad
                let (v0, v1, v2, v3) = self.quad_vertices(*dir, quad);
                
                // Add vertices relative to origin
                let index_start = merged_indices.len() as u32;
                
                for (vx, vy, vz, u, v) in &[(v0.0, v0.1, v0.2, 0.0f32, 0.0f32),
                                             (v1.0, v1.1, v1.2, quad.width as f32, 0.0f32),
                                             (v2.0, v2.1, v2.2, quad.width as f32, quad.height as f32),
                                             (v3.0, v3.1, v3.2, 0.0f32, quad.height as f32)] {
                    let rx = (*vx as f32) - (origin_x as f32);
                    let ry = (*vy as f32) - (origin_y as f32);
                    let rz = (*vz as f32) - (origin_z as f32);
                    
                    merged_positions.push((rx * POSITION_SCALE) as i16);
                    merged_positions.push((ry * POSITION_SCALE) as i16);
                    merged_positions.push((rz * POSITION_SCALE) as i16);
                    
                    merged_normals.push(nx_i8);
                    merged_normals.push(ny_i8);
                    merged_normals.push(nz_i8);
                    
                    // Scale UVs by quad size for tiling
                    merged_uvs.push(*u);
                    merged_uvs.push(*v);
                }
                
                // Two triangles: 0-1-2, 0-2-3
                merged_indices.push(v_offset);
                merged_indices.push(v_offset + 1);
                merged_indices.push(v_offset + 2);
                merged_indices.push(v_offset);
                merged_indices.push(v_offset + 2);
                merged_indices.push(v_offset + 3);
                
                v_offset += 4;
                
                // Update groups
                let index_count = 6u32;
                match &mut current_group {
                    Some((_, count, current_mat)) if *current_mat == *material_index => {
                        *count += index_count;
                    }
                    Some(group) => {
                        groups.push(*group);
                        current_group = Some((index_start, index_count, *material_index));
                    }
                    None => {
                        current_group = Some((index_start, index_count, *material_index));
                    }
                }
            }
        }
        
        if let Some(group) = current_group {
            groups.push(group);
        }
        
        // Also process non-solid blocks with the regular method
        // (transparent, custom geometry blocks, etc.)
        let non_solid_result = self.build_non_solid_blocks(
            &blocks_vec,
            &voxel_map,
            &get_index,
            origin_x, origin_y, origin_z,
            min_x, min_y, min_z,
        );
        
        // Combine results
        let results = Array::new();
        
        // Add greedy-meshed solid geometry
        if !merged_positions.is_empty() {
            let solid_mesh = self.create_mesh_result(
                "solid",
                &merged_positions,
                &merged_normals,
                &merged_uvs,
                &merged_indices,
                &groups,
                v_offset,
            );
            results.push(&solid_mesh);
        }
        
        // Add non-solid geometries
        for mesh in non_solid_result {
            results.push(&mesh);
        }
        
        let result = Object::new();
        Reflect::set(&result, &"meshes".into(), &results)?;
        
        let origin = Array::new();
        origin.push(&JsValue::from(origin_x));
        origin.push(&JsValue::from(origin_y));
        origin.push(&JsValue::from(origin_z));
        Reflect::set(&result, &"origin".into(), &origin)?;
        
        Ok(result.into())
    }
    
    /// Perform greedy meshing on a set of faces with the same direction and material
    fn greedy_merge_faces(
        &self,
        dir: FaceDir,
        faces: &[GreedyFace],
        min_x: i32, min_y: i32, min_z: i32,
        max_x: i32, max_y: i32, max_z: i32,
    ) -> Vec<MergedQuad> {
        let mut result = Vec::new();
        
        // Group faces by their position along the normal axis
        // For PosY/NegY: group by Y, iterate over XZ
        // For PosX/NegX: group by X, iterate over YZ
        // For PosZ/NegZ: group by Z, iterate over XY
        
        let mut layers: HashMap<i32, Vec<(i32, i32)>> = HashMap::new();
        
        for face in faces {
            let (layer, u, v) = match dir {
                FaceDir::PosY | FaceDir::NegY => (face.by, face.bx, face.bz),
                FaceDir::PosX | FaceDir::NegX => (face.bx, face.by, face.bz),
                FaceDir::PosZ | FaceDir::NegZ => (face.bz, face.bx, face.by),
            };
            layers.entry(layer).or_default().push((u, v));
        }
        
        // Get bounds for the 2D grid
        let (u_min, u_max, v_min, v_max) = match dir {
            FaceDir::PosY | FaceDir::NegY => (min_x, max_x, min_z, max_z),
            FaceDir::PosX | FaceDir::NegX => (min_y, max_y, min_z, max_z),
            FaceDir::PosZ | FaceDir::NegZ => (min_x, max_x, min_y, max_y),
        };
        
        let u_size = (u_max - u_min + 1) as usize;
        let v_size = (v_max - v_min + 1) as usize;
        
        // Process each layer
        for (layer, face_coords) in layers {
            // Create 2D mask grid
            let mut mask = vec![false; u_size * v_size];
            
            for (u, v) in &face_coords {
                let ui = (*u - u_min) as usize;
                let vi = (*v - v_min) as usize;
                if ui < u_size && vi < v_size {
                    mask[vi * u_size + ui] = true;
                }
            }
            
            // Greedy algorithm: find rectangles
            for v_idx in 0..v_size {
                let mut u_idx = 0;
                while u_idx < u_size {
                    if !mask[v_idx * u_size + u_idx] {
                        u_idx += 1;
                        continue;
                    }
                    
                    // Found a face, expand width (along u)
                    let mut width = 1;
                    while u_idx + width < u_size && mask[v_idx * u_size + u_idx + width] {
                        width += 1;
                    }
                    
                    // Expand height (along v)
                    let mut height = 1;
                    'height_loop: while v_idx + height < v_size {
                        // Check if entire row is filled
                        for w in 0..width {
                            if !mask[(v_idx + height) * u_size + u_idx + w] {
                                break 'height_loop;
                            }
                        }
                        height += 1;
                    }
                    
                    // Clear the rectangle from mask
                    for h in 0..height {
                        for w in 0..width {
                            mask[(v_idx + h) * u_size + u_idx + w] = false;
                        }
                    }
                    
                    // Convert back to world coordinates
                    let u_world = u_idx as i32 + u_min;
                    let v_world = v_idx as i32 + v_min;
                    
                    let (x, y, z) = match dir {
                        FaceDir::PosY | FaceDir::NegY => (u_world, layer, v_world),
                        FaceDir::PosX | FaceDir::NegX => (layer, u_world, v_world),
                        FaceDir::PosZ | FaceDir::NegZ => (u_world, v_world, layer),
                    };
                    
                    result.push(MergedQuad {
                        x, y, z,
                        width: width as i32,
                        height: height as i32,
                    });
                    
                    u_idx += width;
                }
            }
        }
        
        result
    }
    
    /// Generate the 4 corner vertices for a quad based on direction and merged size
    fn quad_vertices(&self, dir: FaceDir, quad: &MergedQuad) -> ((i32, i32, i32), (i32, i32, i32), (i32, i32, i32), (i32, i32, i32)) {
        let x = quad.x;
        let y = quad.y;
        let z = quad.z;
        let w = quad.width;
        let h = quad.height;
        
        match dir {
            // For +Y face (top of block), we need y+1
            FaceDir::PosY => (
                (x, y + 1, z),
                (x + w, y + 1, z),
                (x + w, y + 1, z + h),
                (x, y + 1, z + h),
            ),
            // For -Y face (bottom of block), at y
            FaceDir::NegY => (
                (x, y, z + h),
                (x + w, y, z + h),
                (x + w, y, z),
                (x, y, z),
            ),
            // For +X face (east), at x+1
            FaceDir::PosX => (
                (x + 1, y, z),
                (x + 1, y, z + h),
                (x + 1, y + w, z + h),
                (x + 1, y + w, z),
            ),
            // For -X face (west), at x
            FaceDir::NegX => (
                (x, y, z + h),
                (x, y, z),
                (x, y + w, z),
                (x, y + w, z + h),
            ),
            // For +Z face (south), at z+1
            FaceDir::PosZ => (
                (x + w, y, z + 1),
                (x, y, z + 1),
                (x, y + h, z + 1),
                (x + w, y + h, z + 1),
            ),
            // For -Z face (north), at z
            FaceDir::NegZ => (
                (x, y, z),
                (x + w, y, z),
                (x + w, y + h, z),
                (x, y + h, z),
            ),
        }
    }
    
    /// Build non-solid blocks (transparent, custom geometry) with regular method
    fn build_non_solid_blocks<F>(
        &self,
        blocks: &[i32],
        voxel_map: &[i32],
        get_index: &F,
        origin_x: i32, origin_y: i32, origin_z: i32,
        _min_x: i32, _min_y: i32, _min_z: i32,
    ) -> Vec<JsValue>
    where
        F: Fn(i32, i32, i32) -> usize,
    {
        let block_count = blocks.len() / 4;
        let mut category_batches: HashMap<String, HashMap<u32, Vec<usize>>> = HashMap::new();
        
        for i in 0..block_count {
            let base = i * 4;
            let palette_idx = blocks[base + 3] as u32;
            
            if let Some(Some(palette_entry)) = self.palette.get(palette_idx as usize) {
                // Skip solid blocks (handled by greedy meshing)
                if palette_entry.category == "solid" {
                    continue;
                }
                
                category_batches
                    .entry(palette_entry.category.clone())
                    .or_default()
                    .entry(palette_idx)
                    .or_default()
                    .push(i);
            }
        }
        
        let mut results = Vec::new();
        
        for (category, palette_map) in category_batches {
            if let Some(mesh) = self.merge_category_geometries(
                &category,
                &palette_map,
                blocks,
                voxel_map,
                get_index,
                origin_x, origin_y, origin_z,
                _min_x, _min_y, _min_z,
                &[],
                false,
            ) {
                results.push(mesh);
            }
        }
        
        results
    }
    
    /// Helper to create mesh result object
    fn create_mesh_result(
        &self,
        category: &str,
        positions: &[i16],
        normals: &[i8],
        uvs: &[f32],
        indices: &[u32],
        groups: &[(u32, u32, u32)],
        vertex_count: u32,
    ) -> JsValue {
        let positions_arr = Int16Array::new_with_length(positions.len() as u32);
        positions_arr.copy_from(positions);
        
        let normals_arr = Int8Array::new_with_length(normals.len() as u32);
        normals_arr.copy_from(normals);
        
        let uvs_arr = Float32Array::new_with_length(uvs.len() as u32);
        uvs_arr.copy_from(uvs);
        
        let indices_arr: JsValue = if vertex_count > 65535 {
            let arr = Uint32Array::new_with_length(indices.len() as u32);
            arr.copy_from(indices);
            arr.into()
        } else {
            let arr = Uint16Array::new_with_length(indices.len() as u32);
            let indices_u16: Vec<u16> = indices.iter().map(|&x| x as u16).collect();
            arr.copy_from(&indices_u16);
            arr.into()
        };
        
        let groups_arr = Array::new();
        for (start, count, mat_index) in groups {
            let group_obj = Object::new();
            Reflect::set(&group_obj, &"start".into(), &JsValue::from(*start)).ok();
            Reflect::set(&group_obj, &"count".into(), &JsValue::from(*count)).ok();
            Reflect::set(&group_obj, &"materialIndex".into(), &JsValue::from(*mat_index)).ok();
            groups_arr.push(&group_obj);
        }
        
        let result = Object::new();
        Reflect::set(&result, &"category".into(), &JsValue::from_str(category)).ok();
        Reflect::set(&result, &"positions".into(), &positions_arr).ok();
        Reflect::set(&result, &"normals".into(), &normals_arr).ok();
        Reflect::set(&result, &"uvs".into(), &uvs_arr).ok();
        Reflect::set(&result, &"indices".into(), &indices_arr).ok();
        Reflect::set(&result, &"groups".into(), &groups_arr).ok();
        
        result.into()
    }
}

/// Get the version of the mesh builder
#[wasm_bindgen]
pub fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
