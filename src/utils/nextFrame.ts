/**
 * Resolves at the next animation frame, or after `timeoutMs` if no frame comes first. Browsers stop
 * animation frames in a hidden tab, so a build that waits only on them would stall until the tab is shown
 * again; the timeout keeps it going (more slowly) in the background.
 */
export function nextFrame(timeoutMs = 50): Promise<void> {
	return new Promise<void>((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			resolve();
		};
		if (typeof requestAnimationFrame === "function") requestAnimationFrame(finish);
		setTimeout(finish, timeoutMs);
	});
}
