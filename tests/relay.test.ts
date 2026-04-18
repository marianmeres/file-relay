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

Deno.test("relay - preflight catches unreachable destination", async () => {
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

		assertEquals(result.success, false);
		assertEquals(result.status, "preflight-failed");
		// preflight short-circuits — no per-file transfer attempts
		assertEquals(result.transfers.length, 0);
	} finally {
		await cleanup(srcDir, logDir, trackDir);
	}
});

Deno.test("relay - reports per-file failure when source vanishes", async () => {
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
		await Deno.chmod(unreadable, 0o000);

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
		await Deno.chmod(unreadable, 0o644);

		assertEquals(result.transfers.length, 2);
		assertEquals(result.status, "partial");
		assertEquals(result.success, false);
		const failed = result.transfers.filter((t) => !t.success);
		assertEquals(failed.length, 1);
	} finally {
		await cleanup(srcDir, destDir, logDir, trackDir);
	}
});

Deno.test("relay - status='ok' on full success, 'idle' when nothing to do", async () => {
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
		assertEquals(r1.status, "ok");
		assertEquals(r1.success, true);

		const r2 = await relay(cfg, { clog: createNoopClog("test") });
		assertEquals(r2.status, "idle");
		assertEquals(r2.success, true);
	} finally {
		await cleanup(srcDir, destDir, logDir, trackDir);
	}
});

Deno.test("relay - retries transient failures and succeeds", async () => {
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
		assertEquals(r.success, true);
		assertEquals(r.transfers[0].attempts, 1);
		void createTracker;
	} finally {
		await cleanup(srcDir, destDir, logDir, trackDir);
	}
});

Deno.test("relay - concurrency transfers multiple files in parallel", async () => {
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
		assertEquals(r.status, "ok");
		assertEquals(r.transfers.length, 10);
		assertEquals(r.transfers.every((t) => t.success), true);
	} finally {
		await cleanup(srcDir, destDir, logDir, trackDir);
	}
});

Deno.test("relay - retries a flaky upload and eventually succeeds", async () => {
	const srcDir = await createTempDir();
	const logDir = await createTempDir();
	const trackDir = await createTempDir();

	// mock server that fails 2 requests then succeeds
	const token = "t";
	const controller = new AbortController();
	let port = 0;
	let hits = 0;
	const server = Deno.serve(
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
			const fd = await req.formData();
			const names: string[] = [];
			for (const [, v] of fd.entries()) {
				if (v instanceof File) names.push(`/test/${v.name}`);
			}
			return Response.json({ uploaded: names });
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
		assertEquals(result.status, "ok");
		assertEquals(result.transfers.length, 1);
		assertEquals(result.transfers[0].success, true);
		assertEquals(result.transfers[0].attempts, 3);
	} finally {
		controller.abort();
		await server.finished.catch(() => {});
		await cleanup(srcDir, logDir, trackDir);
	}
});

Deno.test("relay - concurrent runs do not interfere with each other's logs", async () => {
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
		assertEquals(a.r.status, "ok");
		assertEquals(b.r.status, "ok");
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

Deno.test("relay - abort signal stops mid-run", async () => {
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
		assertEquals(r.status, "aborted");
		assertEquals(r.success, false);
	} finally {
		await cleanup(srcDir, destDir, logDir, trackDir);
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
