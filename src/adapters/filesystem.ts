import { dirname, join } from "@std/path";
import { ensureDir } from "@std/fs";
import type { FileInfo } from "../file-finder.ts";
import type { FilesystemCopyDestination } from "../config.ts";
import type { RelayAdapter, TransferResult } from "./adapter.ts";

/**
 * Create a {@linkcode RelayAdapter} that copies files to a local/mounted filesystem directory.
 * Preserves source subdirectory structure at the destination.
 */
export function createFilesystemAdapter(
	config: FilesystemCopyDestination,
): RelayAdapter {
	return {
		name: "filesystem",

		async transfer(file: FileInfo): Promise<TransferResult> {
			const destPath = join(config.dir, file.relativePath);
			const start = performance.now();

			try {
				await ensureDir(dirname(destPath));
				await Deno.copyFile(file.path, destPath);

				// verify copy size
				const destStat = await Deno.stat(destPath);
				if (destStat.size !== file.size) {
					return {
						success: false,
						sourceFile: file,
						destination: destPath,
						error: `Size mismatch: source=${file.size}` +
							` dest=${destStat.size}`,
						durationMs: performance.now() - start,
					};
				}

				return {
					success: true,
					sourceFile: file,
					destination: destPath,
					bytesTransferred: file.size,
					durationMs: performance.now() - start,
				};
			} catch (err) {
				return {
					success: false,
					sourceFile: file,
					destination: destPath,
					error: err instanceof Error ? err.message : String(err),
					durationMs: performance.now() - start,
				};
			}
		},
	};
}
