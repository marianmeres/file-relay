import { dirname, isAbsolute, resolve } from "@std/path";
import { parseBoolean } from "@marianmeres/parse-boolean";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Configuration for the source directory to scan for files. */
export interface SourceConfig {
	/** Base directory to scan recursively. Must be absolute. */
	dir: string;
	/** Glob pattern for matching files. Default: `"**\/*"` */
	glob?: string;
	/** Glob patterns to exclude (matched against relative path). */
	exclude?: string[];
	/**
	 * Regex patterns for path inclusion (whitelist). If non-empty, a file's
	 * relative path must match at least one pattern to be included.
	 * Uses `RegExp.test()` (partial match — no anchoring unless you use `^`/`$`).
	 * Supports inline flags, e.g. `"(?i)foo"` for case-insensitive matching.
	 * @example ["foo", "^daily/"]
	 */
	match?: string[];
	/**
	 * Regex patterns for path exclusion (blacklist). A file whose relative path
	 * matches any pattern will be excluded.
	 * Uses `RegExp.test()` (partial match — no anchoring unless you use `^`/`$`).
	 * @example ["-latest\\.sql\\.gz$", "(?i)\\.tmp$"]
	 */
	ignore?: string[];
	/** Whether to follow symlinks. Default: `false` */
	followSymlinks?: boolean;
}

/**
 * How the file is framed on the wire when talking to a
 * `@marianmeres/deno-static-upload-server` instance.
 *
 * - `"put"` — raw-body `PUT /:projectId/<relativePath>`. The request body *is*
 *   the file. The server streams it straight to disk, so its memory use is
 *   constant regardless of file size. **This is the default**, and the only
 *   sane choice for large files. Requires server >= 1.7.0.
 * - `"multipart"` — legacy `multipart/form-data` POST. The server parses the
 *   whole body into memory before writing it (roughly 3.5x the file size in
 *   RSS), so a 100 MB upload can take down a small host. Only use this against
 *   a server older than 1.7.0, which has no PUT route.
 */
export type StaticUploadMode = "put" | "multipart";

/** Destination config for uploading via HTTP to a deno-static-upload-server instance. */
export interface StaticUploadServerDestination {
	/** Adapter discriminator. */
	adapter: "static-upload-server";
	/** Full URL including projectId path, e.g. "https://host/backups" */
	url: string;
	/** Bearer token. Supports ${ENV_VAR} interpolation. */
	token: string;
	/** Request timeout in ms. Default: 300000 (5 min) */
	timeout?: number;
	/**
	 * Wire format. Default: `"put"`. See {@linkcode StaticUploadMode} — only set
	 * this to `"multipart"` for an upload server older than 1.7.0.
	 */
	mode?: StaticUploadMode;
}

/** Destination config for raw filesystem copy to a local/mounted directory. */
export interface FilesystemCopyDestination {
	/** Adapter discriminator. */
	adapter: "filesystem";
	/** Target directory. Must be absolute. */
	dir: string;
	/**
	 * Post-copy verification mode. Default: `"size"` (compares byte size — fast,
	 * catches truncation). Use `"sha256"` to additionally compare SHA-256 of
	 * source and destination (slower, catches silent corruption).
	 */
	verify?: "size" | "sha256";
}

/** Union of all supported destination configurations. Discriminated by `adapter` field. */
export type DestinationConfig =
	| StaticUploadServerDestination
	| FilesystemCopyDestination;

/** Retry policy for transient transfer failures. */
export interface RetryConfig {
	/** Total attempts (including the initial one). Default: `1` (no retry). */
	attempts?: number;
	/** Initial backoff delay in ms. Doubled between attempts. Default: `1000` */
	backoffMs?: number;
	/** Maximum backoff delay in ms. Default: `30000` */
	maxBackoffMs?: number;
}

/** Transfer behaviour (concurrency, retries). Applies across all adapters. */
export interface TransferConfig {
	/**
	 * Maximum number of files transferred concurrently. Default: `1`
	 * (sequential — preserves the pre-1.3 behaviour).
	 */
	concurrency?: number;
	/** Retry policy for failing transfers. Default: no retry. */
	retry?: RetryConfig;
}

