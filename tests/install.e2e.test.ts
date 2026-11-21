// End-to-end: spawn the scaffolder with piped answers and check what it writes.
//
// Runs src/bin-install.ts (the npm `file-relay-install` bin) on Node;
// `CLI_RUNTIME=deno` runs src/install.ts on Deno instead, the JSR `./install` entry.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.ts";
import { cleanup, createTempDir } from "./_helpers.ts";

const path = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

const INSTALL_ARGV: [string, ...string[]] =
	process.env.CLI_RUNTIME === "deno"
		? [
				"deno",
				"run",
				"-A",
				"--no-lock",
				"--config",
				path("../jsr.json"),
				path("../src/install.ts"),
			]
		: [process.execPath, path("../src/bin-install.ts")];

let work: string;
before(async () => {
	work = await createTempDir("file-relay-install-e2e-");
});
after(async () => {
	await cleanup(work);
});

/** Runs the scaffolder in `work` with `answers` piped to stdin, one per line. */
function install(
	args: string[],
	answers: string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(INSTALL_ARGV[0], [...INSTALL_ARGV.slice(1), ...args], {
			cwd: work,
			stdio: ["pipe", "pipe", "pipe"],
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
		child.stdin.end(answers.map((a) => `${a}\n`).join(""));
	});
}

const readJson = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));

test("--help prints usage, exit 0; no argument is a usage error, exit 2", async () => {
	const help = await install(["--help"]);
	assert.equal(help.code, 0);
	assert.match(help.stdout, /file-relay-install <dirname>/);
	const none = await install([]);
	assert.equal(none.code, 2);
});

test("an upload instance with notify: config, a Node package.json, env template", async () => {
	// source dir, adapter (empty = the default, static-upload-server), notify
	const r = await install(["upload"], ["/data/backups", "", "yes"]);
	assert.equal(r.code, 0, r.stderr);
	const dir = join(work, "upload");

	const config = await readJson(join(dir, "config.json"));
	assert.deepStrictEqual(config.source, { dir: "/data/backups", glob: "**/*" });
	assert.deepStrictEqual(config.destination, {
		adapter: "static-upload-server",
		url: "${STATIC_UPLOAD_SERVER_URL}",
		token: "${STATIC_UPLOAD_SERVER_TOKEN}",
	});
	assert.equal(config.notify.smtp.host, "${SMTP_HOST}");

	assert.deepStrictEqual(await readJson(join(dir, "package.json")), {
		private: true,
		scripts: {
			backup: "node --env-file-if-exists=.env node_modules/@marianmeres/file-relay/dist/bin.js config.json",
		},
		dependencies: { "@marianmeres/file-relay": `^${VERSION}` },
	});
	const env = await fs.readFile(join(dir, ".env.example"), "utf8");
	assert.match(env, /^STATIC_UPLOAD_SERVER_URL=/m);
	assert.match(env, /^SMTP_HOST=/m);
	assert.deepStrictEqual((await fs.readdir(join(dir, "log"))).sort(), [".gitkeep"]);
	assert.deepStrictEqual((await fs.readdir(join(dir, "track"))).sort(), [".gitkeep"]);
	await assert.rejects(fs.stat(join(dir, "deno.json")));
	assert.match(r.stdout, /npm run backup/);
});

test("a filesystem instance; an invalid choice is asked again", async () => {
	const r = await install(["fs"], ["./source", "ftp", "filesystem", "./dest", "no"]);
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /Please choose one of: static-upload-server, filesystem/);
	const config = await readJson(join(work, "fs", "config.json"));
	assert.deepStrictEqual(config.destination, { adapter: "filesystem", dir: "./dest" });
	assert.equal(config.notify, undefined);
});

test("an existing directory exits 1; stdin ending early exits 1", async () => {
	await fs.mkdir(join(work, "taken"));
	const taken = await install(["taken"]);
	assert.equal(taken.code, 1);
	assert.match(taken.stderr, /directory already exists/);

	const early = await install(["early"], ["/data"]);
	assert.equal(early.code, 1);
	assert.match(early.stderr, /stdin closed before every question was answered/);
});
