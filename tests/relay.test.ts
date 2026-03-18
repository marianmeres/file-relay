import { assertEquals } from "@std/assert";
import { createClog, createNoopClog } from "@marianmeres/clog";
import { relay } from "../src/relay.ts";
import { cleanup, createFile, createTempDir } from "./_helpers.ts";
import { join } from "@std/path";

// suppress debug output in tests
createClog.global.debug = false;

Deno.test("relay - full flow: find, transfer, track", async () => {
	const srcDir = await createTempDir();
	const destDir = await createTempDir();
	const logDir = await createTempDir();
	const trackDir = await createTempDir();
	try {
		await createFile(srcDir, "daily/pg-001.sql.gz", "data1");
		await createFile(srcDir, "weekly/pg-002.sql.gz", "data2");

		const result = await relay(
			{
				logDir,
				trackDir,
				source: { dir: srcDir, glob: "**/*.sql.gz" },
				destination: { adapter: "filesystem", dir: destDir },
			},
			{ clog: createNoopClog("test") },
		);

		assertEquals(result.success, true);
		assertEquals(result.filesFound, 2);
		assertEquals(result.filesAlreadyTransferred, 0);
		assertEquals(result.transfers.length, 2);
		assertEquals(
			result.transfers.every((t) => t.success),
			true,
		);

		// verify files exist at destination
		const d1 = await Deno.readTextFile(
			join(destDir, "daily/pg-001.sql.gz"),
		);
		assertEquals(d1, "data1");

		const d2 = await Deno.readTextFile(
			join(destDir, "weekly/pg-002.sql.gz"),
		);
		assertEquals(d2, "data2");

		// verify tracker markers exist
		const m1 = await Deno.stat(
			join(trackDir, "daily/pg-001.sql.gz.transferred.json"),
		);
		assertEquals(m1.isFile, true);
	} finally {
		await cleanup(srcDir, destDir, logDir, trackDir);
	}
});

Deno.test("relay - skips already transferred files", async () => {
	const srcDir = await createTempDir();
	const destDir = await createTempDir();
	const logDir = await createTempDir();
	const trackDir = await createTempDir();
	try {
		await createFile(srcDir, "backup.sql.gz", "data");

		const config = {
			logDir,
			trackDir,
			source: {
				dir: srcDir,
				glob: "**/*.sql.gz",
			},
			destination: {
				adapter: "filesystem" as const,
				dir: destDir,
			},
		};

		// first run — should transfer
		const r1 = await relay(config, {
			clog: createNoopClog("test"),
		});
		assertEquals(r1.transfers.length, 1);
		assertEquals(r1.filesAlreadyTransferred, 0);

		// second run — should skip
		const r2 = await relay(config, {
			clog: createNoopClog("test"),
		});
		assertEquals(r2.transfers.length, 0);
		assertEquals(r2.filesAlreadyTransferred, 1);
		assertEquals(r2.success, true);
	} finally {
		await cleanup(srcDir, destDir, logDir, trackDir);
	}
});

Deno.test("relay - dry run does not transfer", async () => {
	const srcDir = await createTempDir();
	const destDir = await createTempDir();
	const logDir = await createTempDir();
	const trackDir = await createTempDir();
	try {
		await createFile(srcDir, "backup.sql.gz", "data");

		const result = await relay(
			{
				logDir,
				trackDir,
				source: { dir: srcDir, glob: "**/*.sql.gz" },
				destination: { adapter: "filesystem", dir: destDir },
			},
			{ dryRun: true, clog: createNoopClog("test") },
		);

		assertEquals(result.success, true);
		assertEquals(result.filesFound, 1);
		assertEquals(result.transfers.length, 0);

		// destination should be empty
		const entries = [];
		for await (const e of Deno.readDir(destDir)) {
			entries.push(e);
		}
		assertEquals(entries.length, 0);
	} finally {
		await cleanup(srcDir, destDir, logDir, trackDir);
	}
});

Deno.test("relay - no files found", async () => {
	const srcDir = await createTempDir();
	const destDir = await createTempDir();
	const logDir = await createTempDir();
	const trackDir = await createTempDir();
	try {
		const result = await relay(
			{
				logDir,
				trackDir,
				source: { dir: srcDir, glob: "**/*.sql.gz" },
				destination: { adapter: "filesystem", dir: destDir },
			},
			{ clog: createNoopClog("test") },
		);

		assertEquals(result.success, true);
		assertEquals(result.filesFound, 0);
		assertEquals(result.transfers.length, 0);
	} finally {
		await cleanup(srcDir, destDir, logDir, trackDir);
	}
});

Deno.test("relay - reports failure when transfer fails", async () => {
	const srcDir = await createTempDir();
	const logDir = await createTempDir();
	const trackDir = await createTempDir();
	try {
		await createFile(srcDir, "backup.sql.gz", "data");

		const result = await relay(
			{
				logDir,
				trackDir,
				source: { dir: srcDir, glob: "**/*.sql.gz" },
				destination: {
					// destination dir doesn't exist and is not writable
					adapter: "filesystem",
					dir: "/nonexistent/path/that/should/fail",
				},
			},
			{ clog: createNoopClog("test") },
		);

		assertEquals(result.success, false);
		assertEquals(result.transfers.length, 1);
		assertEquals(result.transfers[0].success, false);
	} finally {
		await cleanup(srcDir, logDir, trackDir);
	}
});

Deno.test("relay - result has correct timing info", async () => {
	const srcDir = await createTempDir();
	const destDir = await createTempDir();
	const logDir = await createTempDir();
	const trackDir = await createTempDir();
	try {
		await createFile(srcDir, "backup.sql.gz", "data");

		const result = await relay(
			{
				logDir,
				trackDir,
				source: { dir: srcDir, glob: "**/*.sql.gz" },
				destination: { adapter: "filesystem", dir: destDir },
			},
			{ clog: createNoopClog("test") },
		);

		assertEquals(typeof result.startedAt, "string");
		assertEquals(typeof result.finishedAt, "string");
		assertEquals(typeof result.durationMs, "number");
		assertEquals(result.durationMs >= 0, true);
	} finally {
		await cleanup(srcDir, destDir, logDir, trackDir);
	}
});
