import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createTracker } from "../src/tracker.ts";
import { cleanup, createTempDir } from "./_helpers.ts";

test("tracker - isTransferred returns false for untracked file", async () => {
	const dir = await createTempDir();
	try {
		const tracker = createTracker(dir);
		assert.deepStrictEqual(await tracker.isTransferred("daily/backup.sql.gz"), false);
	} finally {
		await cleanup(dir);
	}
});

test("tracker - markTransferred creates marker file", async () => {
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
		const markerPath = join(dir, "daily/backup.sql.gz.transferred.json");
		const stat = await fs.stat(markerPath);
		assert.deepStrictEqual(stat.isFile(), true);

		// verify content
		const content = JSON.parse(await fs.readFile(markerPath, "utf8"));
		assert.deepStrictEqual(content.sourcePath, "/data/backups/daily/backup.sql.gz");
		assert.deepStrictEqual(content.sourceSize, 1024);
	} finally {
		await cleanup(dir);
	}
});

test("tracker - isTransferred returns true after markTransferred", async () => {
	const dir = await createTempDir();
	try {
		const tracker = createTracker(dir);
		const rel = "weekly/pg-202612.sql.gz";

		assert.deepStrictEqual(await tracker.isTransferred(rel), false);

		await tracker.markTransferred(rel, {
			transferredAt: new Date().toISOString(),
			sourcePath: `/data/backups/${rel}`,
			sourceSize: 2048,
			destinationInfo: "test",
		});

		assert.deepStrictEqual(await tracker.isTransferred(rel), true);
	} finally {
		await cleanup(dir);
	}
});

test("tracker - creates subdirectory structure automatically", async () => {
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
		const stat = await fs.stat(marker);
		assert.deepStrictEqual(stat.isFile(), true);
	} finally {
		await cleanup(dir);
	}
});

test("tracker - sweepTmp removes stale .tmp markers", async () => {
	const dir = await createTempDir();
	try {
		const tracker = createTracker(dir);

		// write a valid marker
		await tracker.markTransferred("keep/file.gz", {
			transferredAt: new Date().toISOString(),
			sourcePath: "/src/keep/file.gz",
			sourceSize: 10,
			destinationInfo: "x",
		});

		// plant a stale .tmp marker
		await fs.mkdir(join(dir, "stale"), { recursive: true });
		await fs.writeFile(join(dir, "stale/file.gz.transferred.json.tmp"), "{}");
		await fs.writeFile(join(dir, "keep/file.gz.transferred.json.tmp"), "{}");

		const removed = await tracker.sweepTmp();
		assert.deepStrictEqual(removed, 2);

		// valid marker should still exist
		const stat = await fs.stat(join(dir, "keep/file.gz.transferred.json"));
		assert.deepStrictEqual(stat.isFile(), true);

		// stale .tmp files should be gone
		let stillExists = false;
		try {
			await fs.stat(join(dir, "stale/file.gz.transferred.json.tmp"));
			stillExists = true;
		} catch {
			// expected
		}
		assert.deepStrictEqual(stillExists, false);
	} finally {
		await cleanup(dir);
	}
});

test("tracker - sweepTmp tolerates missing trackDir", async () => {
	const tracker = createTracker("/nonexistent/path/for/sweep");
	const removed = await tracker.sweepTmp();
	assert.deepStrictEqual(removed, 0);
});

test("tracker - different relative paths tracked independently", async () => {
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

		assert.deepStrictEqual(await tracker.isTransferred("daily/file.gz"), true);
		assert.deepStrictEqual(await tracker.isTransferred("weekly/file.gz"), true);
		assert.deepStrictEqual(await tracker.isTransferred("monthly/file.gz"), false);
	} finally {
		await cleanup(dir);
	}
});
