import { dirname, join } from "@std/path";
import { ensureDir } from "@std/fs";
import type { FileInfo } from "../file-finder.ts";
import type { FilesystemCopyDestination } from "../config.ts";
import type {
	CheckResult,
	RelayAdapter,
	TransferOptions,
	TransferResult,
} from "./adapter.ts";

async function sha256OfFile(path: string): Promise<string> {
	// WebCrypto digest() doesn't support streams, so this buffers the file.
	// Opt-in path (`verify: "sha256"`) — the default "size" mode streams via
	// copyFile and is safe for arbitrarily large files.
	const data = await Deno.readFile(path);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Create a {@linkcode RelayAdapter} that copies files to a local/mounted filesystem directory.
 * Preserves source subdirectory structure at the destination.
 */
export function createFilesystemAdapter(
	config: FilesystemCopyDestination,
): RelayAdapter {
	const verify = config.verify ?? "size";

	return {
		name: "filesystem",

		async check(): Promise<CheckResult> {
			try {
				await ensureDir(config.dir);
				// try writing a probe file to verify we actually have write
				// permission (ensureDir is happy if the dir already exists).
				const probe = join(config.dir, `.file-relay-probe-${Date.now()}`);
				await Deno.writeTextFile(probe, "");
				await Deno.remove(probe);
				return { ok: true };
			} catch (err) {
				return {
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		},

		async transfer(
			file: FileInfo,
			options?: TransferOptions,
		): Promise<TransferResult> {
			const destPath = join(config.dir, file.relativePath);
			const start = performance.now();
			const signal = options?.signal;

			try {
				if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
				await ensureDir(dirname(destPath));
				if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
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

				// optional checksum verification
				if (verify === "sha256") {
					const [srcHash, destHash] = await Promise.all([
						sha256OfFile(file.path),
						sha256OfFile(destPath),
					]);
					if (srcHash !== destHash) {
						return {
							success: false,
							sourceFile: file,
							destination: destPath,
							error: `SHA-256 mismatch: source=${srcHash}` +
								` dest=${destHash}`,
							durationMs: performance.now() - start,
						};
					}
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
