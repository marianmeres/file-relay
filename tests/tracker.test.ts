import { assertEquals } from "@std/assert";
import { createTracker } from "../src/tracker.ts";
import { cleanup, createTempDir } from "./_helpers.ts";
import { join } from "@std/path";

Deno.test("tracker - isTransferred returns false for untracked file", async () => {
	const dir = await createTempDir();
	try {
		const tracker = createTracker(dir);
		assertEquals(
			await tracker.isTransferred("daily/backup.sql.gz"),
			false,
		);
	} finally {
		await cleanup(dir);
	}
});

Deno.test("tracker - markTransferred creates marker file", async () => {
	const dir = await createTempDir();
	try {
		const tracker = createTracker(dir);
		await tracker.markTransferred("daily/backup.sql.gz", {
			transferredAt: "2026-03-18T10:00:00Z",
			sourcePath: "/data/backups/daily/backup.sql.gz",
			sourceSize: 1024,
			destinationInfo: "https://host/backups -> daily/backup.sql.gz",
		});

		// marker file should exist
		const markerPath = join(
			dir,
			"daily/backup.sql.gz.transferred.json",
		);
		const stat = await Deno.stat(markerPath);
		assertEquals(stat.isFile, true);

		// verify content
		const content = JSON.parse(
			await Deno.readTextFile(markerPath),
		);
		assertEquals(content.sourcePath, "/data/backups/daily/backup.sql.gz");
		assertEquals(content.sourceSize, 1024);
	} finally {
		await cleanup(dir);
	}
});

Deno.test("tracker - isTransferred returns true after markTransferred", async () => {
	const dir = await createTempDir();
	try {
		const tracker = createTracker(dir);
		const rel = "weekly/pg-202612.sql.gz";

		assertEquals(await tracker.isTransferred(rel), false);

		await tracker.markTransferred(rel, {
			transferredAt: new Date().toISOString(),
			sourcePath: `/data/backups/${rel}`,
			sourceSize: 2048,
			destinationInfo: "test",
		});

		assertEquals(await tracker.isTransferred(rel), true);
	} finally {
		await cleanup(dir);
	}
});

Deno.test("tracker - creates subdirectory structure automatically", async () => {
	const dir = await createTempDir();
	try {
		const tracker = createTracker(dir);

		// deep nested path
		await tracker.markTransferred("a/b/c/file.gz", {
			transferredAt: new Date().toISOString(),
			sourcePath: "/src/a/b/c/file.gz",
			sourceSize: 100,
			destinationInfo: "test",
		});

		const marker = join(dir, "a/b/c/file.gz.transferred.json");
		const stat = await Deno.stat(marker);
		assertEquals(stat.isFile, true);
	} finally {
		await cleanup(dir);
	}
});

Deno.test("tracker - different relative paths tracked independently", async () => {
	const dir = await createTempDir();
	try {
		const tracker = createTracker(dir);
		const meta = {
			transferredAt: new Date().toISOString(),
			sourcePath: "/src",
			sourceSize: 100,
			destinationInfo: "test",
		};

		await tracker.markTransferred("daily/file.gz", meta);
		await tracker.markTransferred("weekly/file.gz", meta);

		assertEquals(
			await tracker.isTransferred("daily/file.gz"),
			true,
		);
		assertEquals(
			await tracker.isTransferred("weekly/file.gz"),
			true,
		);
		assertEquals(
			await tracker.isTransferred("monthly/file.gz"),
			false,
		);
	} finally {
		await cleanup(dir);
	}
});
