import { assertEquals } from "@std/assert";
import { createFilesystemAdapter } from "../../src/adapters/filesystem.ts";
import { cleanup, createFile, createTempDir } from "../_helpers.ts";
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

Deno.test("filesystem adapter - copies file to destination", async () => {
	const srcDir = await createTempDir();
	const destDir = await createTempDir();
	try {
		const content = "backup data here";
		await createFile(srcDir, "backup.sql.gz", content);

		const adapter = createFilesystemAdapter({
			adapter: "filesystem",
			dir: destDir,
		});

		const fileInfo = makeFileInfo(
			srcDir,
			"backup.sql.gz",
			new TextEncoder().encode(content).length,
		);

		const result = await adapter.transfer(fileInfo);

		assertEquals(result.success, true);
		assertEquals(result.bytesTransferred, fileInfo.size);

		// verify file exists at destination
		const destContent = await Deno.readTextFile(
			join(destDir, "backup.sql.gz"),
		);
		assertEquals(destContent, content);
	} finally {
		await cleanup(srcDir, destDir);
	}
});

Deno.test("filesystem adapter - creates subdirectories", async () => {
	const srcDir = await createTempDir();
	const destDir = await createTempDir();
	try {
		const content = "nested backup";
		await createFile(srcDir, "daily/pg-20260318.sql.gz", content);

		const adapter = createFilesystemAdapter({
			adapter: "filesystem",
			dir: destDir,
		});

		const fileInfo = makeFileInfo(
			srcDir,
			"daily/pg-20260318.sql.gz",
			new TextEncoder().encode(content).length,
		);

		const result = await adapter.transfer(fileInfo);

		assertEquals(result.success, true);

		const destContent = await Deno.readTextFile(
			join(destDir, "daily/pg-20260318.sql.gz"),
		);
		assertEquals(destContent, content);
	} finally {
		await cleanup(srcDir, destDir);
	}
});

Deno.test("filesystem adapter - reports error for missing source", async () => {
	const destDir = await createTempDir();
	try {
		const adapter = createFilesystemAdapter({
			adapter: "filesystem",
			dir: destDir,
		});

		const fileInfo = makeFileInfo(
			"/nonexistent",
			"missing.sql.gz",
			100,
		);

		const result = await adapter.transfer(fileInfo);

		assertEquals(result.success, false);
		assertEquals(typeof result.error, "string");
	} finally {
		await cleanup(destDir);
	}
});

Deno.test("filesystem adapter - name is 'filesystem'", () => {
	const adapter = createFilesystemAdapter({
		adapter: "filesystem",
		dir: "/tmp",
	});
	assertEquals(adapter.name, "filesystem");
});
