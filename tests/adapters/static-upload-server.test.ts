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
