import { assertEquals } from "@std/assert";
import { createStaticUploadServerAdapter } from "../../src/adapters/static-upload-server.ts";
import {
	cleanup,
	createFile,
	createMockUploadServer,
	createTempDir,
} from "../_helpers.ts";
import { join } from "@std/path";
import type { FileInfo } from "../../src/file-finder.ts";

function makeFileInfo(
	dir: string,
	relativePath: string,
	size: number,
): FileInfo {
	return {
		path: join(dir, relativePath),
		relativePath,
		name: relativePath.split("/").pop()!,
		size,
		mtime: new Date(),
	};
}

Deno.test("static-upload-server adapter - uploads file successfully", async () => {
	const srcDir = await createTempDir();
	const token = "test-token-123";
	const mock = createMockUploadServer(token);

	// wait for server to start
	await new Promise((r) => setTimeout(r, 100));

	try {
		const content = "backup data content";
		await createFile(srcDir, "daily/backup.sql.gz", content);

		const adapter = createStaticUploadServerAdapter({
			adapter: "static-upload-server",
			url: mock.url,
			token,
		});

		const fileInfo = makeFileInfo(
			srcDir,
			"daily/backup.sql.gz",
			new TextEncoder().encode(content).length,
		);

		const result = await adapter.transfer(fileInfo);

		assertEquals(result.success, true);
		assertEquals(result.bytesTransferred, fileInfo.size);

		// verify the mock received the upload
		assertEquals(mock.uploads.length, 1);
		assertEquals(mock.uploads[0].filename, "daily/backup.sql.gz");
	} finally {
		mock.close();
		await cleanup(srcDir);
	}
});

Deno.test("static-upload-server adapter - fails with wrong token", async () => {
	const srcDir = await createTempDir();
	const mock = createMockUploadServer("correct-token");

	await new Promise((r) => setTimeout(r, 100));

	try {
		await createFile(srcDir, "backup.sql.gz", "data");

		const adapter = createStaticUploadServerAdapter({
			adapter: "static-upload-server",
			url: mock.url,
			token: "wrong-token",
		});

		const fileInfo = makeFileInfo(srcDir, "backup.sql.gz", 4);
		const result = await adapter.transfer(fileInfo);

		assertEquals(result.success, false);
		assertEquals(result.error?.includes("401"), true);
	} finally {
		mock.close();
		await cleanup(srcDir);
	}
});

Deno.test("static-upload-server adapter - handles connection error", async () => {
	const srcDir = await createTempDir();
	try {
		await createFile(srcDir, "backup.sql.gz", "data");

		const adapter = createStaticUploadServerAdapter({
			adapter: "static-upload-server",
			url: "http://localhost:1", // unlikely port
			token: "token",
			timeout: 2000,
		});

		const fileInfo = makeFileInfo(srcDir, "backup.sql.gz", 4);
		const result = await adapter.transfer(fileInfo);

		assertEquals(result.success, false);
		assertEquals(typeof result.error, "string");
	} finally {
		await cleanup(srcDir);
	}
});

Deno.test("static-upload-server adapter - name is 'static-upload-server'", () => {
	const adapter = createStaticUploadServerAdapter({
		adapter: "static-upload-server",
		url: "https://host",
		token: "t",
	});
	assertEquals(adapter.name, "static-upload-server");
});

Deno.test("static-upload-server adapter - uploads large file without buffering", async () => {
	const srcDir = await createTempDir();
	const token = "t";
	const mock = createMockUploadServer(token);
	await new Promise((r) => setTimeout(r, 100));
	try {
		// 4 MB of pseudo-random bytes (small enough to not blow CI but large
		// enough that buffering would be observable if misimplemented)
		const size = 4 * 1024 * 1024;
		const bytes = new Uint8Array(size);
		for (let i = 0; i < size; i++) bytes[i] = i & 0xff;
		await createFile(srcDir, "big.bin", bytes);

		const adapter = createStaticUploadServerAdapter({
			adapter: "static-upload-server",
			url: mock.url,
			token,
		});

		const fi = makeFileInfo(srcDir, "big.bin", size);
		const result = await adapter.transfer(fi);

		assertEquals(result.success, true);
		assertEquals(mock.uploads[0].size, size);
	} finally {
		mock.close();
		await cleanup(srcDir);
	}
});

