# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
