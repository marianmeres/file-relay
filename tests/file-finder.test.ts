import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { test } from "node:test";
import { findFiles } from "../src/file-finder.ts";
import { cleanup, createFile, createTempDir } from "./_helpers.ts";

test("file-finder - finds files matching glob", async () => {
	const dir = await createTempDir();
	try {
		await createFile(dir, "backup-001.sql.gz", "data1");
		await createFile(dir, "backup-002.sql.gz", "data2");
		await createFile(dir, "readme.txt", "not a backup");

		const files = await findFiles({
			dir,
			glob: "*.sql.gz",
		});

		assert.deepStrictEqual(files.length, 2);
		assert.deepStrictEqual(
			files.every((f) => f.name.endsWith(".sql.gz")),
			true,
		);
	} finally {
		await cleanup(dir);
	}
});

test("file-finder - recursively scans subdirectories", async () => {
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

		assert.deepStrictEqual(files.length, 4);
		// verify relative paths preserve subdirectory structure
		const relPaths = files.map((f) => f.relativePath).sort();
		assert.deepStrictEqual(relPaths, [
			"daily/pg-20260315.sql.gz",
			"daily/pg-20260316.sql.gz",
			"monthly/pg-202603.sql.gz",
			"weekly/pg-202612.sql.gz",
		]);
	} finally {
		await cleanup(dir);
	}
});

test("file-finder - sorts by mtime descending", async () => {
	const dir = await createTempDir();
	try {
		const now = Date.now();
		await createFile(dir, "old.sql.gz", "old", new Date(now - 3000));
		await createFile(dir, "newest.sql.gz", "new", new Date(now));
		await createFile(dir, "mid.sql.gz", "mid", new Date(now - 1000));

		const files = await findFiles({ dir, glob: "*.sql.gz" });

		assert.deepStrictEqual(files.length, 3);
		assert.deepStrictEqual(files[0].name, "newest.sql.gz");
		assert.deepStrictEqual(files[1].name, "mid.sql.gz");
		assert.deepStrictEqual(files[2].name, "old.sql.gz");
	} finally {
		await cleanup(dir);
	}
});

test("file-finder - applies exclude patterns", async () => {
	const dir = await createTempDir();
	try {
		await createFile(dir, "pg-20260318.sql.gz", "real");
		await createFile(dir, "pg-latest.sql.gz", "symlink target");

		const files = await findFiles({
			dir,
			glob: "*.sql.gz",
			exclude: ["*-latest.sql.gz"],
		});

		assert.deepStrictEqual(files.length, 1);
		assert.deepStrictEqual(files[0].name, "pg-20260318.sql.gz");
	} finally {
		await cleanup(dir);
	}
});

test("file-finder - exclude works on relative paths in subdirs", async () => {
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

		assert.deepStrictEqual(files.length, 2);
		assert.deepStrictEqual(
			files.every((f) => !f.name.includes("latest")),
			true,
		);
	} finally {
		await cleanup(dir);
	}
});

test("file-finder - skips symlinks by default", async () => {
	const dir = await createTempDir();
	try {
		await createFile(dir, "real.sql.gz", "data");
		await fs.symlink(`${dir}/real.sql.gz`, `${dir}/link.sql.gz`);

		const files = await findFiles({
			dir,
			glob: "*.sql.gz",
			followSymlinks: false,
		});

		assert.deepStrictEqual(files.length, 1);
		assert.deepStrictEqual(files[0].name, "real.sql.gz");
	} finally {
		await cleanup(dir);
	}
});

test("file-finder - follows symlinks when configured", async () => {
	const dir = await createTempDir();
	try {
		await createFile(dir, "real.sql.gz", "data");
		await fs.symlink(`${dir}/real.sql.gz`, `${dir}/link.sql.gz`);

		const files = await findFiles({
			dir,
			glob: "*.sql.gz",
			followSymlinks: true,
		});

		assert.deepStrictEqual(files.length, 2);
	} finally {
		await cleanup(dir);
	}
});

test("file-finder - returns empty array for empty directory", async () => {
	const dir = await createTempDir();
	try {
		const files = await findFiles({ dir, glob: "**/*" });
		assert.deepStrictEqual(files.length, 0);
	} finally {
		await cleanup(dir);
	}
});

test("file-finder - returns empty when no files match glob", async () => {
	const dir = await createTempDir();
	try {
		await createFile(dir, "readme.txt", "not a backup");

		const files = await findFiles({
			dir,
			glob: "*.sql.gz",
		});

		assert.deepStrictEqual(files.length, 0);
	} finally {
		await cleanup(dir);
	}
});

