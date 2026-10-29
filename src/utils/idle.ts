/**
 * A pause until the page is idle (requestIdleCallback; a timer where there is none), at most `timeout` ms: work that
 * can wait (saving caches) is done then, or between its batches, rather than while the page is busy.
 */
export function idle(timeout = 200): Promise<void> {
	return new Promise((resolve) =>
		typeof requestIdleCallback === "function"
			? requestIdleCallback(() => resolve(), { timeout })
			: setTimeout(resolve, 0)
	);
}
