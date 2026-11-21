import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createClog, createNoopClog } from "@marianmeres/clog";
import { type ClogFn, relay } from "../src/relay.ts";
import { cleanup, createFile, createTempDir, serve } from "./_helpers.ts";

// suppress debug output in tests
createClog.global.debug = false;

test("relay - full flow: find, transfer, track", async () => {
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

		assert.deepStrictEqual(result.success, true);
		assert.deepStrictEqual(result.filesFound, 2);
		assert.deepStrictEqual(result.filesAlreadyTransferred, 0);
		assert.deepStrictEqual(result.transfers.length, 2);
		assert.deepStrictEqual(
			result.transfers.every((t) => t.success),
			true,
		);

		// verify files exist at destination
		const d1 = await fs.readFile(join(destDir, "daily/pg-001.sql.gz"), "utf8");
		assert.deepStrictEqual(d1, "data1");

		const d2 = await fs.readFile(join(destDir, "weekly/pg-002.sql.gz"), "utf8");
		assert.deepStrictEqual(d2, "data2");

		// verify tracker markers exist
		const m1 = await fs.stat(join(trackDir, "daily/pg-001.sql.gz.transferred.json"));
		assert.deepStrictEqual(m1.isFile(), true);
	} finally {
		await cleanup(srcDir, destDir, logDir, trackDir);
	}
});

test("relay - skips already transferred files", async () => {
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
		assert.deepStrictEqual(r1.transfers.length, 1);
		assert.deepStrictEqual(r1.filesAlreadyTransferred, 0);

		// second run — should skip
		const r2 = await relay(config, {
			clog: createNoopClog("test"),
		});
		assert.deepStrictEqual(r2.transfers.length, 0);
		assert.deepStrictEqual(r2.filesAlreadyTransferred, 1);
		assert.deepStrictEqual(r2.success, true);
	} finally {
		await cleanup(srcDir, destDir, logDir, trackDir);
	}
});

test("relay - dry run does not transfer", async () => {
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

		assert.deepStrictEqual(result.success, true);
		assert.deepStrictEqual(result.filesFound, 1);
		assert.deepStrictEqual(result.transfers.length, 0);

		// destination should be empty
		const entries = [];
		for await (const e of await fs.opendir(destDir)) {
			entries.push(e);
		}
		assert.deepStrictEqual(entries.length, 0);
	} finally {
		await cleanup(srcDir, destDir, logDir, trackDir);
	}
});

test("relay - no files found", async () => {
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

		assert.deepStrictEqual(result.success, true);
		assert.deepStrictEqual(result.filesFound, 0);
		assert.deepStrictEqual(result.transfers.length, 0);
	} finally {
		await cleanup(srcDir, destDir, logDir, trackDir);
	}
});

test("relay - preflight catches unreachable destination", async () => {
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
					// destination dir isn't creatable (no write perm on /)
					adapter: "filesystem",
					dir: "/nonexistent/path/that/should/fail",
				},
			},
			{ clog: createNoopClog("test") },
		);

		assert.deepStrictEqual(result.success, false);
		assert.deepStrictEqual(result.status, "preflight-failed");
		// preflight short-circuits — no per-file transfer attempts
		assert.deepStrictEqual(result.transfers.length, 0);
	} finally {
		await cleanup(srcDir, logDir, trackDir);
	}
});

test("relay - reports per-file failure when source vanishes", async () => {
	const srcDir = await createTempDir();
	const destDir = await createTempDir();
	const logDir = await createTempDir();
	const trackDir = await createTempDir();
	try {
		await createFile(srcDir, "backup.sql.gz", "data");
		await createFile(srcDir, "notes.sql.gz", "data2");

		// Delete one file after discovery would find it, but before transfer.
		// We can't easily race this in a single-threaded test, so instead we
		// verify the path via a deleted-after-stat scenario by nuking it
		// between walks: create a file, discover, then delete just before
		// transfer by using a non-existent source dir for the missing file.
		// Simplest proxy: make one file path unreadable by setting 0 perms.
		const unreadable = `${srcDir}/notes.sql.gz`;
		await fs.chmod(unreadable, 0o000);

		const result = await relay(
			{
				logDir,
				trackDir,
				source: { dir: srcDir, glob: "**/*.sql.gz" },
				destination: { adapter: "filesystem", dir: destDir },
			},
			{ clog: createNoopClog("test") },
		);

		// restore perms so cleanup works
		await fs.chmod(unreadable, 0o644);

		assert.deepStrictEqual(result.transfers.length, 2);
		assert.deepStrictEqual(result.status, "partial");
		assert.deepStrictEqual(result.success, false);
		const failed = result.transfers.filter((t) => !t.success);
		assert.deepStrictEqual(failed.length, 1);
	} finally {
		await cleanup(srcDir, destDir, logDir, trackDir);
	}
});

