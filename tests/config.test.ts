import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { loadConfig, validateConfig } from "../src/config.ts";
import { cleanup, createTempDir } from "./_helpers.ts";

test("config - validates a correct static-upload-server config", () => {
	const config = validateConfig({
		logDir: "/tmp/logs",
		trackDir: "/tmp/track",
		source: {
			dir: "/data/backups",
			glob: "**/*.sql.gz",
			exclude: ["*-latest.sql.gz"],
		},
		destination: {
			adapter: "static-upload-server",
			url: "https://example.com/backups",
			token: "secret",
		},
	});

	assert.deepStrictEqual(config.logDir, "/tmp/logs");
	assert.deepStrictEqual(config.trackDir, "/tmp/track");
	assert.deepStrictEqual(config.source.dir, "/data/backups");
	assert.deepStrictEqual(config.source.glob, "**/*.sql.gz");
	assert.deepStrictEqual(config.source.exclude, ["*-latest.sql.gz"]);
	assert.deepStrictEqual(config.source.followSymlinks, false);
	assert.deepStrictEqual(config.destination.adapter, "static-upload-server");
});

test("config - validates a correct filesystem config", () => {
	const config = validateConfig({
		logDir: "/tmp/logs",
		trackDir: "/tmp/track",
		source: { dir: "/data/backups" },
		destination: { adapter: "filesystem", dir: "/mnt/offsite" },
	});

	assert.deepStrictEqual(config.source.glob, "**/*"); // default
	assert.deepStrictEqual(config.source.exclude, []); // default
	assert.deepStrictEqual(config.destination.adapter, "filesystem");
});

test("config - rejects missing logDir", () => {
	assert.throws(
		() =>
			validateConfig({
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: { adapter: "filesystem", dir: "/mnt" },
			}),
		(e: unknown) => e instanceof Error && e.message.includes('"logDir"'),
	);
});

test("config - rejects missing trackDir", () => {
	assert.throws(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				source: { dir: "/data" },
				destination: { adapter: "filesystem", dir: "/mnt" },
			}),
		(e: unknown) => e instanceof Error && e.message.includes('"trackDir"'),
	);
});

test("config - resolves relative paths against baseDir", () => {
	const config = validateConfig(
		{
			logDir: "./log",
			trackDir: "./track",
			source: { dir: "./source" },
			destination: { adapter: "filesystem", dir: "./dest" },
		},
		"/base/dir",
	);

	assert.deepStrictEqual(config.logDir, "/base/dir/log");
	assert.deepStrictEqual(config.trackDir, "/base/dir/track");
	assert.deepStrictEqual(config.source.dir, "/base/dir/source");
	assert.deepStrictEqual((config.destination as { dir: string }).dir, "/base/dir/dest");
});

test("config - resolves relative paths against cwd when no baseDir", () => {
	const config = validateConfig({
		logDir: "./log",
		trackDir: "./track",
		source: { dir: "./source" },
		destination: { adapter: "filesystem", dir: "./dest" },
	});

	// should resolve against cwd
	const cwd = process.cwd();
	assert.deepStrictEqual(config.logDir, `${cwd}/log`);
	assert.deepStrictEqual(config.source.dir, `${cwd}/source`);
});

test("config - rejects unknown adapter", () => {
	assert.throws(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: { adapter: "ftp", url: "ftp://host" },
			}),
		(e: unknown) => e instanceof Error && e.message.includes("Unknown adapter"),
	);
});

test("config - rejects missing url for static-upload-server", () => {
	assert.throws(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: {
					adapter: "static-upload-server",
					token: "t",
				},
			}),
		(e: unknown) => e instanceof Error && e.message.includes('"destination.url"'),
	);
});

test("config - rejects missing token for static-upload-server", () => {
	assert.throws(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: {
					adapter: "static-upload-server",
					url: "https://host",
				},
			}),
		(e: unknown) => e instanceof Error && e.message.includes('"destination.token"'),
	);
});

test("config - applies default timeout", () => {
	const config = validateConfig({
		logDir: "/tmp/logs",
		trackDir: "/tmp/track",
		source: { dir: "/data" },
		destination: {
			adapter: "static-upload-server",
			url: "https://host",
			token: "t",
		},
	});

	assert.deepStrictEqual((config.destination as { timeout: number }).timeout, 300_000);
});