/**
 * When a notification email is sent after a relay run.
 *
 * - `"always"` — send after every run (a "the cron ran" heartbeat plus alerts).
 * - `"failure"` — send only when something went wrong (status `failed`,
 *   `partial`, `preflight-failed`, `aborted`, or a fatal error).
 */
export type NotifyTrigger = "always" | "failure";

/**
 * SMTP connection settings for email notifications. A subset of
 * `@marianmeres/send-email`'s `NodemailerTransportOptions`, expressed flat so
 * it reads naturally in JSON. All string values support `${ENV_VAR}`.
 */
export interface NotifySmtpConfig {
	/** SMTP server hostname. */
	host: string;
	/** SMTP server port. Default: `587` (STARTTLS; use `465` for implicit TLS). */
	port?: number;
	/** Use implicit TLS. Default: `port === 465`. */
	secure?: boolean;
	/** SMTP AUTH username. Omit (together with `pass`) for unauthenticated relays. */
	user?: string;
	/** SMTP AUTH password. Omit (together with `user`) for unauthenticated relays. */
	pass?: string;
	/**
	 * Connection timeout in ms — how long to wait for the TCP connect. Keep this
	 * modest so a notification to an unresponsive SMTP host can't stall a cron
	 * run. Default: send-email/nodemailer's own default.
	 */
	connectionTimeout?: number;
	/** Socket (data) timeout in ms. Default: send-email/nodemailer's own default. */
	socketTimeout?: number;
	/** TLS overrides for vanity hostnames / self-signed certs. */
	tls?: {
		/** SNI / certificate hostname override. */
		servername?: string;
		/** Set `false` to disable cert validation (insecure — last resort only). */
		rejectUnauthorized?: boolean;
	};
}

/**
 * Optional email notification for a relay run. Consumed by the CLI runner
 * (`cli.ts`) — the programmatic {@linkcode relay} function does not send mail,
 * so importing `@marianmeres/file-relay/mod` never pulls in an SMTP dependency.
 *
 * The email body is the captured run output (what the CLI logged), prefixed
 * with a one-line status summary. Uses `@marianmeres/send-email` underneath.
 */
export interface NotifyConfig {
	/** Recipient address, or a list of addresses. */
	to: string | string[];
	/** Sender address. */
	from: string;
	/** When to send. Default: `"always"`. See {@linkcode NotifyTrigger}. */
	on?: NotifyTrigger;
	/** Subject-line prefix. Default: `"[file-relay]"`. */
	subjectPrefix?: string;
	/** Reply-To address. */
	replyTo?: string;
	/** CC recipient, or a list of recipients. */
	cc?: string | string[];
	/** BCC recipient, or a list of recipients. */
	bcc?: string | string[];
	/**
	 * Attach the full captured run output as a `.log` file in addition to
	 * including it in the body. Default: `false`.
	 */
	attachLog?: boolean;
	/** SMTP connection settings. */
	smtp: NotifySmtpConfig;
}

/** Top-level configuration for a file-relay run. */
export interface FileRelayConfig {
	/** Directory for per-run log files. */
	logDir: string;
	/** Directory for deduplication tracking markers. */
	trackDir: string;
	/** Source directory configuration. */
	source: SourceConfig;
	/** Destination/transfer configuration. */
	destination: DestinationConfig;
	/** Optional transfer-level settings (concurrency, retry). */
	transfer?: TransferConfig;
	/**
	 * Optional email notification settings. Only the CLI runner acts on this;
	 * `relay()` ignores it. See {@linkcode NotifyConfig}.
	 */
	notify?: NotifyConfig;
}

// -----------------------------------------------------------------------------
// Env var interpolation
// -----------------------------------------------------------------------------

const ENV_VAR_RE = /\$\{([^}]+)\}/g;

function interpolateEnvVars(value: string): string {
	return value.replace(ENV_VAR_RE, (_match, varName: string) => {
		const val = Deno.env.get(varName);
		if (val === undefined) {
			throw new Error(
				`Environment variable "${varName}" is not set` +
					` (referenced in config)`,
			);
		}
		return val;
	});
}

/** Recursively interpolate ${ENV_VAR} in all string values. */
function interpolateDeep(obj: unknown): unknown {
	if (typeof obj === "string") return interpolateEnvVars(obj);
	if (Array.isArray(obj)) return obj.map(interpolateDeep);
	if (obj !== null && typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(obj)) {
			result[k] = interpolateDeep(v);
		}
		return result;
	}
	return obj;
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

