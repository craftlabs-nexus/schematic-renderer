// vitest 4 declares vite (6 to 8) both as a dependency and as a peer. pnpm fills the peer from this project's own
// vite, which is 4 (the library build's plugins need it), and vitest fails to start on it. Dropping the peer leaves
// the dependency, so vitest gets a vite of its own, as npm gave it.
const VITEST = new Set(["vitest", "@vitest/mocker"]);

function readPackage(pkg) {
	if (VITEST.has(pkg.name) && pkg.peerDependencies?.vite) {
		delete pkg.peerDependencies.vite;
		if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta.vite;
		// @vitest/mocker has vite only as a peer: give it the range vitest takes
		pkg.dependencies = { vite: "^6.0.0 || ^7.0.0 || ^8.0.0", ...pkg.dependencies };
	}
	return pkg;
}

export const hooks = { readPackage };
