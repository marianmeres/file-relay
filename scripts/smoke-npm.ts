/**
 * Smoke-tests the built npm package (`pnpm run smoke`, or
 * `node scripts/smoke-npm.ts` after `pnpm run build`).
 *
 * `pnpm pack`s the repo root - the tarball `pnpm publish` would upload - and in a
 * throw-away project under the OS temp dir installs it with npm, as a consumer gets
 * it, then on Node:
 *
 *  1. checks the installed package.json (the `.` and `./mod` exports and their
 *     files, the `file-relay` and `file-relay-install` bins, the runtime
 *     dependencies, `engines.node`) and that the tarball carries `dist/` without
 *     any repo-only directory;
 *  2. runs the installed `file-relay` bin: `--version`, and a filesystem relay - the
 *     suite runs `src/*.ts`, so only here does the CLI run from `dist/*.js`, through
 *     npm's bin link;
 *  3. runs it once more with a `notify` block pointing at a closed SMTP port: the
 *     notification is sent after the relay, through the dynamically imported
 *     `@marianmeres/send-email`, so this proves that import resolves from the
 *     installed package; the send fails, which must not change the exit code;
 *  4. imports the library through both specifiers and runs a dry run;
 *  5. scaffolds an instance with `file-relay-install` (piped answers), installs the
 *     tarball into it and runs its `npm run backup`: the generated script, against
 *     the package as npm lays it out.
 *
 * Repo tool, Node only (nothing here is shipped).
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG = "@marianmeres/file-relay";
const BIN = "file-relay";
const INSTALL_BIN = "file-relay-install";
const DEPS = [
	"@marianmeres/clog",
	"@marianmeres/parse-boolean",
	"@marianmeres/send-email",
];

/** Repo directories the published tarball must not carry. */
const REPO_ONLY = [
	"src",
	"tests",
	"scripts",
	"tmp",
	"example",
	"example2",
	"node_modules",
];

/** Step 4: a library consumer. */
const LIBRARY = `
import assert from "node:assert/strict";
import * as root from "${PKG}";
import * as mod from "${PKG}/mod";

assert.equal(root.relay, mod.relay, "'.' and './mod' are the same module");
const config = root.validateConfig({
	logDir: "./lib-log",
	trackDir: "./lib-track",
	source: { dir: "./source" },
	destination: { adapter: "filesystem", dir: "./lib-dest" },
}, process.cwd());
const result = await root.relay(config, { dryRun: true });
assert.equal(result.status, "idle");
assert.equal(result.filesFound, 1);
console.log("smoke: the library imports through both specifiers and runs a dry run");
`;

type Manifest = {
	name?: string;
	version?: string;
	exports?: Record<string, Record<string, string>>;
	bin?: Record<string, string>;
	dependencies?: Record<string, string>;
	engines?: Record<string, string>;
};

function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
	console.log(`smoke: $ ${[cmd, ...args].join(" ")}`);
	return execFileSync(cmd, args, {
		cwd,
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
}

function check(condition: unknown, what: string): asserts condition {
	if (!condition) throw new Error(`smoke: ${what}`);
}

/** A local TCP port nothing listens on (taken from the OS, then released). */
function closedPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			server.close(() => resolve(port));
		});
	});
}

function checkInstalledManifest(dir: string): Manifest {
	const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
	check(pkg.name === PKG, `installed package is "${pkg.name}", expected "${PKG}"`);
	const exportKeys = Object.keys(pkg.exports ?? {});
	check(
		JSON.stringify(exportKeys) === JSON.stringify([".", "./mod"]),
		`exports keys are ${JSON.stringify(exportKeys)}`,
	);
	for (const key of exportKeys) {
		for (const kind of ["types", "default"]) {
			const file = pkg.exports?.[key]?.[kind];
			check(
				file && existsSync(join(dir, file)),
				`exports["${key}"].${kind} does not exist: ${file}`,
			);
		}
	}
	for (const name of [BIN, INSTALL_BIN]) {
		const bin = pkg.bin?.[name];
		check(bin && existsSync(join(dir, bin)), `bin "${name}" does not exist: ${bin}`);
	}
	for (const dep of DEPS) {
		check(
			typeof pkg.dependencies?.[dep] === "string",
			`${dep} is not a runtime dependency: ${JSON.stringify(pkg.dependencies)}`,
		);
	}
	check(typeof pkg.engines?.node === "string", "engines.node missing");
	for (const name of REPO_ONLY) {
		check(!existsSync(join(dir, name)), `the tarball carries "${name}/"`);
	}
	console.log(
		`smoke: ${pkg.name}@${pkg.version} - bins ${BIN}, ${INSTALL_BIN}, ` +
			`deps ${DEPS.map((d) => `${d} ${pkg.dependencies?.[d]}`).join(", ")}, ` +
			`engines.node ${pkg.engines?.node}`,
	);
	return pkg;
}

