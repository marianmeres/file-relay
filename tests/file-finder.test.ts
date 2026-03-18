import { assertEquals } from "@std/assert";
import { findFiles } from "../src/file-finder.ts";
import { cleanup, createFile, createTempDir } from "./_helpers.ts";

Deno.test("file-finder - finds files matching glob", async () => {
	const dir = await createTempDir();
	try {
		await createFile(dir, "backup-001.sql.gz", "data1");
		await createFile(dir, "backup-002.sql.gz", "data2");
		await createFile(dir, "readme.txt", "not a backup");

		const files = await findFiles({
			dir,
			glob: "*.sql.gz",
		});

		assertEquals(files.length, 2);
		assertEquals(
			files.every((f) => f.name.endsWith(".sql.gz")),
			true,
		);
	} finally {
		await cleanup(dir);
	}
});

Deno.test("file-finder - recursively scans subdirectories", async () => {
	const dir = await createTempDir();
	try {
		await createFile(dir, "daily/pg-20260315.sql.gz", "d1");
		await createFile(dir, "daily/pg-20260316.sql.gz", "d2");
		await createFile(dir, "weekly/pg-202612.sql.gz", "w1");
		await createFile(dir, "monthly/pg-202603.sql.gz", "m1");

		const files = await findFiles({
			dir,
			glob: "**/*.sql.gz",
		});

		assertEquals(files.length, 4);
		// verify relative paths preserve subdirectory structure
		const relPaths = files.map((f) => f.relativePath).sort();
		assertEquals(relPaths, [
			"daily/pg-20260315.sql.gz",
			"daily/pg-20260316.sql.gz",
			"monthly/pg-202603.sql.gz",
			"weekly/pg-202612.sql.gz",
		]);
	} finally {
		await cleanup(dir);
	}
});

Deno.test("file-finder - sorts by mtime descending", async () => {
	const dir = await createTempDir();
	try {
		const now = Date.now();
		await createFile(
			dir,
			"old.sql.gz",
			"old",
			new Date(now - 3000),
		);
		await createFile(
			dir,
			"newest.sql.gz",
			"new",
			new Date(now),
		);
		await createFile(
			dir,
			"mid.sql.gz",
			"mid",
			new Date(now - 1000),
		);

		const files = await findFiles({ dir, glob: "*.sql.gz" });

		assertEquals(files.length, 3);
		assertEquals(files[0].name, "newest.sql.gz");
		assertEquals(files[1].name, "mid.sql.gz");
		assertEquals(files[2].name, "old.sql.gz");
	} finally {
		await cleanup(dir);
	}
});

Deno.test("file-finder - applies exclude patterns", async () => {
	const dir = await createTempDir();
	try {
		await createFile(dir, "pg-20260318.sql.gz", "real");
		await createFile(dir, "pg-latest.sql.gz", "symlink target");

		const files = await findFiles({
			dir,
			glob: "*.sql.gz",
			exclude: ["*-latest.sql.gz"],
		});

		assertEquals(files.length, 1);
		assertEquals(files[0].name, "pg-20260318.sql.gz");
	} finally {
		await cleanup(dir);
	}
});

Deno.test("file-finder - exclude works on relative paths in subdirs", async () => {
	const dir = await createTempDir();
	try {
		await createFile(dir, "daily/pg-20260318.sql.gz", "real");
		await createFile(dir, "daily/pg-latest.sql.gz", "skip");
		await createFile(dir, "weekly/pg-202612.sql.gz", "real");
		await createFile(dir, "weekly/pg-latest.sql.gz", "skip");

		const files = await findFiles({
			dir,
			glob: "**/*.sql.gz",
			exclude: ["**/*-latest.sql.gz"],
		});

		assertEquals(files.length, 2);
		assertEquals(
			files.every((f) => !f.name.includes("latest")),
			true,
		);
	} finally {
		await cleanup(dir);
	}
});

Deno.test("file-finder - skips symlinks by default", async () => {
	const dir = await createTempDir();
	try {
		await createFile(dir, "real.sql.gz", "data");
		await Deno.symlink(
			`${dir}/real.sql.gz`,
			`${dir}/link.sql.gz`,
		);

		const files = await findFiles({
			dir,
			glob: "*.sql.gz",
			followSymlinks: false,
		});

		assertEquals(files.length, 1);
		assertEquals(files[0].name, "real.sql.gz");
	} finally {
		await cleanup(dir);
	}
});

Deno.test("file-finder - follows symlinks when configured", async () => {
	const dir = await createTempDir();
	try {
		await createFile(dir, "real.sql.gz", "data");
		await Deno.symlink(
			`${dir}/real.sql.gz`,
			`${dir}/link.sql.gz`,
		);

		const files = await findFiles({
			dir,
			glob: "*.sql.gz",
			followSymlinks: true,
		});

		assertEquals(files.length, 2);
	} finally {
		await cleanup(dir);
	}
});

Deno.test("file-finder - returns empty array for empty directory", async () => {
	const dir = await createTempDir();
	try {
		const files = await findFiles({ dir, glob: "**/*" });
		assertEquals(files.length, 0);
	} finally {
		await cleanup(dir);
	}
});

Deno.test("file-finder - returns empty when no files match glob", async () => {
	const dir = await createTempDir();
	try {
		await createFile(dir, "readme.txt", "not a backup");

		const files = await findFiles({
			dir,
			glob: "*.sql.gz",
		});

		assertEquals(files.length, 0);
	} finally {
		await cleanup(dir);
	}
});

Deno.test("file-finder - FileInfo has correct properties", async () => {
	const dir = await createTempDir();
	try {
		const content = "hello world";
		await createFile(dir, "sub/file.txt", content);

		const files = await findFiles({
			dir,
			glob: "**/*.txt",
		});

		assertEquals(files.length, 1);
		const f = files[0];
		assertEquals(f.name, "file.txt");
		assertEquals(f.relativePath, "sub/file.txt");
		assertEquals(f.path, `${dir}/sub/file.txt`);
		assertEquals(f.size, new TextEncoder().encode(content).length);
		assertEquals(f.mtime instanceof Date, true);
	} finally {
		await cleanup(dir);
	}
});