test("file-finder - FileInfo has correct properties", async () => {
	const dir = await createTempDir();
	try {
		const content = "hello world";
		await createFile(dir, "sub/file.txt", content);

		const files = await findFiles({
			dir,
			glob: "**/*.txt",
		});

		assert.deepStrictEqual(files.length, 1);
		const f = files[0];
		assert.deepStrictEqual(f.name, "file.txt");
		assert.deepStrictEqual(f.relativePath, "sub/file.txt");
		assert.deepStrictEqual(f.path, `${dir}/sub/file.txt`);
		assert.deepStrictEqual(f.size, new TextEncoder().encode(content).length);
		assert.deepStrictEqual(f.mtime instanceof Date, true);
	} finally {
		await cleanup(dir);
	}
});

// ---------------------------------------------------------------------------
// match (regex whitelist) and ignore (regex blacklist)
// ---------------------------------------------------------------------------

test("file-finder - match filters to only matching paths", async () => {
	const dir = await createTempDir();
	try {
		await createFile(dir, "project-a/backup.sql.gz", "a");
		await createFile(dir, "project-b/backup.sql.gz", "b");
		await createFile(dir, "project-a/logs.txt", "c");

		const files = await findFiles({
			dir,
			glob: "**/*",
			match: ["project-a"],
		});

		assert.deepStrictEqual(files.length, 2);
		assert.deepStrictEqual(
			files.every((f) => f.relativePath.includes("project-a")),
			true,
		);
	} finally {
		await cleanup(dir);
	}
});

test("file-finder - ignore excludes matching paths", async () => {
	const dir = await createTempDir();
	try {
		await createFile(dir, "data.sql.gz", "a");
		await createFile(dir, "data.tmp", "b");
		await createFile(dir, "sub/notes.tmp", "c");

		const files = await findFiles({
			dir,
			glob: "**/*",
			ignore: ["\\.tmp$"],
		});

		assert.deepStrictEqual(files.length, 1);
		assert.deepStrictEqual(files[0].name, "data.sql.gz");
	} finally {
		await cleanup(dir);
	}
});

test("file-finder - match with multiple patterns uses OR logic", async () => {
	const dir = await createTempDir();
	try {
		await createFile(dir, "daily/backup.gz", "d");
		await createFile(dir, "weekly/backup.gz", "w");
		await createFile(dir, "monthly/backup.gz", "m");

		const files = await findFiles({
			dir,
			glob: "**/*",
			match: ["^daily", "^weekly"],
		});

		assert.deepStrictEqual(files.length, 2);
		const relPaths = files.map((f) => f.relativePath).sort();
		assert.deepStrictEqual(relPaths, ["daily/backup.gz", "weekly/backup.gz"]);
	} finally {
		await cleanup(dir);
	}
});

test("file-finder - match and ignore combined", async () => {
	const dir = await createTempDir();
	try {
		await createFile(dir, "proj/real.sql.gz", "a");
		await createFile(dir, "proj/latest.sql.gz", "b");
		await createFile(dir, "other/real.sql.gz", "c");

		const files = await findFiles({
			dir,
			glob: "**/*",
			match: ["proj"],
			ignore: ["latest"],
		});

		assert.deepStrictEqual(files.length, 1);
		assert.deepStrictEqual(files[0].relativePath, "proj/real.sql.gz");
	} finally {
		await cleanup(dir);
	}
});

test("file-finder - match and ignore work alongside glob and exclude", async () => {
	const dir = await createTempDir();
	try {
		await createFile(dir, "daily/backup.sql.gz", "a");
		await createFile(dir, "daily/notes.txt", "b");
		await createFile(dir, "weekly/backup.sql.gz", "c");

		const files = await findFiles({
			dir,
			glob: "**/*.sql.gz",
			match: ["daily"],
		});

		assert.deepStrictEqual(files.length, 1);
		assert.deepStrictEqual(files[0].relativePath, "daily/backup.sql.gz");
	} finally {
		await cleanup(dir);
	}
});

test("file-finder - terminates on symlink cycles when following", async () => {
	const dir = await createTempDir();
	try {
		await createFile(dir, "real.sql.gz", "data");
		// create a cycle: a directory that symlinks to its parent
		await fs.mkdir(`${dir}/sub`);
		await fs.symlink(dir, `${dir}/sub/loop`);

		const files = await findFiles({
			dir,
			glob: "**/*.sql.gz",
			followSymlinks: true,
		});

		// must not hang / stack-overflow; we just care that it returned
		// and that real.sql.gz is present (possibly multiple times via
		// the symlink — ok as long as it terminates)
		assert.deepStrictEqual(
			files.some((f) => f.relativePath === "real.sql.gz"),
			true,
		);
	} finally {
		await cleanup(dir);
	}
});

test("file-finder - empty match array means no regex include filtering", async () => {
	const dir = await createTempDir();
	try {
		await createFile(dir, "a.txt", "a");
		await createFile(dir, "b.txt", "b");

		const files = await findFiles({
			dir,
			glob: "**/*",
			match: [],
		});

		assert.deepStrictEqual(files.length, 2);
	} finally {
		await cleanup(dir);
	}
});
