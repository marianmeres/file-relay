import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import type { FileRelayConfig } from "../src/config.ts";

/** Create a temp directory and return its path. */
export async function createTempDir(
	prefix = "file-relay-test",
): Promise<string> {
	return await Deno.makeTempDir({ prefix });
}

/** Create a file in the given directory with the given content. */
export async function createFile(
	dir: string,
	relativePath: string,
	content: Uint8Array | string = "test content",
	mtime?: Date,
): Promise<string> {
	const fullPath = join(dir, relativePath);
	await ensureDir(join(fullPath, ".."));

	if (typeof content === "string") {
		await Deno.writeTextFile(fullPath, content);
	} else {
		await Deno.writeFile(fullPath, content);
	}

	if (mtime) {
		await Deno.utime(fullPath, mtime, mtime);
	}

	return fullPath;
}

/** Remove a directory recursively, ignoring errors. */
export async function cleanup(...dirs: string[]): Promise<void> {
	for (const dir of dirs) {
		try {
			await Deno.remove(dir, { recursive: true });
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

/**
 * Start a minimal mock HTTP server that accepts multipart uploads
 * and returns the expected { uploaded: [...] } response.
 */
export function createMockUploadServer(
	token: string,
) {
	const uploads: { filename: string; size: number }[] = [];

	const controller = new AbortController();
	let port = 0;

	const server = Deno.serve(
		{
			signal: controller.signal,
			port: 0,
			onListen: (addr) => {
				port = addr.port;
			},
		},
		async (req) => {
			if (req.method !== "POST") {
				return new Response("Method not allowed", { status: 405 });
			}

			// check auth
			const auth = req.headers.get("Authorization");
			if (auth !== `Bearer ${token}`) {
				return new Response("Unauthorized", { status: 401 });
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