function assertNonEmptyString(
	val: unknown,
	field: string,
): asserts val is string {
	if (typeof val !== "string" || val.trim() === "") {
		throw new Error(`"${field}" must be a non-empty string`);
	}
}

/**
 * Validates a boolean config field. Accepts a real JSON boolean, or a string
 * — `${ENV_VAR}` interpolation always yields strings, so an env-driven value
 * like `"false"` arrives here as text. Strings are parsed via parse-boolean in
 * strict mode so unrecognized values (e.g. a typo `"treu"`) throw rather than
 * silently becoming `false`, keeping config validation fail-loud.
 */
function assertBoolean(val: unknown, field: string): boolean {
	if (typeof val === "boolean") return val;
	if (typeof val === "string") {
		try {
			return parseBoolean(val, { strict: true });
		} catch {
			throw new Error(
				`"${field}" must be a boolean (got ${JSON.stringify(val)})`,
			);
		}
	}
	throw new Error(`"${field}" must be a boolean`);
}

function resolvePath(val: string, baseDir?: string): string {
	if (isAbsolute(val)) return resolve(val);
	return resolve(baseDir ?? Deno.cwd(), val);
}

function validateSource(raw: unknown, baseDir?: string): SourceConfig {
	if (!raw || typeof raw !== "object") {
		throw new Error(`"source" must be an object`);
	}
	const s = raw as Record<string, unknown>;

	assertNonEmptyString(s.dir, "source.dir");

	if (s.glob !== undefined) {
		assertNonEmptyString(s.glob, "source.glob");
	}
	if (s.exclude !== undefined) {
		if (!Array.isArray(s.exclude)) {
			throw new Error(`"source.exclude" must be an array`);
		}
		for (const e of s.exclude) {
			if (typeof e !== "string") {
				throw new Error(`"source.exclude" entries must be strings`);
			}
		}
	}
	for (const field of ["match", "ignore"] as const) {
		if (s[field] !== undefined) {
			if (!Array.isArray(s[field])) {
				throw new Error(`"source.${field}" must be an array`);
			}
			for (const pattern of s[field]) {
				if (typeof pattern !== "string") {
					throw new Error(
						`"source.${field}" entries must be strings`,
					);
				}
				try {
					new RegExp(pattern);
				} catch (e) {
					throw new Error(
						`"source.${field}" contains invalid regex "${pattern}": ${
							(e as Error).message
						}`,
					);
				}
			}
		}
	}
	const followSymlinks = s.followSymlinks === undefined
		? false
		: assertBoolean(s.followSymlinks, "source.followSymlinks");

	return {
		dir: resolvePath(s.dir as string, baseDir),
		glob: (s.glob as string) ?? "**/*",
		exclude: (s.exclude as string[]) ?? [],
		match: (s.match as string[]) ?? [],
		ignore: (s.ignore as string[]) ?? [],
		followSymlinks,
	};
}

function validateDestination(
	raw: unknown,
	baseDir?: string,
): DestinationConfig {
	if (!raw || typeof raw !== "object") {
		throw new Error(`"destination" must be an object`);
	}
	const d = raw as Record<string, unknown>;

	assertNonEmptyString(d.adapter, "destination.adapter");

	switch (d.adapter) {
		case "static-upload-server": {
			assertNonEmptyString(d.url, "destination.url");
			assertNonEmptyString(d.token, "destination.token");
			if (
				d.timeout !== undefined &&
				(typeof d.timeout !== "number" || d.timeout <= 0)
			) {
				throw new Error(
					`"destination.timeout" must be a positive number`,
				);
			}
			if (
				d.mode !== undefined && d.mode !== "put" && d.mode !== "multipart"
			) {
				throw new Error(
					`"destination.mode" must be "put" or "multipart"`,
				);
			}
			return {
				adapter: "static-upload-server",
				url: d.url as string,
				token: d.token as string,
				timeout: (d.timeout as number) ?? 300_000,
				mode: (d.mode as StaticUploadMode) ?? "put",
			};
		}
		case "filesystem": {
			assertNonEmptyString(d.dir, "destination.dir");
			let verify: "size" | "sha256" = "size";
			if (d.verify !== undefined) {
				if (d.verify !== "size" && d.verify !== "sha256") {
					throw new Error(
						`"destination.verify" must be "size" or "sha256"`,
					);
				}
				verify = d.verify;
			}
			return {
				adapter: "filesystem",
				dir: resolvePath(d.dir as string, baseDir),
				verify,
			};
		}
		default:
			throw new Error(
				`Unknown adapter "${d.adapter}".` +
					` Supported: "static-upload-server", "filesystem"`,
			);
	}
}

