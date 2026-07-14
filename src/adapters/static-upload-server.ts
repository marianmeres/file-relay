import type { FileInfo } from "../file-finder.ts";
import type { StaticUploadMode, StaticUploadServerDestination } from "../config.ts";
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
 * Join the destination base URL with a source-relative path, percent-encoding
 * each segment (but not the separators — the server maps them to directories).
 */
function buildPutUrl(baseUrl: string, relativePath: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	const path = relativePath
		.split("/")
		.filter(Boolean)
		.map(encodeURIComponent)
		.join("/");
	return `${base}/${path}`;
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

/** Upper bound on how much of an error response body we keep, in bytes. */
const MAX_ERROR_BODY = 256 * 1024;

/**
 * Read an error response body defensively: never throws, always returns
 * something printable, and refuses to hold more than {@linkcode MAX_ERROR_BODY}.
 */
async function readErrorBody(
	response: Response,
): Promise<{ text: string; note?: string }> {
	try {
		const text = await response.text();
		if (text.length > MAX_ERROR_BODY) {
			return {
				text: text.slice(0, MAX_ERROR_BODY),
				note: `truncated from ${text.length} to ${MAX_ERROR_BODY} chars`,
			};
		}
		return { text };
	} catch (err) {
		return {
			text: "",
			note: `could not read body: ${
				err instanceof Error ? err.message : String(err)
			}`,
		};
	}
}

/** How much of the response body goes into the short, inline `error` message. */
const MAX_INLINE_BODY = 300;

/**
 * Collapse an error body into a single short line fit for the run log. A server
 * behind a proxy may answer with a full HTML error page; dumping that verbatim
 * into `error` (which ends up in the log and the notification email) drowns the
 * signal. The untruncated body always survives in `errorDetail`.
 */
function summarizeBody(body: string, response: Response): string {
	const flat = body.replace(/\s+/g, " ").trim();
	if (!flat) return response.statusText || "(empty response body)";
	if (flat.length <= MAX_INLINE_BODY) return flat;
	return `${flat.slice(0, MAX_INLINE_BODY)}… (${flat.length} chars, see error dump)`;
}

/** One-line-per-header rendering, sorted for stable diffing between runs. */
function formatHeaders(headers: Headers, indent = "  "): string {
	const entries = [...headers.entries()].sort(([a], [b]) => a.localeCompare(b));
	if (!entries.length) return `${indent}(none)`;
	return entries.map(([k, v]) => `${indent}${k}: ${v}`).join("\n");
}

/** Render a thrown value with its name, stack, and (recursively) its cause. */
function formatThrown(err: unknown, depth = 0): string {
	const indent = "  ".repeat(depth);
	if (!(err instanceof Error)) {
		return `${indent}${String(err)}`;
	}
	const lines = [`${indent}${err.name}: ${err.message}`];
	if (err.stack) {
		lines.push(
			...err.stack.split("\n").slice(1).map((l) => `${indent}${l.trim()}`),
		);
	}
	if (err.cause !== undefined && depth < 3) {
		lines.push(`${indent}Caused by:`);
		lines.push(formatThrown(err.cause, depth + 1));
	}
	return lines.join("\n");
}

/**
 * Create a {@linkcode RelayAdapter} that uploads files to a
 * `@marianmeres/deno-static-upload-server` instance.
 *
 * Files are always streamed from disk — never buffered in memory on this side.
 * With the default `mode: "put"` they are not buffered on the *server* side
 * either (raw-body `PUT`, requires server >= 1.7.0). `mode: "multipart"` is the
 * legacy POST form, kept only for older servers; it makes the server hold the
 * whole file in RAM. See {@linkcode StaticUploadMode}.
 */
export function createStaticUploadServerAdapter(
	config: StaticUploadServerDestination,
): RelayAdapter {
	const timeout = config.timeout ?? 300_000;
	const mode: StaticUploadMode = config.mode ?? "put";

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
			const url = mode === "put"
				? buildPutUrl(config.url, file.relativePath)
				: config.url;
			const method = mode === "put" ? "PUT" : "POST";
			const destination = mode === "put"
				? url
				: `${config.url} -> ${file.relativePath}`;

			const controller = new AbortController();
			// Track *why* we aborted — otherwise a timeout and a caller-issued
			// cancel are indistinguishable in the resulting DOMException.
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, timeout);
			const onExternalAbort = () => {
				controller.abort(options?.signal?.reason);
			};
			options?.signal?.addEventListener("abort", onExternalAbort);

			let fh: Deno.FsFile | null = null;

			/** The request half of a failure dump — identical for both modes. */
			const requestLines = () => [
				`Request:`,
				`  ${method} ${url}`,
				`  Mode: ${mode}`,
				`  Content-Type: ${
					mode === "put" ? "application/octet-stream" : "multipart/form-data"
				}`,
				// Deno's fetch forces chunked encoding on any streamed body and
				// drops Content-Length, so we never declare a length.
				`  Transfer-Encoding: chunked (Deno streams the body)`,
				`  Source file: ${file.path} (${file.size} bytes)`,
			];

			try {
				if (options?.signal?.aborted) {
					throw options.signal.reason ?? new Error("Aborted");
				}

				fh = await Deno.open(file.path, { read: true });

				const headers: Record<string, string> = {
					"Authorization": `Bearer ${config.token}`,
				};
				let body: ReadableStream<Uint8Array>;

				if (mode === "put") {
					// The body IS the file — straight from disk to socket, with
					// no multipart envelope for the server to parse into RAM.
					body = fh.readable;
					headers["Content-Type"] = "application/octet-stream";
				} else {
					const boundary = makeBoundary();
					body = buildMultipartStream(
						fh,
						file.relativePath,
						boundary,
					).body;
					headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
				}

				const response = await fetch(url, {
					method,
					headers,
					body,
					signal: controller.signal,
					// deno-lint-ignore no-explicit-any
					...({ duplex: "half" } as any),
				});

				if (!response.ok) {
					const elapsed = performance.now() - start;
					const { text, note } = await readErrorBody(response);
					// A PUT against a pre-1.7.0 server lands on an unrouted path
					// and 404s, which otherwise reads as a bad URL.
					const hint = mode === "put" && response.status === 404
						? ` — the PUT route requires deno-static-upload-server >= 1.7.0;` +
							` set destination.mode = "multipart" for an older server`
						: "";
					return {
						success: false,
						sourceFile: file,
						destination,
						error: `HTTP ${response.status}: ${
							summarizeBody(text, response)
						}${hint}`,
						errorDetail: [
							...requestLines(),
							``,
							`Response:`,
							`  HTTP ${response.status} ${response.statusText}`,
							`  Elapsed: ${elapsed.toFixed(0)}ms`,
							`  Headers:`,
							formatHeaders(response.headers, "    "),
							``,
							`Response body (${text.length} chars${
								note ? `, ${note}` : ""
							}):`,
							text.length ? text : "  (empty)",
						].join("\n"),
						durationMs: elapsed,
					};
				}

				let uploaded: string[] = [];
				let storedSize: number | undefined;
				try {
					const parsed = await response.json() as {
						uploaded?: string[];
						size?: number;
					};
					uploaded = parsed?.uploaded ?? [];
					if (typeof parsed?.size === "number") storedSize = parsed.size;
				} catch {
					// Server returned 2xx but a non-JSON body. Treat as success
					// — the file was accepted; the server just didn't echo the
					// canonical { uploaded: [...] } envelope.
				}

				// Truncation guard. Deno's fetch strips Content-Length from a
				// streamed body, so the server cannot run its own short-body
				// check — it reports `size` (bytes written) for us to compare.
				// Without this a connection dropping mid-upload would look like
				// success, and the file would be marked transferred for good.
				if (storedSize !== undefined && storedSize !== file.size) {
					const elapsed = performance.now() - start;
					return {
						success: false,
						sourceFile: file,
						destination,
						error: `Size mismatch: sent ${file.size} bytes,` +
							` server stored ${storedSize}`,
						errorDetail: [
							...requestLines(),
							``,
							`Response:`,
							`  HTTP ${response.status} ${response.statusText}`,
							`  Elapsed: ${elapsed.toFixed(0)}ms`,
							`  Server stored:  ${storedSize} bytes`,
							`  Source file is: ${file.size} bytes`,
							``,
							`The upload was accepted but the stored byte count does not`,
							`match the source — the connection most likely dropped`,
							`mid-stream. The file was NOT marked as transferred, so the`,
							`next run will retry it.`,
						].join("\n"),
						durationMs: elapsed,
					};
				}

				return {
					success: true,
					sourceFile: file,
					destination: uploaded.length > 0 ? uploaded.join(", ") : destination,
					bytesTransferred: storedSize ?? file.size,
					durationMs: performance.now() - start,
				};
			} catch (err) {
				const elapsed = performance.now() - start;
				const raw = err instanceof Error ? err.message : String(err);
				// A timeout surfaces as a bare "The signal has been aborted"
				// DOMException — name it, so a 5-minute cutoff on a large upload
				// isn't mistaken for a network fault.
				const error = timedOut
					? `Timed out after ${timeout}ms (${elapsed.toFixed(0)}ms elapsed)` +
						` — see destination.timeout`
					: raw;
				return {
					success: false,
					sourceFile: file,
					destination,
					error,
					errorDetail: [
						...requestLines(),
						``,
						`No response received.`,
						`  Elapsed: ${elapsed.toFixed(0)}ms`,
						`  Configured timeout: ${timeout}ms`,
						`  Timed out: ${timedOut ? "yes" : "no"}`,
						`  Externally aborted: ${
							options?.signal?.aborted ? "yes" : "no"
						}`,
						``,
						`Thrown error:`,
						formatThrown(err, 1),
					].join("\n"),
					durationMs: elapsed,
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