test("config - loadConfig with env var interpolation", async () => {
	const tmpDir = await createTempDir();
	try {
		process.env["TEST_RELAY_TOKEN"] = "my-secret-token";

		const configContent = JSON.stringify({
			logDir: "/tmp/logs",
			trackDir: "/tmp/track",
			source: { dir: "/data" },
			destination: {
				adapter: "static-upload-server",
				url: "https://host",
				token: "${TEST_RELAY_TOKEN}",
			},
		});

		const configPath = join(tmpDir, "config.json");
		await fs.writeFile(configPath, configContent);

		const config = await loadConfig(configPath);
		assert.deepStrictEqual(
			(config.destination as { token: string }).token,
			"my-secret-token",
		);
	} finally {
		delete process.env["TEST_RELAY_TOKEN"];
		await cleanup(tmpDir);
	}
});

test("config - loadConfig rejects missing env var", async () => {
	const tmpDir = await createTempDir();
	try {
		delete process.env["NONEXISTENT_VAR_12345"];

		const configPath = join(tmpDir, "config.json");
		await fs.writeFile(
			configPath,
			JSON.stringify({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: {
					adapter: "static-upload-server",
					url: "https://host",
					token: "${NONEXISTENT_VAR_12345}",
				},
			}),
		);

		await assert.rejects(
			() => loadConfig(configPath),
			(e: unknown) =>
				e instanceof Error && e.message.includes("NONEXISTENT_VAR_12345"),
		);
	} finally {
		await cleanup(tmpDir);
	}
});

test("config - validates match and ignore arrays", () => {
	const config = validateConfig({
		logDir: "/tmp/logs",
		trackDir: "/tmp/track",
		source: {
			dir: "/data/backups",
			match: ["^daily/", "weekly"],
			ignore: ["\\.tmp$"],
		},
		destination: { adapter: "filesystem", dir: "/mnt" },
	});

	assert.deepStrictEqual(config.source.match, ["^daily/", "weekly"]);
	assert.deepStrictEqual(config.source.ignore, ["\\.tmp$"]);
});

test("config - defaults match and ignore to empty arrays", () => {
	const config = validateConfig({
		logDir: "/tmp/logs",
		trackDir: "/tmp/track",
		source: { dir: "/data" },
		destination: { adapter: "filesystem", dir: "/mnt" },
	});

	assert.deepStrictEqual(config.source.match, []);
	assert.deepStrictEqual(config.source.ignore, []);
});

test("config - rejects non-array match", () => {
	assert.throws(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data", match: "not-array" },
				destination: { adapter: "filesystem", dir: "/mnt" },
			}),
		(e: unknown) =>
			e instanceof Error && e.message.includes('"source.match" must be an array'),
	);
});

test("config - rejects non-string entries in ignore", () => {
	assert.throws(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data", ignore: [123] },
				destination: { adapter: "filesystem", dir: "/mnt" },
			}),
		(e: unknown) =>
			e instanceof Error &&
			e.message.includes('"source.ignore" entries must be strings'),
	);
});

test("config - rejects invalid regex in match", () => {
	assert.throws(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data", match: ["[invalid"] },
				destination: { adapter: "filesystem", dir: "/mnt" },
			}),
		(e: unknown) => e instanceof Error && e.message.includes("invalid regex"),
	);
});

test("config - rejects invalid regex in ignore", () => {
	assert.throws(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data", ignore: ["(unclosed"] },
				destination: { adapter: "filesystem", dir: "/mnt" },
			}),
		(e: unknown) => e instanceof Error && e.message.includes("invalid regex"),
	);
});

test("config - trailing slash on absolute path does not re-join baseDir", () => {
	const config = validateConfig(
		{
			logDir: "/tmp/logs/",
			trackDir: "/tmp/track/",
			source: { dir: "/data/backups/" },
			destination: { adapter: "filesystem", dir: "/mnt/dest/" },
		},
		"/base/dir",
	);

	assert.deepStrictEqual(config.logDir, "/tmp/logs");
	assert.deepStrictEqual(config.trackDir, "/tmp/track");
	assert.deepStrictEqual(config.source.dir, "/data/backups");
	assert.deepStrictEqual((config.destination as { dir: string }).dir, "/mnt/dest");
});

test("config - validates transfer.concurrency and retry", () => {
	const config = validateConfig({
		logDir: "/tmp/logs",
		trackDir: "/tmp/track",
		source: { dir: "/data" },
		destination: { adapter: "filesystem", dir: "/mnt" },
		transfer: {
			concurrency: 4,
			retry: { attempts: 3, backoffMs: 500, maxBackoffMs: 10_000 },
		},
	});

	assert.deepStrictEqual(config.transfer?.concurrency, 4);
	assert.deepStrictEqual(config.transfer?.retry?.attempts, 3);
	assert.deepStrictEqual(config.transfer?.retry?.backoffMs, 500);
	assert.deepStrictEqual(config.transfer?.retry?.maxBackoffMs, 10_000);
});

