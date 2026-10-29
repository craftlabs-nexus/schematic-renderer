// The game's liquids, in one place: which blocks are water or lava, which hold water, and the textures a liquid face
// draws with. A mod's block named water or lava (another namespace) is its own block, drawn from its blockstate;
// blocks named after a liquid (water_cauldron, lava_cauldron) are not liquids.
import { namespacedId } from "./blockString";

export { namespacedId };

export type LiquidKind = "water" | "lava";

/** The liquid a block id is (its flowing form included), or null. */
export function liquidOf(id: string): LiquidKind | null {
	switch (namespacedId(id)) {
		case "minecraft:water":
		case "minecraft:flowing_water":
			return "water";
		case "minecraft:lava":
		case "minecraft:flowing_lava":
			return "lava";
		default:
			return null;
	}
}

/** Blocks that hold water without a `waterlogged` property (the game's always-waterlogged plants and columns). */
export const ALWAYS_WATERLOGGED: ReadonlySet<string> = new Set([
	"minecraft:kelp",
	"minecraft:kelp_plant",
	"minecraft:seagrass",
	"minecraft:tall_seagrass",
	"minecraft:bubble_column",
]);

/** Whether a block holds water: `waterlogged=true`, or one that always does. */
export function isWaterlogged(id: string, properties?: Record<string, string>): boolean {
	return properties?.waterlogged === "true" || ALWAYS_WATERLOGGED.has(namespacedId(id));
}

/**
 * The texture a liquid's face draws with: the still texture on top and, unless the liquid flows, on every side (a
 * pack's flow texture often has no .mcmeta and would not animate on a source's sides).
 */
export function liquidTexture(kind: LiquidKind, direction: string, flowing: boolean): string {
	return flowing && direction !== "up" ? `block/${kind}_flow` : `block/${kind}_still`;
}

/** Whether a texture path is one of the game's liquid textures (animated: kept out of the atlas). */
export function isLiquidTexture(path: string): boolean {
	return /^(minecraft:)?block\/(water|lava)_(still|flow)$/.test(path);
}
