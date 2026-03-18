import { relative } from "@std/path";
import { globToRegExp } from "@std/path/glob-to-regexp";
import type { SourceConfig } from "./config.ts";

/** Metadata about a discovered file in the source directory. */
export interface FileInfo {
	/** Absolute path to the file. */
	path: string;
	/** Path relative to source.dir (preserves subdir structure). */
	relativePath: string;
	/** Basename of the file. */
	name: string;
	/** File size in bytes. */
	size: number;
	/** File modification time. */
	mtime: Date;
}

/** Recursively walk a directory yielding file entries. */
async function* walkDir(
	dir: string,
	followSymlinks: boolean,
): AsyncGenerator<{ path: string; name: string }> {
	for await (const entry of Deno.readDir(dir)) {
		const fullPath = `${dir}/${entry.name}`;
		if (entry.isDirectory) {
			yield* walkDir(fullPath, followSymlinks);
		} else if (entry.isFile) {
			yield { path: fullPath, name: entry.name };
		} else if (entry.isSymlink && followSymlinks) {
			// resolve symlink and check if it's a file or directory
			try {
				const info = await Deno.stat(fullPath);
				if (info.isFile) {
					yield { path: fullPath, name: entry.name };
				} else if (info.isDirectory) {
					yield* walkDir(fullPath, followSymlinks);
				}
			} catch {
				// broken symlink — skip silently
			}
		}
	}
}

/**
 * Recursively scan source directory and return matching files,
 * sorted by mtime descending (most recent first).
 */
export async function findFiles(source: SourceConfig): Promise<FileInfo[]> {
	const glob = source.glob ?? "**/*";
	const exclude = source.exclude ?? [];
	const followSymlinks = source.followSymlinks ?? false;

	const includeRe = globToRegExp(glob, { extended: true, globstar: true });
	const excludeRes = exclude.map((p) =>
		globToRegExp(p, { extended: true, globstar: true })
	);

	const files: FileInfo[] = [];

	for await (const entry of walkDir(source.dir, followSymlinks)) {
		const rel = relative(source.dir, entry.path);

		// must match the include glob
		if (!includeRe.test(rel)) continue;

		// must not match any exclude glob
		if (excludeRes.some((re) => re.test(rel))) continue;

		try {
			const stat = await Deno.stat(entry.path);
			files.push({
				path: entry.path,
				relativePath: rel,
				name: entry.name,
				size: stat.size,
				mtime: stat.mtime ?? new Date(0),
			});
		} catch {
			// file vanished between readDir and stat — skip
		}
	}

	// sort by mtime descending
	files.sort(
		(a, b) => b.mtime.getTime() - a.mtime.getTime(),
	);

	return files;
}