check(
	existsSync(join(ROOT, "dist", "mod.js")) && existsSync(join(ROOT, "dist", "bin.js")),
	"dist/ is missing - run `pnpm run build` first",
);

const project = mkdtempSync(join(tmpdir(), "file-relay-npm-smoke-"));
try {
	writeFileSync(
		join(project, "package.json"),
		JSON.stringify({ name: "file-relay-npm-smoke", private: true, type: "module" }),
	);
	const packDir = join(project, "pack");
	mkdirSync(packDir);
	run("pnpm", ["pack", "--pack-destination", packDir], ROOT);
	const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
	const [tarball] = tarballs;
	check(
		tarballs.length === 1 && tarball,
		`expected one tarball, got ${JSON.stringify(tarballs)}`,
	);

	run(
		"npm",
		[
			"install",
			"--no-audit",
			"--no-fund",
			"--loglevel=error",
			join(packDir, tarball),
		],
		project,
	);
	const pkg = checkInstalledManifest(join(project, "node_modules", PKG));

	// The bin, as `npx @marianmeres/file-relay` / an installed `file-relay` runs it.
	const bin = join(project, "node_modules", ".bin", BIN);
	const version = run(bin, ["--version"], project).trim();
	check(
		version === pkg.version,
		`--version printed "${version}", expected "${pkg.version}"`,
	);

	mkdirSync(join(project, "source"));
	writeFileSync(join(project, "source", "dump.sql.gz"), "smoke");
	const config = {
		logDir: "./log",
		trackDir: "./track",
		source: { dir: "./source" },
		destination: { adapter: "filesystem", dir: "./dest" },
	};
	writeFileSync(join(project, "relay.json"), JSON.stringify(config));
	run(bin, ["relay.json"], project);
	check(
		readFileSync(join(project, "dest", "dump.sql.gz"), "utf8") === "smoke",
		"the relay did not copy source/dump.sql.gz to dest/",
	);
	console.log("smoke: the bin runs from dist/ (--version, a filesystem relay)");

	// A fresh trackDir, so the run transfers again and then notifies.
	const port = await closedPort();
	writeFileSync(
		join(project, "notify.json"),
		JSON.stringify({
			...config,
			trackDir: "./track-notify",
			notify: {
				to: "ops@example.com",
				from: "relay@example.com",
				on: "always",
				smtp: { host: "127.0.0.1", port, connectionTimeout: 2000 },
			},
		}),
	);
	// clog writes warnings to stderr, so this run captures both streams
	console.log(`smoke: $ ${bin} notify.json`);
	const notified = spawnSync(bin, ["notify.json"], { cwd: project, encoding: "utf8" });
	check(notified.status === 0, `the notify run exited ${notified.status}`);
	check(
		/Notification email failed: .*ECONNREFUSED/.test(notified.stderr),
		`the notification was not attempted:\n${notified.stdout}${notified.stderr}`,
	);
	console.log(
		"smoke: notify loads @marianmeres/send-email from the install; a failed send exits 0",
	);

	writeFileSync(join(project, "library.mjs"), LIBRARY);
	process.stdout.write(run(process.execPath, ["library.mjs"], project));

	// Step 5: source dir, adapter, destination dir, notify
	const installBin = join(project, "node_modules", ".bin", INSTALL_BIN);
	console.log(`smoke: $ ${installBin} instance`);
	const scaffolded = spawnSync(installBin, ["instance"], {
		cwd: project,
		encoding: "utf8",
		input: "./source\nfilesystem\n./dest\nno\n",
	});
	check(scaffolded.status === 0, `file-relay-install exited ${scaffolded.status}`);
	const instance = join(project, "instance");
	mkdirSync(join(instance, "source"));
	writeFileSync(join(instance, "source", "dump.sql.gz"), "instance");
	run(
		"npm",
		[
			"install",
			"--no-audit",
			"--no-fund",
			"--loglevel=error",
			join(packDir, tarball),
		],
		instance,
	);
	run("npm", ["run", "--silent", "backup"], instance);
	check(
		readFileSync(join(instance, "dest", "dump.sql.gz"), "utf8") === "instance",
		"the scaffolded instance's `npm run backup` did not relay source/dump.sql.gz",
	);
	console.log("smoke: a scaffolded instance installs and runs `npm run backup`");
	console.log("smoke: OK");
} finally {
	rmSync(project, { recursive: true, force: true });
}
