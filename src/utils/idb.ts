// Opening IndexedDB databases, the same way everywhere the renderer keeps something in the browser (the packs, the
// atlases, the block shapes, the HDRI environments): no IndexedDB, a failed open or an open another tab blocks is
// "no database" (null), which every caller already handles by doing without; a connection closes itself when another
// tab opens a newer version or deletes the database (each waited for the page's life before); and a connection that
// opens only after its caller gave up is closed, not left open for nothing.

export interface OpenOptions {
	/**
	 * Makes or updates the stores (onupgradeneeded): the open request is there for its transaction. Without it the
	 * database is opened as it is, never made or upgraded (openExisting).
	 */
	upgrade?: (db: IDBDatabase, request: IDBOpenDBRequest, oldVersion: number) => void;
	/**
	 * What an open that another tab blocks (it holds an older version) does: "give up" resolves null at once, the
	 * cache done without this time; "wait" keeps waiting for the other tab (a store that must not lose what it holds).
	 */
	whenBlocked?: "give up" | "wait";
	/** Called once the connection closes for another tab's newer version or a delete. */
	onClose?: () => void;
}

/** Opens a database at `version` (none: as it is); null when there is no IndexedDB or it cannot be opened. */
export function openDatabase(
	name: string,
	version: number | undefined,
	options: OpenOptions = {}
): Promise<IDBDatabase | null> {
	return new Promise((resolve) => {
		if (typeof indexedDB === "undefined") return resolve(null);
		let request: IDBOpenDBRequest;
		try {
			request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
		} catch {
			return resolve(null);
		}
		let gaveUp = false;
		request.onupgradeneeded = (event) => {
			if (options.upgrade) options.upgrade(request.result, request, event.oldVersion);
			// opened to read what is there: none is made
			else request.transaction?.abort();
		};
		request.onsuccess = () => {
			const db = request.result;
			if (gaveUp) return db.close();
			db.onversionchange = () => {
				db.close();
				options.onClose?.();
			};
			resolve(db);
		};
		request.onerror = () => resolve(null);
		request.onblocked = () => {
			if ((options.whenBlocked ?? "give up") === "wait") return;
			gaveUp = true;
			resolve(null);
		};
	});
}

/**
 * Opens a database only if it exists, as it is, for reading or clearing what is there (null when there is none): no
 * empty database is made in a browser that never had one.
 */
export async function openExisting(name: string): Promise<IDBDatabase | null> {
	if (typeof indexedDB === "undefined") return null;
	try {
		const dbs = (await indexedDB.databases?.()) ?? null;
		if (dbs && !dbs.some((d) => d.name === name)) return null;
	} catch {
		return null;
	}
	return openDatabase(name, undefined, { whenBlocked: "give up" });
}

/**
 * A connection kept for the page, opened on first use: the function returns it, opening it again after it closed
 * for another tab's newer version or a delete, and after an open another tab blocked (tried again on the next use).
 */
export function keptDatabase(
	name: string,
	version: number,
	options: Omit<OpenOptions, "onClose"> = {}
): () => Promise<IDBDatabase | null> {
	let opening: Promise<IDBDatabase | null> | null = null;
	return () => {
		if (opening) return opening;
		const current: Promise<IDBDatabase | null> = openDatabase(name, version, {
			...options,
			onClose: () => {
				if (opening === current) opening = null;
			},
		}).then((db) => {
			// blocked or failed: the next use tries again
			if (!db && opening === current) opening = null;
			return db;
		});
		opening = current;
		return current;
	};
}

/** A request's result, as a promise (its error as a rejection). */
export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** A transaction's end: resolves once it commits, rejects when it fails or is aborted. */
export function transactionDone(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
	});
}
