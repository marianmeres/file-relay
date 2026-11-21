import { mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Metadata stored in a transfer marker file. */
export interface TransferMeta {
	/** ISO timestamp of when the transfer occurred. */
	transferredAt: string;
	/** Absolute path to the source file. */
	sourcePath: string;
	/** Size of the source file in bytes. */
	sourceSize: number;
	/** Human-readable destination description. */
	destinationInfo: string;
}

/** Filesystem-based deduplication tracker using JSON marker files. */
export interface Tracker {
	/** Check if file (by relative path) was already successfully transferred. */
	isTransferred(relativePath: string): Promise<boolean>;
	/** Mark a file as successfully transferred, writing marker with metadata. */
	markTransferred(
		relativePath: string,
		meta: TransferMeta,
	): Promise<void>;
	/**
	 * Remove stray `*.transferred.json.tmp` files left behind by a previous
	 * crash between write and rename. Safe to call at the start of every run.
	 */
	sweepTmp(): Promise<number>;
}

function markerPath(trackDir: string, relativePath: string): string {
	return join(trackDir, `${relativePath}.transferred.json`);
}

/**
 * Every regular file under `dir`, recursively. Symlinks are neither followed nor
 * yielded (what `@std/fs` `walk()` did with `includeSymlinks: false`); an
 * unreadable `dir` throws.
 */
async function* walkFiles(dir: string): AsyncGenerator<string> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* walkFiles(path);
		else if (entry.isFile()) yield path;
	}
}

/**
 * Create a filesystem-based tracker for deduplication.
 *
 * Stores `{relativePath}.transferred.json` marker files under `trackDir`,
 * mirroring the source directory structure.
 */
export function createTracker(trackDir: string): Tracker {
	return {
		async isTransferred(relativePath: string): Promise<boolean> {
			try {
				const info = await stat(
					markerPath(trackDir, relativePath),
				);
				return info.isFile();
			} catch {
				return false;
			}
		},

		async markTransferred(
			relativePath: string,
			meta: TransferMeta,
		): Promise<void> {
			const mp = markerPath(trackDir, relativePath);
			await mkdir(dirname(mp), { recursive: true });
			const content = JSON.stringify(meta, null, "\t");

			// atomic write: temp file + rename
			const tmp = `${mp}.tmp`;
			await writeFile(tmp, content);
			await rename(tmp, mp);
		},

		async sweepTmp(): Promise<number> {
			let removed = 0;
			try {
				for await (const path of walkFiles(trackDir)) {
					if (!/\.transferred\.json\.tmp$/.test(path)) continue;
					try {
						await unlink(path);
						removed++;
					} catch {
						// best-effort; ignore
					}
				}
			} catch {
				// trackDir doesn't exist yet — nothing to sweep
			}
			return removed;
		},
	};
}