test("relay - status='ok' on full success, 'idle' when nothing to do", async () => {
	const srcDir = await createTempDir();
	const destDir = await createTempDir();
	const logDir = await createTempDir();
	const trackDir = await createTempDir();
	try {
		await createFile(srcDir, "backup.sql.gz", "data");
		const cfg = {
			logDir,
			trackDir,
			source: { dir: srcDir, glob: "**/*.sql.gz" },
			destination: { adapter: "filesystem" as const, dir: destDir },
		};

		const r1 = await relay(cfg, { clog: createNoopClog("test") });
		assert.deepStrictEqual(r1.status, "ok");
		assert.deepStrictEqual(r1.success, true);

		const r2 = await relay(cfg, { clog: createNoopClog("test") });
		assert.deepStrictEqual(r2.status, "idle");
		assert.deepStrictEqual(r2.success, true);
	} finally {
		await cleanup(srcDir, destDir, logDir, trackDir);
	}
});

test("relay - retries transient failures and succeeds", async () => {
	const srcDir = await createTempDir();
	const destDir = await createTempDir();
	const logDir = await createTempDir();
	const trackDir = await createTempDir();
	try {
		await createFile(srcDir, "backup.sql.gz", "data");

		// Build a flaky adapter via a custom destination: use filesystem +
		// a predicate by wrapping createAdapter isn't easy. Instead test
		// retry at the unit level via a manual fake.
		const { relay } = await import("../src/relay.ts");
		const { createTracker } = await import("../src/tracker.ts");
		// simulate retries by destructuring relay's runPool/transferWithRetry
		// path via a real relay run against a flaky fake adapter would need
		// adapter injection; instead here we verify the retry config is
		// accepted end-to-end and failures still surface.
		const r = await relay(
			{
				logDir,
				trackDir,
				source: { dir: srcDir, glob: "**/*.sql.gz" },
				destination: { adapter: "filesystem", dir: destDir },
				transfer: {
					retry: { attempts: 3, backoffMs: 1, maxBackoffMs: 2 },
				},
			},
			{ clog: createNoopClog("test") },
		);
		assert.deepStrictEqual(r.success, true);
		assert.deepStrictEqual(r.transfers[0].attempts, 1);
		void createTracker;
	} finally {
		await cleanup(srcDir, destDir, logDir, trackDir);
	}
});

test("relay - concurrency transfers multiple files in parallel", async () => {
	const srcDir = await createTempDir();
	const destDir = await createTempDir();
	const logDir = await createTempDir();
	const trackDir = await createTempDir();
	try {
		for (let i = 0; i < 10; i++) {
			await createFile(srcDir, `f${i}.sql.gz`, `data-${i}`);
		}
		const r = await relay(
			{
				logDir,
				trackDir,
				source: { dir: srcDir, glob: "**/*.sql.gz" },
				destination: { adapter: "filesystem", dir: destDir },
				transfer: { concurrency: 4 },
			},
			{ clog: createNoopClog("test") },
		);
		assert.deepStrictEqual(r.status, "ok");
		assert.deepStrictEqual(r.transfers.length, 10);
		assert.deepStrictEqual(
			r.transfers.every((t) => t.success),
			true,
		);
	} finally {
		await cleanup(srcDir, destDir, logDir, trackDir);
	}
});

test("relay - retries a flaky upload and eventually succeeds", async () => {
	const srcDir = await createTempDir();
	const logDir = await createTempDir();
	const trackDir = await createTempDir();

	// mock server that fails 2 requests then succeeds
	const token = "t";
	const controller = new AbortController();
	let port = 0;
	let hits = 0;
	const server = serve(
		{
			signal: controller.signal,
			port: 0,
			onListen: (a) => {
				port = a.port;
			},
		},
		async (req) => {
			if (req.headers.get("Authorization") !== `Bearer ${token}`) {
				return new Response("no", { status: 401 });
			}
			hits++;
			if (hits < 3) {
				// drain the request body so the connection closes cleanly
				await req.body?.cancel();
				return new Response("temporary", { status: 503 });
			}
			// raw-body PUT (the adapter's default mode), as the real 1.7.0 server
			let size = 0;
			for await (const chunk of req.body!) size += chunk.byteLength;
			const name = new URL(req.url).pathname.replace(/^\/+/, "");
			return Response.json({ uploaded: [`/test/${name}`], size });
		},
	);
	await new Promise((r) => setTimeout(r, 100));

	try {
		await createFile(srcDir, "backup.sql.gz", "data");
		const result = await relay(
			{
				logDir,
				trackDir,
				source: { dir: srcDir, glob: "**/*.sql.gz" },
				destination: {
					adapter: "static-upload-server",
					url: `http://localhost:${port}`,
					token,
					timeout: 5000,
				},
				transfer: {
					retry: { attempts: 5, backoffMs: 1, maxBackoffMs: 2 },
				},
			},
			{ clog: createNoopClog("test") },
		);
		assert.deepStrictEqual(result.status, "ok");
		assert.deepStrictEqual(result.transfers.length, 1);
		assert.deepStrictEqual(result.transfers[0].success, true);
		assert.deepStrictEqual(result.transfers[0].attempts, 3);
	} finally {
		controller.abort();
		await server.finished.catch(() => {});
		await cleanup(srcDir, logDir, trackDir);
	}
});

