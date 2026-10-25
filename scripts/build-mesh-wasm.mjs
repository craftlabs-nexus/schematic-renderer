// Builds the WASM mesher (mesh_builder_wasm/) and copies its output into src/wasm/.
//
//   npm run build:wasm
//
// Needs Rust with the wasm32-unknown-unknown target and wasm-pack. rustc writes the source path of every function
// that can panic into the binary, and for dependencies that path is under the cargo registry in the builder's home
// directory (e.g. C:\Users\<name>\.cargo\registry\...). The binary is committed and inlined into the published
// bundle, so those paths are remapped to neutral prefixes, and the build fails if the home directory still shows up.

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crate = path.join(root, "mesh_builder_wasm");
const out = path.join(crate, "out");
const dest = path.join(root, "src", "wasm");
const home = os.homedir();
const cargoHome = process.env.CARGO_HOME
	? path.resolve(process.env.CARGO_HOME)
	: path.join(home, ".cargo");

// For several matching prefixes rustc applies the last one given, so the most specific goes last.
const remaps = [
	`--remap-path-prefix=${home}=~`,
	`--remap-path-prefix=${root}=/schematic-renderer`,
	`--remap-path-prefix=${cargoHome}=/cargo`,
];
// CARGO_ENCODED_RUSTFLAGS (separated by 0x1f) keeps paths with spaces in one flag; it takes precedence over RUSTFLAGS,
// so flags already set there are carried over.
const existing = process.env.CARGO_ENCODED_RUSTFLAGS
	? process.env.CARGO_ENCODED_RUSTFLAGS.split("\x1f")
	: (process.env.RUSTFLAGS ?? "").split(/\s+/).filter(Boolean);
const env = { ...process.env, CARGO_ENCODED_RUSTFLAGS: [...existing, ...remaps].join("\x1f") };
delete env.RUSTFLAGS;

execFileSync("wasm-pack", ["build", "--release", "--target", "web", "--out-dir", "out"], {
	cwd: crate,
	env,
	stdio: "inherit",
});

const files = [
	"mesh_builder_wasm.js",
	"mesh_builder_wasm.d.ts",
	"mesh_builder_wasm_bg.wasm",
	"mesh_builder_wasm_bg.wasm.d.ts",
];

// The binary must not name the machine it was built on.
const wasm = readFileSync(path.join(out, "mesh_builder_wasm_bg.wasm"));
for (const needle of new Set([home, home.replaceAll("\\", "/")])) {
	if (wasm.includes(Buffer.from(needle))) {
		console.error(`mesh_builder_wasm_bg.wasm still contains "${needle}"; not copied to src/wasm`);
		process.exit(1);
	}
}

for (const file of files) copyFileSync(path.join(out, file), path.join(dest, file));
// the commit hook formats src/**/*.ts; format the declarations now so a rebuild leaves no formatting diff
const declarations = files.filter((f) => f.endsWith(".d.ts")).map((f) => path.join(dest, f));
execFileSync(
	process.execPath,
	[path.join(root, "node_modules", "prettier", "bin", "prettier.cjs"), "--write", ...declarations],
	{
		cwd: root,
		stdio: "inherit",
	}
);
console.log(`Copied ${files.length} files to src/wasm`);