function validateTransfer(raw: unknown): TransferConfig | undefined {
	if (raw === undefined) return undefined;
	if (!raw || typeof raw !== "object") {
		throw new Error(`"transfer" must be an object`);
	}
	const t = raw as Record<string, unknown>;

	const out: TransferConfig = {};

	if (t.concurrency !== undefined) {
		if (
			typeof t.concurrency !== "number" ||
			!Number.isInteger(t.concurrency) ||
			t.concurrency < 1
		) {
			throw new Error(
				`"transfer.concurrency" must be a positive integer`,
			);
		}
		out.concurrency = t.concurrency;
	}

	if (t.retry !== undefined) {
		if (!t.retry || typeof t.retry !== "object") {
			throw new Error(`"transfer.retry" must be an object`);
		}
		const r = t.retry as Record<string, unknown>;
		const retry: RetryConfig = {};
		if (r.attempts !== undefined) {
			if (
				typeof r.attempts !== "number" ||
				!Number.isInteger(r.attempts) ||
				r.attempts < 1
			) {
				throw new Error(
					`"transfer.retry.attempts" must be a positive integer`,
				);
			}
			retry.attempts = r.attempts;
		}
		for (const k of ["backoffMs", "maxBackoffMs"] as const) {
			if (r[k] !== undefined) {
				if (typeof r[k] !== "number" || r[k] < 0) {
					throw new Error(
						`"transfer.retry.${k}" must be a non-negative number`,
					);
				}
				retry[k] = r[k];
			}
		}
		out.retry = retry;
	}

	return out;
}

function assertAddress(
	val: unknown,
	field: string,
): string | string[] {
	if (typeof val === "string") {
		if (val.trim() === "") {
			throw new Error(`"${field}" must be a non-empty string`);
		}
		return val;
	}
	if (Array.isArray(val)) {
		if (val.length === 0) {
			throw new Error(`"${field}" must not be an empty array`);
		}
		for (const entry of val) {
			if (typeof entry !== "string" || entry.trim() === "") {
				throw new Error(
					`"${field}" entries must be non-empty strings`,
				);
			}
		}
		return val as string[];
	}
	throw new Error(`"${field}" must be a string or an array of strings`);
}

function validateNotifySmtp(raw: unknown): NotifySmtpConfig {
	if (!raw || typeof raw !== "object") {
		throw new Error(`"notify.smtp" must be an object`);
	}
	const s = raw as Record<string, unknown>;

	assertNonEmptyString(s.host, "notify.smtp.host");

	const out: NotifySmtpConfig = { host: s.host as string, port: 587 };

	if (s.port !== undefined) {
		if (
			typeof s.port !== "number" ||
			!Number.isInteger(s.port) ||
			s.port < 1 ||
			s.port > 65535
		) {
			throw new Error(
				`"notify.smtp.port" must be an integer between 1 and 65535`,
			);
		}
		out.port = s.port;
	}

	if (s.secure !== undefined) {
		out.secure = assertBoolean(s.secure, "notify.smtp.secure");
	}

	for (const k of ["connectionTimeout", "socketTimeout"] as const) {
		if (s[k] !== undefined) {
			if (typeof s[k] !== "number" || !(s[k] as number > 0)) {
				throw new Error(`"notify.smtp.${k}" must be a positive number`);
			}
			out[k] = s[k] as number;
		}
	}

	// Auth is all-or-nothing: a lone user or pass is almost always a mistake.
	const hasUser = s.user !== undefined;
	const hasPass = s.pass !== undefined;
	if (hasUser !== hasPass) {
		throw new Error(
			`"notify.smtp.user" and "notify.smtp.pass" must be set together`,
		);
	}
	if (hasUser) {
		assertNonEmptyString(s.user, "notify.smtp.user");
		assertNonEmptyString(s.pass, "notify.smtp.pass");
		out.user = s.user as string;
		out.pass = s.pass as string;
	}

	if (s.tls !== undefined) {
		if (!s.tls || typeof s.tls !== "object") {
			throw new Error(`"notify.smtp.tls" must be an object`);
		}
		const t = s.tls as Record<string, unknown>;
		const tls: NotifySmtpConfig["tls"] = {};
		if (t.servername !== undefined) {
			assertNonEmptyString(t.servername, "notify.smtp.tls.servername");
			tls.servername = t.servername as string;
		}
		if (t.rejectUnauthorized !== undefined) {
			tls.rejectUnauthorized = assertBoolean(
				t.rejectUnauthorized,
				"notify.smtp.tls.rejectUnauthorized",
			);
		}
		out.tls = tls;
	}

	return out;
}

