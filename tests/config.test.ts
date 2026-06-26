import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { loadConfig, validateConfig } from "../src/config.ts";
import { cleanup, createTempDir } from "./_helpers.ts";
import { join } from "@std/path";

Deno.test("config - validates a correct static-upload-server config", () => {
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

	assertEquals(config.logDir, "/tmp/logs");
	assertEquals(config.trackDir, "/tmp/track");
	assertEquals(config.source.dir, "/data/backups");
	assertEquals(config.source.glob, "**/*.sql.gz");
	assertEquals(config.source.exclude, ["*-latest.sql.gz"]);
	assertEquals(config.source.followSymlinks, false);
	assertEquals(config.destination.adapter, "static-upload-server");
});

Deno.test("config - validates a correct filesystem config", () => {
	const config = validateConfig({
		logDir: "/tmp/logs",
		trackDir: "/tmp/track",
		source: { dir: "/data/backups" },
		destination: { adapter: "filesystem", dir: "/mnt/offsite" },
	});

	assertEquals(config.source.glob, "**/*"); // default
	assertEquals(config.source.exclude, []); // default
	assertEquals(config.destination.adapter, "filesystem");
});

Deno.test("config - rejects missing logDir", () => {
	assertThrows(
		() =>
			validateConfig({
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: { adapter: "filesystem", dir: "/mnt" },
			}),
		Error,
		'"logDir"',
	);
});

Deno.test("config - rejects missing trackDir", () => {
	assertThrows(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				source: { dir: "/data" },
				destination: { adapter: "filesystem", dir: "/mnt" },
			}),
		Error,
		'"trackDir"',
	);
});

Deno.test("config - resolves relative paths against baseDir", () => {
	const config = validateConfig(
		{
			logDir: "./log",
			trackDir: "./track",
			source: { dir: "./source" },
			destination: { adapter: "filesystem", dir: "./dest" },
		},
		"/base/dir",
	);

	assertEquals(config.logDir, "/base/dir/log");
	assertEquals(config.trackDir, "/base/dir/track");
	assertEquals(config.source.dir, "/base/dir/source");
	assertEquals(
		(config.destination as { dir: string }).dir,
		"/base/dir/dest",
	);
});

Deno.test("config - resolves relative paths against cwd when no baseDir", () => {
	const config = validateConfig({
		logDir: "./log",
		trackDir: "./track",
		source: { dir: "./source" },
		destination: { adapter: "filesystem", dir: "./dest" },
	});

	// should resolve against cwd
	const cwd = Deno.cwd();
	assertEquals(config.logDir, `${cwd}/log`);
	assertEquals(config.source.dir, `${cwd}/source`);
});

Deno.test("config - rejects unknown adapter", () => {
	assertThrows(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: { adapter: "ftp", url: "ftp://host" },
			}),
		Error,
		"Unknown adapter",
	);
});

Deno.test("config - rejects missing url for static-upload-server", () => {
	assertThrows(
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
		Error,
		'"destination.url"',
	);
});

Deno.test("config - rejects missing token for static-upload-server", () => {
	assertThrows(
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
		Error,
		'"destination.token"',
	);
});

Deno.test("config - applies default timeout", () => {
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

	assertEquals(
		(config.destination as { timeout: number }).timeout,
		300_000,
	);
});

Deno.test("config - loadConfig with env var interpolation", async () => {
	const tmpDir = await createTempDir();
	try {
		Deno.env.set("TEST_RELAY_TOKEN", "my-secret-token");

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
		await Deno.writeTextFile(configPath, configContent);

		const config = await loadConfig(configPath);
		assertEquals(
			(config.destination as { token: string }).token,
			"my-secret-token",
		);
	} finally {
		Deno.env.delete("TEST_RELAY_TOKEN");
		await cleanup(tmpDir);
	}
});