test("config - rejects non-positive concurrency", () => {
	assert.throws(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: { adapter: "filesystem", dir: "/mnt" },
				transfer: { concurrency: 0 },
			}),
		(e: unknown) => e instanceof Error && e.message.includes("concurrency"),
	);
});

test("config - rejects invalid retry attempts", () => {
	assert.throws(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: { adapter: "filesystem", dir: "/mnt" },
				transfer: { retry: { attempts: 0 } },
			}),
		(e: unknown) => e instanceof Error && e.message.includes("attempts"),
	);
});

test("config - validates filesystem verify mode", () => {
	const config = validateConfig({
		logDir: "/tmp/logs",
		trackDir: "/tmp/track",
		source: { dir: "/data" },
		destination: {
			adapter: "filesystem",
			dir: "/mnt",
			verify: "sha256",
		},
	});
	assert.deepStrictEqual((config.destination as { verify: string }).verify, "sha256");
});

test("config - rejects unknown verify mode", () => {
	assert.throws(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: {
					adapter: "filesystem",
					dir: "/mnt",
					verify: "md5",
				},
			}),
		(e: unknown) => e instanceof Error && e.message.includes("verify"),
	);
});

test("config - validates a full notify block and applies defaults", () => {
	const config = validateConfig({
		logDir: "/tmp/logs",
		trackDir: "/tmp/track",
		source: { dir: "/data" },
		destination: { adapter: "filesystem", dir: "/mnt" },
		notify: {
			to: "ops@example.com",
			from: "relay@host",
			smtp: { host: "smtp.example.com", user: "u", pass: "p" },
		},
	});

	assert.deepStrictEqual(config.notify?.to, "ops@example.com");
	assert.deepStrictEqual(config.notify?.from, "relay@host");
	assert.deepStrictEqual(config.notify?.on, "always"); // default
	assert.deepStrictEqual(config.notify?.subjectPrefix, "[file-relay]"); // default
	assert.deepStrictEqual(config.notify?.attachLog, false); // default
	assert.deepStrictEqual(config.notify?.smtp.host, "smtp.example.com");
	assert.deepStrictEqual(config.notify?.smtp.port, 587); // default
	assert.deepStrictEqual(config.notify?.smtp.user, "u");
	assert.deepStrictEqual(config.notify?.smtp.pass, "p");
});

test("config - notify accepts arrays for to/cc/bcc and on=failure", () => {
	const config = validateConfig({
		logDir: "/tmp/logs",
		trackDir: "/tmp/track",
		source: { dir: "/data" },
		destination: { adapter: "filesystem", dir: "/mnt" },
		notify: {
			to: ["a@host", "b@host"],
			from: "relay@host",
			on: "failure",
			cc: "cc@host",
			bcc: ["x@host"],
			subjectPrefix: "[backup]",
			attachLog: true,
			smtp: {
				host: "smtp.example.com",
				port: 465,
				secure: true,
				connectionTimeout: 15000,
				socketTimeout: 20000,
			},
		},
	});

	assert.deepStrictEqual(config.notify?.to, ["a@host", "b@host"]);
	assert.deepStrictEqual(config.notify?.on, "failure");
	assert.deepStrictEqual(config.notify?.cc, "cc@host");
	assert.deepStrictEqual(config.notify?.bcc, ["x@host"]);
	assert.deepStrictEqual(config.notify?.subjectPrefix, "[backup]");
	assert.deepStrictEqual(config.notify?.attachLog, true);
	assert.deepStrictEqual(config.notify?.smtp.port, 465);
	assert.deepStrictEqual(config.notify?.smtp.secure, true);
	assert.deepStrictEqual(config.notify?.smtp.connectionTimeout, 15000);
	assert.deepStrictEqual(config.notify?.smtp.socketTimeout, 20000);
});

test("config - coerces boolean fields from strings (env interpolation)", () => {
	// ${ENV_VAR} interpolation always yields strings, so env-driven booleans
	// arrive here as text and must be parsed.
	const config = validateConfig({
		logDir: "/tmp/logs",
		trackDir: "/tmp/track",
		source: { dir: "/data", followSymlinks: "true" },
		destination: { adapter: "filesystem", dir: "/mnt" },
		notify: {
			to: "a@host",
			from: "relay@host",
			attachLog: "no",
			smtp: {
				host: "smtp.example.com",
				secure: "false",
				tls: { rejectUnauthorized: "0" },
			},
		},
	});

	assert.deepStrictEqual(config.source.followSymlinks, true);
	assert.deepStrictEqual(config.notify?.attachLog, false);
	assert.deepStrictEqual(config.notify?.smtp.secure, false);
	assert.deepStrictEqual(config.notify?.smtp.tls?.rejectUnauthorized, false);
});

