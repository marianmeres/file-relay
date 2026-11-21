// End-to-end: spawn the CLI and check its stream contract and exit codes, through
// what the unit tests never reach — argument parsing, the config file and the
// process env, signal handling, and that the process exits on its own when done.
//
// The CLI runs on Node from source (src/bin.ts, the npm bin). `CLI_RUNTIME=deno` runs
// src/cli.ts on Deno instead (`pnpm run test:deno`): the JSR entry, as
// `deno run -A jsr:@marianmeres/file-relay` executes it.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanup, createFile, createTempDir, serve } from "./_helpers.ts";

const path = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/** How the CLI is started: Node by default, Deno under `CLI_RUNTIME=deno`. */
const CLI_ARGV: [string, ...string[]] =
	process.env.CLI_RUNTIME === "deno"
		? [
				"deno",
				"run",
				"-A",
				"--no-lock",
				"--config",
				path("../jsr.json"),
				path("../src/cli.ts"),
			]
		: [process.execPath, path("../src/bin.ts")];

interface CliRun {
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Runs the CLI to completion. `onStart` gets the child process (to signal it);
 * `env` is merged over the caller's environment.
 */
function cli(
	args: string[],
	opts: {
		env?: Record<string, string>;
		onStart?: (child: ReturnType<typeof spawn>) => void;
	} = {},
): Promise<CliRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(CLI_ARGV[0], [...CLI_ARGV.slice(1), ...args], {
			cwd: work,
			env: { ...process.env, ...opts.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (c: string) => {
			stdout += c;
		});
		child.stderr.setEncoding("utf8").on("data", (c: string) => {
			stderr += c;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
		opts.onStart?.(child);
	});
}

/** A scratch cwd per file; each test writes its own config into it. */
let work: string;
before(async () => {
	work = await createTempDir("file-relay-e2e-");
});
after(async () => {
	await cleanup(work);
});

/** Writes `config` as JSON into a fresh dir under `work`, returns its path. */
async function writeConfig(name: string, config: unknown): Promise<string> {
	const dir = join(work, name);
	await fs.mkdir(dir, { recursive: true });
	const file = join(dir, "config.json");
	await fs.writeFile(file, JSON.stringify(config, null, "\t"));
	return file;
}

test("--version prints the package version, exit 0", async () => {
	const pkg = JSON.parse(await fs.readFile(path("../package.json"), "utf8"));
	assert.deepStrictEqual(await cli(["--version"]), {
		code: 0,
		stdout: `${pkg.version}\n`,
		stderr: "",
	});
});

test("--help prints usage to stdout, exit 0", async () => {
	const r = await cli(["--help"]);
	assert.equal(r.code, 0);
	assert.match(r.stdout, /Usage:\n {2}file-relay <config\.json> \[options\]/);
	assert.equal(r.stderr, "");
});

test("usage errors exit 2 with the reason on stderr", async () => {
	const none = await cli([]);
	assert.equal(none.code, 2);
	assert.match(none.stderr, /config file path is required/);
	assert.match(none.stdout, /Usage:/);

	const unknown = await cli(["config.json", "--bogus"]);
	assert.equal(unknown.code, 2);
	assert.match(unknown.stderr, /Unknown option: --bogus/);

	const zero = await cli(["config.json", "--concurrency=0"]);
	assert.equal(zero.code, 2);
	assert.match(zero.stderr, /--concurrency must be a positive integer/);

	const extra = await cli(["a.json", "b.json"]);
	assert.equal(extra.code, 2);
	assert.match(extra.stderr, /Unexpected argument: b\.json/);
});

test("an unreadable config is a config error, exit 2", async () => {
	const missing = await cli(["does-not-exist.json"]);
	assert.equal(missing.code, 2);
	assert.match(missing.stderr, /^Config error: /);

	const unset = await writeConfig("unset-env", {
		logDir: "./log",
		trackDir: "./track",
		source: { dir: "./source" },
		destination: { adapter: "filesystem", dir: "${FILE_RELAY_E2E_UNSET}" },
	});
	const r = await cli([unset]);
	assert.equal(r.code, 2);
	assert.match(r.stderr, /Config error: Environment variable "FILE_RELAY_E2E_UNSET"/);
});

test("filesystem relay: copies, tracks, logs; the second run has nothing to do", async () => {
	const dest = await createTempDir("file-relay-e2e-dest-");
	try {
		const config = await writeConfig("fs", {
			logDir: "./log",
			trackDir: "./track",
			source: { dir: "./source", glob: "**/*.sql.gz" },
			destination: { adapter: "filesystem", dir: "${FILE_RELAY_E2E_DEST}" },
		});
		const dir = join(config, "..");
		await createFile(dir, "source/daily/a.sql.gz", "aaa");
		await createFile(dir, "source/skip.txt", "not matched");
		const env = { FILE_RELAY_E2E_DEST: dest };

		const first = await cli([config], { env });
		assert.equal(first.code, 0, first.stderr);
		assert.match(first.stdout, /Found 1 file\(s\) matching criteria/);
		assert.equal(await fs.readFile(join(dest, "daily/a.sql.gz"), "utf8"), "aaa");
		assert.ok(
			(await fs.stat(join(dir, "track/daily/a.sql.gz.transferred.json"))).isFile(),
		);
		const logs = await fs.readdir(join(dir, "log"));
		assert.equal(logs.filter((f) => /^file-relay-.*\.log$/.test(f)).length, 1);

		const second = await cli([config], { env });
		assert.equal(second.code, 0, second.stderr);
		assert.match(second.stdout, /No new files to transfer/);
	} finally {
		await cleanup(dest);
	}
});

test("a failed preflight exits 1", async () => {
	const config = await writeConfig("preflight", {
		logDir: "./log",
		trackDir: "./track",
		source: { dir: "./source" },
		// a file where the destination directory should be
		destination: { adapter: "filesystem", dir: "./config.json" },
	});
	await createFile(join(config, ".."), "source/a.txt", "a");
	const r = await cli([config]);
	assert.equal(r.code, 1, r.stderr);
});

test("upload relay: streams to the server, then the process exits on its own", async () => {
	const controller = new AbortController();
	let port = 0;
	const received: { path: string; size: number }[] = [];
	const server = serve(
		{ signal: controller.signal, onListen: (a) => (port = a.port) },
		async (req) => {
			let size = 0;
			for await (const chunk of req.body!) size += chunk.byteLength;
			const path = new URL(req.url).pathname;
			received.push({ path, size });
			return Response.json({ uploaded: [path], size });
		},
	);
	await new Promise((r) => setTimeout(r, 100));
	try {
		const config = await writeConfig("upload", {
			logDir: "./log",
			trackDir: "./track",
			source: { dir: "./source" },
			destination: {
				adapter: "static-upload-server",
				url: `http://localhost:${port}/backups`,
				token: "${FILE_RELAY_E2E_TOKEN}",
			},
		});
		await createFile(join(config, ".."), "source/db/dump.sql.gz", "x".repeat(200_000));
		const r = await cli([config], { env: { FILE_RELAY_E2E_TOKEN: "t" } });
		assert.equal(r.code, 0, r.stderr);
		assert.deepStrictEqual(received, [{ path: "/backups/db/dump.sql.gz", size: 200_000 }]);
	} finally {
		controller.abort();
		await server.finished;
	}
});

test("SIGTERM aborts a hanging upload: exit 130", { timeout: 30_000 }, async () => {
	const controller = new AbortController();
	let port = 0;
	let arrived: () => void = () => {};
	const requestArrived = new Promise<void>((r) => (arrived = r));
	const server = serve(
		{ signal: controller.signal, onListen: (a) => (port = a.port) },
		async (req) => {
			// the preflight HEAD is answered (it does not take the abort signal)
			if (req.method === "HEAD") return new Response(null);
			arrived();
			// never answer the upload; give up once the client is gone
			await new Promise((r) => req.signal.addEventListener("abort", r));
			return new Response("too late");
		},
	);
	await new Promise((r) => setTimeout(r, 100));
	try {
		const config = await writeConfig("sigterm", {
			logDir: "./log",
			trackDir: "./track",
			source: { dir: "./source" },
			destination: {
				adapter: "static-upload-server",
				url: `http://localhost:${port}`,
				token: "t",
			},
		});
		await createFile(join(config, ".."), "source/a.gz", "a");
		const r = await cli([config], {
			onStart: (child) => {
				requestArrived.then(() => child.kill("SIGTERM"));
			},
		});
		assert.equal(r.code, 130, r.stderr);
		assert.match(r.stdout + r.stderr, /Received signal/);
		// the aborted file is not marked as transferred
		await assert.rejects(
			fs.stat(join(config, "..", "track/a.gz.transferred.json")),
			(e: unknown) => e instanceof Error && "code" in e && e.code === "ENOENT",
		);
	} finally {
		controller.abort();
		await server.finished;
	}
});