Deno.test("config - loadConfig rejects missing env var", async () => {
	const tmpDir = await createTempDir();
	try {
		Deno.env.delete("NONEXISTENT_VAR_12345");

		const configPath = join(tmpDir, "config.json");
		await Deno.writeTextFile(
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

		await assertRejects(
			() => loadConfig(configPath),
			Error,
			"NONEXISTENT_VAR_12345",
		);
	} finally {
		await cleanup(tmpDir);
	}
});

Deno.test("config - validates match and ignore arrays", () => {
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

	assertEquals(config.source.match, ["^daily/", "weekly"]);
	assertEquals(config.source.ignore, ["\\.tmp$"]);
});

Deno.test("config - defaults match and ignore to empty arrays", () => {
	const config = validateConfig({
		logDir: "/tmp/logs",
		trackDir: "/tmp/track",
		source: { dir: "/data" },
		destination: { adapter: "filesystem", dir: "/mnt" },
	});

	assertEquals(config.source.match, []);
	assertEquals(config.source.ignore, []);
});

Deno.test("config - rejects non-array match", () => {
	assertThrows(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data", match: "not-array" },
				destination: { adapter: "filesystem", dir: "/mnt" },
			}),
		Error,
		'"source.match" must be an array',
	);
});

Deno.test("config - rejects non-string entries in ignore", () => {
	assertThrows(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data", ignore: [123] },
				destination: { adapter: "filesystem", dir: "/mnt" },
			}),
		Error,
		'"source.ignore" entries must be strings',
	);
});

Deno.test("config - rejects invalid regex in match", () => {
	assertThrows(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data", match: ["[invalid"] },
				destination: { adapter: "filesystem", dir: "/mnt" },
			}),
		Error,
		"invalid regex",
	);
});

Deno.test("config - rejects invalid regex in ignore", () => {
	assertThrows(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data", ignore: ["(unclosed"] },
				destination: { adapter: "filesystem", dir: "/mnt" },
			}),
		Error,
		"invalid regex",
	);
});

Deno.test("config - trailing slash on absolute path does not re-join baseDir", () => {
	const config = validateConfig(
		{
			logDir: "/tmp/logs/",
			trackDir: "/tmp/track/",
			source: { dir: "/data/backups/" },
			destination: { adapter: "filesystem", dir: "/mnt/dest/" },
		},
		"/base/dir",
	);

	assertEquals(config.logDir, "/tmp/logs");
	assertEquals(config.trackDir, "/tmp/track");
	assertEquals(config.source.dir, "/data/backups");
	assertEquals(
		(config.destination as { dir: string }).dir,
		"/mnt/dest",
	);
});

Deno.test("config - validates transfer.concurrency and retry", () => {
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

	assertEquals(config.transfer?.concurrency, 4);
	assertEquals(config.transfer?.retry?.attempts, 3);
	assertEquals(config.transfer?.retry?.backoffMs, 500);
	assertEquals(config.transfer?.retry?.maxBackoffMs, 10_000);
});

Deno.test("config - rejects non-positive concurrency", () => {
	assertThrows(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: { adapter: "filesystem", dir: "/mnt" },
				transfer: { concurrency: 0 },
			}),
		Error,
		"concurrency",
	);
});

Deno.test("config - rejects invalid retry attempts", () => {
	assertThrows(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: { adapter: "filesystem", dir: "/mnt" },
				transfer: { retry: { attempts: 0 } },
			}),
		Error,
		"attempts",
	);
});

Deno.test("config - validates filesystem verify mode", () => {
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
	assertEquals(
		(config.destination as { verify: string }).verify,
		"sha256",
	);
});

Deno.test("config - rejects unknown verify mode", () => {
	assertThrows(
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
		Error,
		"verify",
	);
});