test("config - rejects unrecognized boolean string (fail-loud)", () => {
	assert.throws(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: { adapter: "filesystem", dir: "/mnt" },
				notify: {
					to: "a@host",
					from: "relay@host",
					smtp: { host: "smtp.example.com", secure: "treu" },
				},
			}),
		(e: unknown) =>
			e instanceof Error &&
			e.message.includes('"notify.smtp.secure" must be a boolean'),
	);
});

test("config - rejects non-positive notify.smtp.connectionTimeout", () => {
	assert.throws(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: { adapter: "filesystem", dir: "/mnt" },
				notify: {
					to: "ops@host",
					from: "r@host",
					smtp: { host: "smtp", connectionTimeout: 0 },
				},
			}),
		(e: unknown) =>
			e instanceof Error && e.message.includes('"notify.smtp.connectionTimeout"'),
	);
});

test("config - notify is omitted when not provided", () => {
	const config = validateConfig({
		logDir: "/tmp/logs",
		trackDir: "/tmp/track",
		source: { dir: "/data" },
		destination: { adapter: "filesystem", dir: "/mnt" },
	});
	assert.deepStrictEqual(config.notify, undefined);
});

test("config - rejects notify missing to", () => {
	assert.throws(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: { adapter: "filesystem", dir: "/mnt" },
				notify: { from: "r@host", smtp: { host: "smtp" } },
			}),
		(e: unknown) => e instanceof Error && e.message.includes('"notify.to"'),
	);
});

test("config - rejects notify missing from", () => {
	assert.throws(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: { adapter: "filesystem", dir: "/mnt" },
				notify: { to: "ops@host", smtp: { host: "smtp" } },
			}),
		(e: unknown) => e instanceof Error && e.message.includes('"notify.from"'),
	);
});

test("config - rejects notify missing smtp.host", () => {
	assert.throws(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: { adapter: "filesystem", dir: "/mnt" },
				notify: { to: "ops@host", from: "r@host", smtp: {} },
			}),
		(e: unknown) => e instanceof Error && e.message.includes('"notify.smtp.host"'),
	);
});

test("config - rejects notify with lone smtp.user (no pass)", () => {
	assert.throws(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: { adapter: "filesystem", dir: "/mnt" },
				notify: {
					to: "ops@host",
					from: "r@host",
					smtp: { host: "smtp", user: "u" },
				},
			}),
		(e: unknown) => e instanceof Error && e.message.includes("must be set together"),
	);
});

test("config - rejects invalid notify.on", () => {
	assert.throws(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: { adapter: "filesystem", dir: "/mnt" },
				notify: {
					to: "ops@host",
					from: "r@host",
					on: "sometimes",
					smtp: { host: "smtp" },
				},
			}),
		(e: unknown) => e instanceof Error && e.message.includes('"notify.on"'),
	);
});

test("config - rejects invalid notify.smtp.port", () => {
	assert.throws(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: { adapter: "filesystem", dir: "/mnt" },
				notify: {
					to: "ops@host",
					from: "r@host",
					smtp: { host: "smtp", port: 70000 },
				},
			}),
		(e: unknown) => e instanceof Error && e.message.includes('"notify.smtp.port"'),
	);
});

test("config - notify smtp credentials support env interpolation", async () => {
	const tmpDir = await createTempDir();
	try {
		process.env["TEST_SMTP_PASS"] = "s3cret";
		const configPath = join(tmpDir, "config.json");
		await fs.writeFile(
			configPath,
			JSON.stringify({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: { adapter: "filesystem", dir: "/mnt" },
				notify: {
					to: "ops@host",
					from: "r@host",
					smtp: {
						host: "smtp.example.com",
						user: "u",
						pass: "${TEST_SMTP_PASS}",
					},
				},
			}),
		);
		const config = await loadConfig(configPath);
		assert.deepStrictEqual(config.notify?.smtp.pass, "s3cret");
	} finally {
		delete process.env["TEST_SMTP_PASS"];
		await cleanup(tmpDir);
	}
});

test("config - loadConfig rejects invalid JSON", async () => {
	const tmpDir = await createTempDir();
	try {
		const configPath = join(tmpDir, "bad.json");
		await fs.writeFile(configPath, "not json");

		await assert.rejects(
			() => loadConfig(configPath),
			(e: unknown) => e instanceof Error && e.message.includes("JSON"),
		);
	} finally {
		await cleanup(tmpDir);
	}
});
