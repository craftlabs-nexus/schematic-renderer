// A renderer's progress bar (UIManager) is one for everything that shows progress on it: each schematic's builds,
// a schematic being loaded. Each holds the bar while it runs and lets go of it when it ends, and the bar is hidden
// once nothing holds it, so one ending does not hide it under another still running.

/** What holding a progress bar needs of it (UIManager's). */
export interface ProgressBar {
	showProgressBar(label?: string): void;
	hideProgressBar(): void;
	isProgressBarVisible(): boolean;
}

// what holds each bar
const holders = new WeakMap<ProgressBar, Set<object>>();

/** Shows `bar` for `holder` (with `label`, unless the holder shows it already) until it lets go (releaseProgressBar). */
export function holdProgressBar(bar: ProgressBar, holder: object, label: string): void {
	let held = holders.get(bar);
	if (!held) holders.set(bar, (held = new Set()));
	if (!held.has(holder) || !bar.isProgressBarVisible()) bar.showProgressBar(label);
	held.add(holder);
}

/** Lets go of `bar` for `holder`, and hides it once nothing holds it. Nothing for a holder that does not hold it. */
export function releaseProgressBar(bar: ProgressBar, holder: object): void {
	const held = holders.get(bar);
	if (held?.delete(holder) && held.size === 0) bar.hideProgressBar();
}
