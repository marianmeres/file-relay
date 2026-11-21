import * as fs from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileRelayConfig } from "../src/config.ts";

/** Create a temp directory and return its path. */
export async function createTempDir(
	prefix = "file-relay-test",
): Promise<string> {
	return await fs.mkdtemp(join(tmpdir(), prefix));
}

/** Create a file in the given directory with the given content. */
export async function createFile(
	dir: string,
	relativePath: string,
	content: Uint8Array | string = "test content",
	mtime?: Date,
): Promise<string> {
	const fullPath = join(dir, relativePath);
	await fs.mkdir(join(fullPath, ".."), { recursive: true });

	await fs.writeFile(fullPath, content);

	if (mtime) {
		await fs.utimes(fullPath, mtime, mtime);
	}

	return fullPath;
}

/** Remove a directory recursively, ignoring errors. */
export async function cleanup(...dirs: string[]): Promise<void> {
	for (const dir of dirs) {
		try {
			await fs.rm(dir, { recursive: true });
		} catch {
			// ignore
		}
	}
}

/** Create a minimal valid config with temp directories. */
export function createTestConfig(
	overrides: Partial<FileRelayConfig> & {
		sourceDir: string;
		destDir?: string;
	},
): FileRelayConfig {
	return {
		logDir: overrides.logDir ?? "/tmp/file-relay-test-logs",
		trackDir: overrides.trackDir ?? "/tmp/file-relay-test-track",
		source: overrides.source ?? {
			dir: overrides.sourceDir,
			glob: "**/*",
			exclude: [],
			followSymlinks: false,
		},
		destination: overrides.destination ?? {
			adapter: "filesystem",
			dir: overrides.destDir ?? "/tmp/file-relay-test-dest",
		},
	};
}

/** Options for {@linkcode serve}, the subset of `Deno.serve`'s the tests use. */
export interface ServeOptions {
	/** Port to listen on; `0` (the default) takes an OS-assigned free port. */
	port?: number;
	/** Aborting it closes the server and every open connection. */
	signal?: AbortSignal;
	/** Called once the server listens, with the port it got. */
	onListen?: (addr: { port: number }) => void;
}

/**
 * The request body as a web stream. Cancelling it discards the rest of the upload
 * but keeps the connection, so the handler can still answer (as with `Deno.serve`);
 * `Readable.toWeb()` would destroy the socket instead.
 */
function requestBody(incoming: IncomingMessage): ReadableStream<Uint8Array> {
	const chunks = incoming[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await chunks.next();
			if (done) controller.close();
			else controller.enqueue(new Uint8Array(value));
		},
		cancel() {
			incoming.removeAllListeners("data");
			incoming.resume();
		},
	});
}

/**
 * A web-standard test server — `(options, Request => Response)`, the shape of
 * `Deno.serve` — over `node:http`, so the mock handlers below stay plain
 * `Request` -> `Response` code and the suite runs on Node and on Deno alike.
 *
 * `req.signal` aborts when the client goes away (as with `Deno.serve`), and
 * `finished` settles once the server is closed.
 */
export function serve(
	options: ServeOptions,
	handler: (req: Request) => Response | Promise<Response>,
): { finished: Promise<void> } {
	const server = createServer(async (incoming, outgoing) => {
		outgoing.on("error", () => {});
		const gone = new AbortController();
		outgoing.on("close", () => {
			if (!outgoing.writableFinished) gone.abort();
		});
		const headers = new Headers();
		for (const [k, v] of Object.entries(incoming.headers)) {
			if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
		}
		const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
		let response: Response;
		try {
			const req = new Request(`http://${incoming.headers.host}${incoming.url}`, {
				method: incoming.method,
				headers,
				signal: gone.signal,
				...(hasBody
					? { body: requestBody(incoming), duplex: "half" }
					: {}),
			} as RequestInit);
			response = await handler(req);
		} catch {
			response = new Response("Internal Server Error", { status: 500 });
		}
		if (outgoing.destroyed) return;
		outgoing.statusCode = response.status;
		outgoing.statusMessage = response.statusText;
		for (const [k, v] of response.headers) outgoing.setHeader(k, v);
		try {
			if (response.body) {
				for await (const chunk of response.body) {
					if (outgoing.destroyed) break;
					outgoing.write(chunk);
				}
			}
		} catch {
			// the client went away mid-response
		}
		outgoing.end();
	});

	const finished = new Promise<void>((resolve) => server.on("close", () => resolve()));
	const close = () => {
		server.close();
		server.closeAllConnections();
	};
	if (options.signal?.aborted) close();
	options.signal?.addEventListener("abort", close, { once: true });

	server.listen(options.port ?? 0, () => {
		const addr = server.address();
		if (addr && typeof addr === "object") options.onListen?.({ port: addr.port });
	});

	return { finished };
}

