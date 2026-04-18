import type { FileInfo } from "../file-finder.ts";
import type { StaticUploadServerDestination } from "../config.ts";
import type {
	CheckResult,
	RelayAdapter,
	TransferOptions,
	TransferResult,
} from "./adapter.ts";

/** Escape quotes and CR/LF in a multipart `filename` header parameter. */
function escapeFilename(name: string): string {
	return name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
		.replace(/\r/g, "").replace(/\n/g, "");
}

/** Build a unique multipart boundary string. */
function makeBoundary(): string {
	const rand = crypto.getRandomValues(new Uint8Array(16));
	const hex = [...rand].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `----file-relay-${hex}`;
}

/**
 * Build a ReadableStream that emits a single-file `multipart/form-data` body
 * without buffering the file contents in memory.
 */
function buildMultipartStream(
	file: Deno.FsFile,
	filename: string,
	boundary: string,
): {
	body: ReadableStream<Uint8Array>;
	contentLength: number;
	header: Uint8Array;
	footer: Uint8Array;
} {
	const enc = new TextEncoder();
	const headerStr = `--${boundary}\r\n` +
		`Content-Disposition: form-data; name="file"; filename="${
			escapeFilename(filename)
		}"\r\n` +
		`Content-Type: application/octet-stream\r\n\r\n`;
	const footerStr = `\r\n--${boundary}--\r\n`;
	const header = enc.encode(headerStr);
	const footer = enc.encode(footerStr);

	const fileStream = file.readable;
	const reader = fileStream.getReader();

	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(header);
		},
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) {
				controller.enqueue(footer);
				controller.close();
				return;
			}
			controller.enqueue(value);
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason);
			} catch {
				// ignore
			}
		},
	});

	return { body, contentLength: 0, header, footer };
}

/**
 * Create a {@linkcode RelayAdapter} that uploads files via HTTP multipart POST
 * to a `@marianmeres/deno-static-upload-server` instance. Files are streamed
 * to the server — they are not buffered in memory.
 */
export function createStaticUploadServerAdapter(
	config: StaticUploadServerDestination,
): RelayAdapter {
	const timeout = config.timeout ?? 300_000;

	return {
		name: "static-upload-server",

		async check(): Promise<CheckResult> {
			// We can't know a specific health endpoint; just verify the URL
			// parses and the host resolves / accepts a TCP connection by
			// issuing a HEAD request. A 2xx/3xx/4xx all count as "reachable".
			// A network error is the only fatal case.
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 10_000);
			try {
				const res = await fetch(config.url, {
					method: "HEAD",
					signal: controller.signal,
				});
				// drain body if any (HEAD shouldn't have one)
				try {
					await res.body?.cancel();
				} catch {
					// ignore
				}
				return { ok: true };
			} catch (err) {
				return {
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				};
			} finally {
				clearTimeout(timer);
			}
		},

		async transfer(
			file: FileInfo,
			options?: TransferOptions,
		): Promise<TransferResult> {
			const start = performance.now();
			const destination = `${config.url} -> ${file.relativePath}`;

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeout);
			const onExternalAbort = () => {
				controller.abort(options?.signal?.reason);
			};
			options?.signal?.addEventListener("abort", onExternalAbort);

			let fh: Deno.FsFile | null = null;

			try {
				if (options?.signal?.aborted) {
					throw options.signal.reason ?? new Error("Aborted");
				}

				fh = await Deno.open(file.path, { read: true });
				const boundary = makeBoundary();
				const { body, header, footer } = buildMultipartStream(
					fh,
					file.relativePath,
					boundary,
				);
				const contentLength = header.byteLength + file.size +
					footer.byteLength;

				const response = await fetch(config.url, {
					method: "POST",
					headers: {
						"Authorization": `Bearer ${config.token}`,
						"Content-Type": `multipart/form-data; boundary=${boundary}`,
						"Content-Length": String(contentLength),
					},
					body,
					signal: controller.signal,
					// deno-lint-ignore no-explicit-any
					...({ duplex: "half" } as any),
				});

				if (!response.ok) {
					const body = await response.text().catch(() => "");
					return {
						success: false,
						sourceFile: file,
						destination,
						error: `HTTP ${response.status}: ${body}`,
						durationMs: performance.now() - start,
					};
				}

				let uploaded: string[] = [];
				try {
					const parsed = await response.json() as {
						uploaded?: string[];
					};
					uploaded = parsed?.uploaded ?? [];
				} catch {
					// Server returned 2xx but a non-JSON body. Treat as success
					// — the file was accepted; the server just didn't echo the
					// canonical { uploaded: [...] } envelope.
				}

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
				options?.signal?.removeEventListener("abort", onExternalAbort);
				// fh.readable auto-closes on stream completion, but close it
				// defensively if the stream never started or was cancelled.
				try {
					fh?.close();
				} catch {
					// already closed
				}
			}
		},
	};
}
