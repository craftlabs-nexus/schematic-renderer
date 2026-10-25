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