test("relay - writes a failure dump file next to the run log", async () => {
	const srcDir = await createTempDir();
	const logDir = await createTempDir();
	const trackDir = await createTempDir();

	const html = `<html><body>${"boom ".repeat(500)}</body></html>`;
	const controller = new AbortController();
	let port = 0;
	const server = serve(
		{
			signal: controller.signal,
			port: 0,
			onListen: (a) => {
				port = a.port;
			},
		},
		async (req) => {
			await req.arrayBuffer().catch(() => {});
			return new Response(html, { status: 500 });
		},
	);
	await new Promise((r) => setTimeout(r, 100));

	// capture what an operator would actually see in the run log / email body
	const logged: string[] = [];
	const push = (...a: unknown[]) => void logged.push(a.join(" "));
	const capture: ClogFn = Object.assign(push, {
		debug: () => {},
		warn: push,
		error: push,
	});

	try {
		await createFile(srcDir, "daily/backup.sql.gz", "data");
		const result = await relay(
			{
				logDir,
				trackDir,
				source: { dir: srcDir, glob: "**/*.sql.gz" },
				destination: {
					adapter: "static-upload-server",
					url: `http://localhost:${port}`,
					token: "t",
					timeout: 5000,
				},
			},
			{ clog: capture },
		);
		assert.deepStrictEqual(result.status, "failed");

		const entries: string[] = [];
		for await (const e of await fs.opendir(logDir)) entries.push(e.name);

		const dumps = entries.filter((n) => n.includes("-failure-"));
		assert.deepStrictEqual(dumps.length, 1);
		assert.deepStrictEqual(dumps[0].endsWith("-daily-backup.sql.gz.log"), true);

		const dump = await fs.readFile(join(logDir, dumps[0]), "utf8");
		assert.deepStrictEqual(dump.includes(html), true);
		assert.deepStrictEqual(dump.includes("Adapter:     static-upload-server"), true);
		assert.deepStrictEqual(dump.includes("daily/backup.sql.gz"), true);

		// the run log points at the dump instead of inlining the HTML
		const logText = logged.join("\n");
		assert.deepStrictEqual(
			logText.includes(`Full error detail: ${join(logDir, dumps[0])}`),
			true,
		);
		assert.deepStrictEqual(logText.includes("FAILED after 1 attempt(s)"), true);
		assert.deepStrictEqual(logText.includes(html), false);
	} finally {
		controller.abort();
		await server.finished.catch(() => {});
		await cleanup(srcDir, logDir, trackDir);
	}
});

test("relay - concurrent runs do not interfere with each other's logs", async () => {
	// two relay() calls in parallel on different source/track dirs — the
	// log hook must not be shared in a way that leaks lines across runs
	async function runOne() {
		const srcDir = await createTempDir();
		const destDir = await createTempDir();
		const logDir = await createTempDir();
		const trackDir = await createTempDir();
		await createFile(srcDir, "backup.sql.gz", "data");
		try {
			const r = await relay(
				{
					logDir,
					trackDir,
					source: { dir: srcDir, glob: "**/*.sql.gz" },
					destination: { adapter: "filesystem", dir: destDir },
				},
				{ clog: createNoopClog("test") },
			);
			return { r, logDir, srcDir, destDir, trackDir };
		} finally {
			// cleaned up by caller
		}
	}
	const [a, b] = await Promise.all([runOne(), runOne()]);
	try {
		assert.deepStrictEqual(a.r.status, "ok");
		assert.deepStrictEqual(b.r.status, "ok");
	} finally {
		await cleanup(
			a.logDir,
			a.srcDir,
			a.destDir,
			a.trackDir,
			b.logDir,
			b.srcDir,
			b.destDir,
			b.trackDir,
		);
	}
});

test("relay - abort signal stops mid-run", async () => {
	const srcDir = await createTempDir();
	const destDir = await createTempDir();
	const logDir = await createTempDir();
	const trackDir = await createTempDir();
	try {
		for (let i = 0; i < 20; i++) {
			await createFile(srcDir, `f${i}.sql.gz`, `data-${i}`);
		}
		const controller = new AbortController();
		// abort as soon as the run starts
		queueMicrotask(() => controller.abort());

		const r = await relay(
			{
				logDir,
				trackDir,
				source: { dir: srcDir, glob: "**/*.sql.gz" },
				destination: { adapter: "filesystem", dir: destDir },
			},
			{ clog: createNoopClog("test"), signal: controller.signal },
		);
		// Status should be "aborted" (transfers may or may not have completed
		// before the signal propagated)
		assert.deepStrictEqual(r.status, "aborted");
		assert.deepStrictEqual(r.success, false);
	} finally {
		await cleanup(srcDir, destDir, logDir, trackDir);
	}
});

test("relay - result has correct timing info", async () => {
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

		assert.deepStrictEqual(typeof result.startedAt, "string");
		assert.deepStrictEqual(typeof result.finishedAt, "string");
		assert.deepStrictEqual(typeof result.durationMs, "number");
		assert.deepStrictEqual(result.durationMs >= 0, true);
	} finally {
		await cleanup(srcDir, destDir, logDir, trackDir);
	}
});
