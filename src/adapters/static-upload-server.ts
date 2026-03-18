import type { FileInfo } from "../file-finder.ts";
import type { StaticUploadServerDestination } from "../config.ts";
import type { RelayAdapter, TransferResult } from "./adapter.ts";

/**
 * Create a {@linkcode RelayAdapter} that uploads files via HTTP multipart POST
 * to a `@marianmeres/deno-static-upload-server` instance.
 */
export function createStaticUploadServerAdapter(
	config: StaticUploadServerDestination,
): RelayAdapter {
	const timeout = config.timeout ?? 300_000;

	return {
		name: "static-upload-server",

		async transfer(file: FileInfo): Promise<TransferResult> {
			const start = performance.now();
			const destination = `${config.url} -> ${file.relativePath}`;

			const controller = new AbortController();
			const timer = setTimeout(
				() => controller.abort(),
				timeout,
			);

			try {
				const fileData = await Deno.readFile(file.path);
				const formData = new FormData();
				const blob = new Blob([fileData], {
					type: "application/octet-stream",
				});
				formData.append("file", blob, file.relativePath);

				const response = await fetch(config.url, {
					method: "POST",
					headers: {
						"Authorization": `Bearer ${config.token}`,
					},
					body: formData,
					signal: controller.signal,
				});

				if (!response.ok) {
					const body = await response.text();
					return {
						success: false,
						sourceFile: file,
						destination,
						error: `HTTP ${response.status}: ${body}`,
						durationMs: performance.now() - start,
					};
				}

				const result = await response.json() as {
					uploaded?: string[];
				};
				const uploaded = result?.uploaded ?? [];

				return {
					success: true,
					sourceFile: file,
					destination: uploaded.length > 0 ? uploaded.join(", ") : destination,
					bytesTransferred: file.size,
					durationMs: performance.now() - start,
				};
			} catch (err) {
				return {
					success: false,
					sourceFile: file,
					destination,
					error: err instanceof Error ? err.message : String(err),
					durationMs: performance.now() - start,
				};
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