function validateNotify(raw: unknown): NotifyConfig | undefined {
	if (raw === undefined) return undefined;
	if (!raw || typeof raw !== "object") {
		throw new Error(`"notify" must be an object`);
	}
	const n = raw as Record<string, unknown>;

	const to = assertAddress(n.to, "notify.to");
	assertNonEmptyString(n.from, "notify.from");

	const out: NotifyConfig = {
		to,
		from: n.from,
		on: "always",
		subjectPrefix: "[file-relay]",
		attachLog: false,
		smtp: validateNotifySmtp(n.smtp),
	};

	if (n.on !== undefined) {
		if (n.on !== "always" && n.on !== "failure") {
			throw new Error(`"notify.on" must be "always" or "failure"`);
		}
		out.on = n.on;
	}

	if (n.subjectPrefix !== undefined) {
		if (typeof n.subjectPrefix !== "string") {
			throw new Error(`"notify.subjectPrefix" must be a string`);
		}
		out.subjectPrefix = n.subjectPrefix;
	}

	if (n.replyTo !== undefined) {
		assertNonEmptyString(n.replyTo, "notify.replyTo");
		out.replyTo = n.replyTo as string;
	}

	if (n.cc !== undefined) out.cc = assertAddress(n.cc, "notify.cc");
	if (n.bcc !== undefined) out.bcc = assertAddress(n.bcc, "notify.bcc");

	if (n.attachLog !== undefined) {
		out.attachLog = assertBoolean(n.attachLog, "notify.attachLog");
	}

	return out;
}

/**
 * Validate a raw object as a {@linkcode FileRelayConfig}.
 * Throws descriptive errors on invalid input.
 *
 * Relative paths in the config are resolved against `baseDir` if provided,
 * otherwise against `Deno.cwd()`. When calling programmatically you should
 * prefer passing an explicit `baseDir` (or absolute paths) to avoid cwd-
 * dependent behaviour.
 */
export function validateConfig(
	raw: unknown,
	baseDir?: string,
): FileRelayConfig {
	if (!raw || typeof raw !== "object") {
		throw new Error(`Config must be a JSON object`);
	}
	const c = raw as Record<string, unknown>;

	assertNonEmptyString(c.logDir, "logDir");
	assertNonEmptyString(c.trackDir, "trackDir");

	const source = validateSource(c.source, baseDir);
	const destination = validateDestination(c.destination, baseDir);
	const transfer = validateTransfer(c.transfer);
	const notify = validateNotify(c.notify);

	const result: FileRelayConfig = {
		logDir: resolvePath(c.logDir as string, baseDir),
		trackDir: resolvePath(c.trackDir as string, baseDir),
		source,
		destination,
	};
	if (transfer) result.transfer = transfer;
	if (notify) result.notify = notify;
	return result;
}

// -----------------------------------------------------------------------------
// Loading
// -----------------------------------------------------------------------------

/**
 * Load, parse, interpolate env vars, and validate a JSON config file.
 * Relative paths in the config are resolved against the config file's directory.
 *
 * @example
 * ```ts
 * const config = await loadConfig("./relay-config.json");
 * ```
 */
export async function loadConfig(path: string): Promise<FileRelayConfig> {
	const resolvedPath = resolve(path);
	const text = await Deno.readTextFile(resolvedPath);
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error(`Failed to parse config file "${path}" as JSON`);
	}
	const interpolated = interpolateDeep(raw);
	return validateConfig(interpolated, dirname(resolvedPath));
}