Deno.test("static-upload-server adapter - honors external abort signal", async () => {
	const srcDir = await createTempDir();
	const token = "t";
	const mock = createMockUploadServer(token);
	await new Promise((r) => setTimeout(r, 100));
	try {
		await createFile(srcDir, "backup.sql.gz", "data");
		const adapter = createStaticUploadServerAdapter({
			adapter: "static-upload-server",
			url: mock.url,
			token,
		});
		const controller = new AbortController();
		controller.abort();

		const fi = makeFileInfo(srcDir, "backup.sql.gz", 4);
		const result = await adapter.transfer(fi, {
			signal: controller.signal,
		});
		assertEquals(result.success, false);
	} finally {
		mock.close();
		await cleanup(srcDir);
	}
});

Deno.test("static-upload-server adapter - check() reports reachable host", async () => {
	const mock = createMockUploadServer("t");
	await new Promise((r) => setTimeout(r, 100));
	try {
		const adapter = createStaticUploadServerAdapter({
			adapter: "static-upload-server",
			url: mock.url,
			token: "t",
		});
		const check = await adapter.check!();
		assertEquals(check.ok, true);
	} finally {
		mock.close();
	}
});

Deno.test("static-upload-server adapter - check() reports unreachable host", async () => {
	const adapter = createStaticUploadServerAdapter({
		adapter: "static-upload-server",
		url: "http://localhost:1",
		token: "t",
		timeout: 1000,
	});
	const check = await adapter.check!();
	assertEquals(check.ok, false);
});

/** Start a server that answers every upload with a fixed error response. */
function createFailingServer(body: string, status = 500, headers?: HeadersInit) {
	const controller = new AbortController();
	let port = 0;
	const server = Deno.serve(
		{
			signal: controller.signal,
			port: 0,
			onListen: (a) => {
				port = a.port;
			},
		},
		async (req) => {
			// drain the upload so the client sees a real response, not a reset
			await req.arrayBuffer().catch(() => {});
			return new Response(body, { status, headers });
		},
	);
	return {
		get url() {
			return `http://localhost:${port}`;
		},
		async close() {
			controller.abort();
			await server.finished.catch(() => {});
		},
	};
}

Deno.test("static-upload-server adapter - captures full error body in errorDetail", async () => {
	const srcDir = await createTempDir();
	const html = `<html><head><title>500 Internal Server Error</title></head>` +
		`<body>${"x".repeat(2000)}</body></html>`;
	const mock = createFailingServer(html, 500, { "x-request-id": "abc123" });
	await new Promise((r) => setTimeout(r, 100));

	try {
		await createFile(srcDir, "daily/backup.sql.gz", "data");
		const adapter = createStaticUploadServerAdapter({
			adapter: "static-upload-server",
			url: mock.url,
			token: "t",
		});
		const result = await adapter.transfer(
			makeFileInfo(srcDir, "daily/backup.sql.gz", 4),
		);

		assertEquals(result.success, false);

		// the inline error stays short and single-line — it goes to the run log
		assertEquals(result.error!.startsWith("HTTP 500: "), true);
		assertEquals(result.error!.includes("\n"), false);
		assertEquals(result.error!.length < 400, true);

		// ...but nothing is lost: the full body lands in errorDetail
		const detail = result.errorDetail!;
		assertEquals(detail.includes(html), true);
		assertEquals(detail.includes("HTTP 500 Internal Server Error"), true);
		assertEquals(detail.includes("x-request-id: abc123"), true);
		assertEquals(
			detail.includes(`PUT ${mock.url}/daily/backup.sql.gz`),
			true,
		);
		// credentials must never reach a dump file
		assertEquals(detail.toLowerCase().includes("authorization"), false);
	} finally {
		await mock.close();
		await cleanup(srcDir);
	}
});