Deno.test("config - validates a full notify block and applies defaults", () => {
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

	assertEquals(config.notify?.to, "ops@example.com");
	assertEquals(config.notify?.from, "relay@host");
	assertEquals(config.notify?.on, "always"); // default
	assertEquals(config.notify?.subjectPrefix, "[file-relay]"); // default
	assertEquals(config.notify?.attachLog, false); // default
	assertEquals(config.notify?.smtp.host, "smtp.example.com");
	assertEquals(config.notify?.smtp.port, 587); // default
	assertEquals(config.notify?.smtp.user, "u");
	assertEquals(config.notify?.smtp.pass, "p");
});

Deno.test("config - notify accepts arrays for to/cc/bcc and on=failure", () => {
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

	assertEquals(config.notify?.to, ["a@host", "b@host"]);
	assertEquals(config.notify?.on, "failure");
	assertEquals(config.notify?.cc, "cc@host");
	assertEquals(config.notify?.bcc, ["x@host"]);
	assertEquals(config.notify?.subjectPrefix, "[backup]");
	assertEquals(config.notify?.attachLog, true);
	assertEquals(config.notify?.smtp.port, 465);
	assertEquals(config.notify?.smtp.secure, true);
	assertEquals(config.notify?.smtp.connectionTimeout, 15000);
	assertEquals(config.notify?.smtp.socketTimeout, 20000);
});

Deno.test("config - rejects non-positive notify.smtp.connectionTimeout", () => {
	assertThrows(
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
		Error,
		'"notify.smtp.connectionTimeout"',
	);
});

Deno.test("config - notify is omitted when not provided", () => {
	const config = validateConfig({
		logDir: "/tmp/logs",
		trackDir: "/tmp/track",
		source: { dir: "/data" },
		destination: { adapter: "filesystem", dir: "/mnt" },
	});
	assertEquals(config.notify, undefined);
});

Deno.test("config - rejects notify missing to", () => {
	assertThrows(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: { adapter: "filesystem", dir: "/mnt" },
				notify: { from: "r@host", smtp: { host: "smtp" } },
			}),
		Error,
		'"notify.to"',
	);
});

Deno.test("config - rejects notify missing from", () => {
	assertThrows(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: { adapter: "filesystem", dir: "/mnt" },
				notify: { to: "ops@host", smtp: { host: "smtp" } },
			}),
		Error,
		'"notify.from"',
	);
});

Deno.test("config - rejects notify missing smtp.host", () => {
	assertThrows(
		() =>
			validateConfig({
				logDir: "/tmp/logs",
				trackDir: "/tmp/track",
				source: { dir: "/data" },
				destination: { adapter: "filesystem", dir: "/mnt" },
				notify: { to: "ops@host", from: "r@host", smtp: {} },
			}),
		Error,
		'"notify.smtp.host"',
	);
});

Deno.test("config - rejects notify with lone smtp.user (no pass)", () => {
	assertThrows(
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
		Error,
		"must be set together",
	);
});

Deno.test("config - rejects invalid notify.on", () => {
	assertThrows(
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
		Error,
		'"notify.on"',
	);
});

Deno.test("config - rejects invalid notify.smtp.port", () => {
	assertThrows(
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
		Error,
		'"notify.smtp.port"',
	);
});

Deno.test("config - notify smtp credentials support env interpolation", async () => {
	const tmpDir = await createTempDir();
	try {
		Deno.env.set("TEST_SMTP_PASS", "s3cret");
		const configPath = join(tmpDir, "config.json");
		await Deno.writeTextFile(
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
		assertEquals(config.notify?.smtp.pass, "s3cret");
	} finally {
		Deno.env.delete("TEST_SMTP_PASS");
		await cleanup(tmpDir);
	}
});

Deno.test("config - loadConfig rejects invalid JSON", async () => {
	const tmpDir = await createTempDir();
	try {
		const configPath = join(tmpDir, "bad.json");
		await Deno.writeTextFile(configPath, "not json");

		await assertRejects(
			() => loadConfig(configPath),
			Error,
			"JSON",
		);
	} finally {
		await cleanup(tmpDir);
	}
});
