/**
 * A block state as a block string, `name[key=value,...]` (just `name` without properties), the form
 * Cubane.parseBlockString reads. The properties are sorted by key, so one state always gives the same
 * string and caches keyed by it hold it once.
 */
export function formatBlockString(
	name: string,
	properties: Readonly<Record<string, unknown>> = {}
): string {
	const keys = Object.keys(properties).sort();
	if (keys.length === 0) return name;
	return `${name}[${keys.map((k) => `${k}=${properties[k]}`).join(",")}]`;
}

/** A block id with its namespace: one without is the game's (`stone` is `minecraft:stone`). */
export function namespacedId(id: string): string {
	return id.includes(":") ? id : `minecraft:${id}`;
}

/** Whether a block id is air (`air`, `cave_air` or `void_air`, the game's): no block there. */
export function isAir(id: string): boolean {
	return /^(minecraft:)?(cave_|void_)?air$/.test(id);
}

/**
 * A block string, `namespace:name[key=value,...]`, as its parts: the namespace (the game's when it has none), the
 * name and the properties. The namespace is what comes before the first `:` of the name only, and a property's value
 * is everything after its first `=`, so a value holding a `:` or `=` (a mod's) is read whole: splitting the whole
 * string at every `:` lost it.
 */
export function parseBlockString(blockString: string): {
	namespace: string;
	name: string;
	properties: Record<string, string>;
} {
	const open = blockString.indexOf("[");
	const id = open === -1 ? blockString : blockString.slice(0, open);
	const colon = id.indexOf(":");
	const namespace = colon === -1 ? "minecraft" : id.slice(0, colon);
	const name = colon === -1 ? id : id.slice(colon + 1);
	const properties: Record<string, string> = {};
	if (open !== -1) {
		const close = blockString.lastIndexOf("]");
		const body = blockString.slice(open + 1, close > open ? close : undefined);
		for (const pair of body.split(",")) {
			const eq = pair.indexOf("=");
			if (eq <= 0) continue;
			const key = pair.slice(0, eq).trim();
			const value = pair.slice(eq + 1).trim();
			if (key && value) properties[key] = value;
		}
	}
	return { namespace, name, properties };
}