Deno.test("static-upload-server adapter - short error body is kept inline verbatim", async () => {
	const srcDir = await createTempDir();
	const mock = createFailingServer("Internal Server Error", 500);
	await new Promise((r) => setTimeout(r, 100));

	try {
		await createFile(srcDir, "backup.sql.gz", "data");
		const adapter = createStaticUploadServerAdapter({
			adapter: "static-upload-server",
			url: mock.url,
			token: "t",
		});
		const result = await adapter.transfer(
			makeFileInfo(srcDir, "backup.sql.gz", 4),
		);
		assertEquals(result.success, false);
		assertEquals(result.error, "HTTP 500: Internal Server Error");
		assertEquals(result.errorDetail!.includes("Mode: put"), true);
		assertEquals(result.errorDetail!.includes("4 bytes"), true);
	} finally {
		await mock.close();
		await cleanup(srcDir);
	}
});

Deno.test("static-upload-server adapter - names a timeout as a timeout", async () => {
	const srcDir = await createTempDir();
	const controller = new AbortController();
	let port = 0;
	const server = Deno.serve(
		{
			signal: controller.signal,
			port: 0,
			onListen: (a) => {
				port = a.port;
			},
		},
		async (req) => {
			await req.arrayBuffer().catch(() => {});
			// never answer within the client's timeout
			await new Promise((r) => setTimeout(r, 5000));
			return new Response("too late");
		},
	);
	await new Promise((r) => setTimeout(r, 100));

	try {
		await createFile(srcDir, "backup.sql.gz", "data");
		const adapter = createStaticUploadServerAdapter({
			adapter: "static-upload-server",
			url: `http://localhost:${port}`,
			token: "t",
			timeout: 300,
		});
		const result = await adapter.transfer(
			makeFileInfo(srcDir, "backup.sql.gz", 4),
		);

		assertEquals(result.success, false);
		assertEquals(result.error!.includes("Timed out after 300ms"), true);
		assertEquals(result.errorDetail!.includes("Timed out: yes"), true);
		assertEquals(result.errorDetail!.includes("Externally aborted: no"), true);
	} finally {
		controller.abort();
		await server.finished.catch(() => {});
		await cleanup(srcDir);
	}
});

Deno.test("static-upload-server adapter - PUT mode is the default and streams raw body", async () => {
	const srcDir = await createTempDir();
	const token = "t";
	const mock = createMockUploadServer(token);
	await new Promise((r) => setTimeout(r, 100));

	try {
		const content = "backup data content";
		const size = new TextEncoder().encode(content).length;
		await createFile(srcDir, "daily/backup.sql.gz", content);

		const adapter = createStaticUploadServerAdapter({
			adapter: "static-upload-server",
			url: mock.url,
			token,
			// no `mode` — must default to "put"
		});
		const result = await adapter.transfer(
			makeFileInfo(srcDir, "daily/backup.sql.gz", size),
		);

		assertEquals(result.success, true);
		assertEquals(result.bytesTransferred, size);
		// the relative path became the URL path, and the raw body was the file
		assertEquals(mock.uploads.length, 1);
		assertEquals(mock.uploads[0].via, "put");
		assertEquals(mock.uploads[0].filename, "daily/backup.sql.gz");
		assertEquals(mock.uploads[0].size, size);
		// destination echoes the server's authoritative stored path
		assertEquals(result.destination, "/test/daily/backup.sql.gz");
	} finally {
		mock.close();
		await cleanup(srcDir);
	}
});

Deno.test("static-upload-server adapter - mode='multipart' still POSTs a form", async () => {
	const srcDir = await createTempDir();
	const token = "t";
	const mock = createMockUploadServer(token);
	await new Promise((r) => setTimeout(r, 100));

	try {
		await createFile(srcDir, "daily/backup.sql.gz", "data");
		const adapter = createStaticUploadServerAdapter({
			adapter: "static-upload-server",
			url: mock.url,
			token,
			mode: "multipart",
		});
		const result = await adapter.transfer(
			makeFileInfo(srcDir, "daily/backup.sql.gz", 4),
		);

		assertEquals(result.success, true);
		assertEquals(mock.uploads[0].via, "post");
		assertEquals(mock.uploads[0].filename, "daily/backup.sql.gz");
	} finally {
		mock.close();
		await cleanup(srcDir);
	}
});

