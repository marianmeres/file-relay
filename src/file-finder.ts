import { isAbsolute, join, relative } from "@std/path";
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

/**
 * Recursively walk a directory yielding file entries. When `followSymlinks`
 * is enabled, already-visited real paths are tracked to prevent infinite
 * recursion on cyclic symlinks.
 */
async function* walkDir(
	dir: string,
	followSymlinks: boolean,
	visited: Set<string>,
): AsyncGenerator<{ path: string; name: string }> {
	if (followSymlinks) {
		let real: string;
		try {
			real = await Deno.realPath(dir);
		} catch {
			return;
		}
		if (visited.has(real)) return;
		visited.add(real);
	}

	for await (const entry of Deno.readDir(dir)) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory) {
			yield* walkDir(fullPath, followSymlinks, visited);
		} else if (entry.isFile) {
			yield { path: fullPath, name: entry.name };
		} else if (entry.isSymlink && followSymlinks) {
			try {
				const info = await Deno.stat(fullPath);
				if (info.isFile) {
					yield { path: fullPath, name: entry.name };
				} else if (info.isDirectory) {
					yield* walkDir(fullPath, followSymlinks, visited);
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

	// Regex-based filters (partial match via RegExp.test)
	const matchRes = (source.match ?? []).map((p) => new RegExp(p));
	const ignoreRes = (source.ignore ?? []).map((p) => new RegExp(p));

	const files: FileInfo[] = [];

	for await (const entry of walkDir(source.dir, followSymlinks, new Set())) {
		const rel = relative(source.dir, entry.path);

		// safety: relative path must stay within source.dir
		// (can only happen today via a symlink pointing outside source.dir
		// when followSymlinks is true)
		if (isAbsolute(rel) || rel.startsWith("..")) continue;

		// must match the include glob
		if (!includeRe.test(rel)) continue;

		// must not match any exclude glob
		if (excludeRes.some((re) => re.test(rel))) continue;

		// must match at least one regex include pattern (if any specified)
		if (matchRes.length > 0 && !matchRes.some((re) => re.test(rel))) {
			continue;
		}

		// must not match any regex exclude pattern
		if (ignoreRes.some((re) => re.test(rel))) continue;

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
