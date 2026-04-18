import { dirname, join } from "@std/path";
import { ensureDir, walk } from "@std/fs";

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
 * Create a filesystem-based tracker for deduplication.
 *
 * Stores `{relativePath}.transferred.json` marker files under `trackDir`,
 * mirroring the source directory structure.
 */
export function createTracker(trackDir: string): Tracker {
	return {
		async isTransferred(relativePath: string): Promise<boolean> {
			try {
				const stat = await Deno.stat(
					markerPath(trackDir, relativePath),
				);
				return stat.isFile;
			} catch {
				return false;
			}
		},

		async markTransferred(
			relativePath: string,
			meta: TransferMeta,
		): Promise<void> {
			const mp = markerPath(trackDir, relativePath);
			await ensureDir(dirname(mp));
			const content = JSON.stringify(meta, null, "\t");

			// atomic write: temp file + rename
			const tmp = `${mp}.tmp`;
			await Deno.writeTextFile(tmp, content);
			await Deno.rename(tmp, mp);
		},

		async sweepTmp(): Promise<number> {
			let removed = 0;
			try {
				for await (
					const entry of walk(trackDir, {
						includeDirs: false,
						includeFiles: true,
						includeSymlinks: false,
						match: [/\.transferred\.json\.tmp$/],
					})
				) {
					try {
						await Deno.remove(entry.path);
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