Deno.test("static-upload-server adapter - PUT percent-encodes path segments", async () => {
	const srcDir = await createTempDir();
	const token = "t";
	const mock = createMockUploadServer(token);
	await new Promise((r) => setTimeout(r, 100));

	try {
		await createFile(srcDir, "daily/my backup #1.sql.gz", "data");
		const adapter = createStaticUploadServerAdapter({
			adapter: "static-upload-server",
			url: `${mock.url}/`, // trailing slash must not double up
			token,
		});
		const result = await adapter.transfer(
			makeFileInfo(srcDir, "daily/my backup #1.sql.gz", 4),
		);

		assertEquals(result.success, true);
		// the server decodes back to the original name — a raw "#" would have
		// been read as a URL fragment and truncated the path
		assertEquals(mock.uploads[0].filename, "daily/my backup #1.sql.gz");
	} finally {
		mock.close();
		await cleanup(srcDir);
	}
});

Deno.test("static-upload-server adapter - fails the transfer when stored size != sent size", async () => {
	const srcDir = await createTempDir();
	const token = "t";
	// server accepts, but reports storing fewer bytes than we sent — what a
	// connection dropping mid-stream looks like from the client's side
	const mock = createMockUploadServer(token, { forceReportedSize: 9 });
	await new Promise((r) => setTimeout(r, 100));

	try {
		await createFile(srcDir, "backup.sql.gz", "data");
		const adapter = createStaticUploadServerAdapter({
			adapter: "static-upload-server",
			url: mock.url,
			token,
		});
		const result = await adapter.transfer(
			makeFileInfo(srcDir, "backup.sql.gz", 4),
		);

		// a 200 is NOT enough — a truncated upload must not be marked transferred
		assertEquals(result.success, false);
		assertEquals(result.error, "Size mismatch: sent 4 bytes, server stored 9");
		assertEquals(result.errorDetail!.includes("Server stored:  9 bytes"), true);
		assertEquals(result.errorDetail!.includes("Source file is: 4 bytes"), true);
	} finally {
		mock.close();
		await cleanup(srcDir);
	}
});

Deno.test("static-upload-server adapter - explains a 404 from a pre-1.7.0 server", async () => {
	const srcDir = await createTempDir();
	const token = "t";
	const mock = createMockUploadServer(token, { noPutRoute: true });
	await new Promise((r) => setTimeout(r, 100));

	try {
		await createFile(srcDir, "backup.sql.gz", "data");
		const adapter = createStaticUploadServerAdapter({
			adapter: "static-upload-server",
			url: mock.url,
			token,
		});
		const result = await adapter.transfer(
			makeFileInfo(srcDir, "backup.sql.gz", 4),
		);

		assertEquals(result.success, false);
		// a bare "HTTP 404: Not found" would read as a typo'd URL
		assertEquals(result.error!.includes(">= 1.7.0"), true);
		assertEquals(result.error!.includes(`mode = "multipart"`), true);
	} finally {
		mock.close();
		await cleanup(srcDir);
	}
});

Deno.test("static-upload-server adapter - accepts non-JSON 2xx response", async () => {
	const srcDir = await createTempDir();
	const token = "t";
	// a server that returns 200 with plain text
	const controller = new AbortController();
	let port = 0;
	const server = Deno.serve(
		{
			signal: controller.signal,
			port: 0,
			onListen: (a) => {
				port = a.port;
			},
		},
		(req) => {
			if (req.headers.get("Authorization") !== `Bearer ${token}`) {
				return new Response("no", { status: 401 });
			}
			return new Response("OK (not json)", { status: 200 });
		},
	);
	await new Promise((r) => setTimeout(r, 100));
	try {
		await createFile(srcDir, "backup.sql.gz", "data");
		const adapter = createStaticUploadServerAdapter({
			adapter: "static-upload-server",
			url: `http://localhost:${port}`,
			token,
		});
		const fi = makeFileInfo(srcDir, "backup.sql.gz", 4);
		const result = await adapter.transfer(fi);
		assertEquals(result.success, true);
	} finally {
		controller.abort();
		await server.finished.catch(() => {});
		await cleanup(srcDir);
	}
});
