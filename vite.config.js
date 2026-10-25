import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'path';
import fs from 'fs';

// Inlines .wasm files as base64 data URLs so the library bundle is self-contained.
const wasmInlinePlugin = () => ({
  name: 'wasm-inline',
  enforce: 'pre',
  transform(_code, id) {
    const cleanId = id.split('?')[0];
    if (cleanId.endsWith('.wasm')) {
      const base64 = fs.readFileSync(cleanId).toString('base64');
      return {
        code: `export default "data:application/wasm;base64,${base64}";`,
        map: null,
      };
    }
  },
});

const config = defineConfig({
  server: {
    port: 4000,
    open: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    fs: {
      allow: ['..', '../..'],
    },
  },
  root: './test/pages',
  publicDir: '../public',
  build: {
    outDir: '../../dist',
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      name: 'SchematicRenderer',
      fileName: (format) => `schematic-renderer.${format}.js`,
      formats: ['es', 'umd'],
    },
    sourcemap: false,
    rollupOptions: {
      external: ['three', 'nucleation'],
      output: {
        globals: {
          three: 'THREE',
          nucleation: 'Nucleation',
        },
      },
    },
  },
  plugins: [
    wasmInlinePlugin(),
    topLevelAwait(),
    wasm(),
  ],
  define: {
    'process.env': {},
    'global': 'globalThis',
  },
  optimizeDeps: {
    exclude: ['nucleation', '@wasm/minecraft_schematic_utils', '@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  worker: {
    format: 'es',
    plugins: [wasmInlinePlugin()],
  },
  test: {
    root: './',
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}'],
    exclude: ['node_modules', 'dist', 'test/pages'],
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      exclude: [
        'node_modules/',
        'dist/',
        'test/',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/index.ts',
        'src/test/**',
      ],
    },
  }
});

// `npm run build:watch` (mode lib-watch): the ES build only, with source maps, rebuilt on every change. For an app
// that uses this checkout instead of the published package (e.g. an app's own dev script that links the renderer).
export default defineConfig(({ mode }) =>
  mode === 'lib-watch'
    ? { ...config, build: { ...config.build, sourcemap: true, reportCompressedSize: false, lib: { ...config.build.lib, formats: ['es'] } } }
    : config,
);