/** Options for {@linkcode createMockUploadServer}. */
export interface MockUploadServerOptions {
	/**
	 * Simulate a pre-1.7.0 server: no PUT route, so a PUT falls through to 404
	 * exactly as the real one does.
	 */
	noPutRoute?: boolean;
	/**
	 * Report this many bytes stored in the PUT response's `size`, regardless of
	 * what actually arrived. Used to exercise the client's truncation guard.
	 */
	forceReportedSize?: number;
}

/**
 * Start a mock of `@marianmeres/deno-static-upload-server` >= 1.7.0, speaking
 * both upload routes:
 *
 * - `POST /` — legacy `multipart/form-data`, responds `{ uploaded }`
 * - `PUT /<path>` — raw body streamed to nowhere, responds `{ uploaded, size }`
 *
 * `size` on the PUT response is what lets the client detect a truncated upload,
 * since Deno's fetch strips `Content-Length` from streamed bodies.
 */
export function createMockUploadServer(
	token: string,
	options: MockUploadServerOptions = {},
) {
	const uploads: { filename: string; size: number; via: "put" | "post" }[] = [];

	const controller = new AbortController();
	let port = 0;

	const server = serve(
		{
			signal: controller.signal,
			port: 0,
			onListen: (addr) => {
				port = addr.port;
			},
		},
		async (req) => {
			const auth = req.headers.get("Authorization");
			if (auth !== `Bearer ${token}`) {
				await req.body?.cancel().catch(() => {});
				return new Response("Unauthorized", { status: 401 });
			}

			const path = decodeURIComponent(new URL(req.url).pathname).replace(
				/^\/+/,
				"",
			);

			// --- raw-body streaming PUT (the 1.7.0 route) ---
			if (req.method === "PUT") {
				if (options.noPutRoute) {
					await req.body?.cancel().catch(() => {});
					return new Response("Not found", { status: 404 });
				}
				if (!req.body) {
					return new Response("Missing request body", { status: 400 });
				}
				// count the bytes without holding them, like the real server
				let size = 0;
				for await (const chunk of req.body) size += chunk.byteLength;
				uploads.push({ filename: path, size, via: "put" });
				return Response.json({
					uploaded: [`/test/${path}`],
					size: options.forceReportedSize ?? size,
				});
			}

			// --- legacy multipart POST ---
			if (req.method !== "POST") {
				return new Response("Method not allowed", { status: 405 });
			}

			try {
				const formData = await req.formData();
				const uploaded: string[] = [];

				for (const [_key, value] of formData.entries()) {
					if (value instanceof File) {
						const bytes = await value.arrayBuffer();
						uploads.push({
							filename: value.name,
							size: bytes.byteLength,
							via: "post",
						});
						uploaded.push(`/test/${value.name}`);
					}
				}

				if (uploaded.length === 0) {
					return new Response("No files received", {
						status: 400,
					});
				}

				return Response.json({ uploaded });
			} catch {
				return new Response("Invalid form data", { status: 400 });
			}
		},
	);

	return {
		get port() {
			return port;
		},
		get url() {
			return `http://localhost:${port}`;
		},
		uploads,
		server,
		close() {
			controller.abort();
		},
	};
}
