import { dirname, isAbsolute, resolve } from "@std/path";

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
	if (
		s.followSymlinks !== undefined &&
		typeof s.followSymlinks !== "boolean"
	) {
		throw new Error(`"source.followSymlinks" must be a boolean`);
	}

	return {
		dir: resolvePath(s.dir as string, baseDir),
		glob: (s.glob as string) ?? "**/*",
		exclude: (s.exclude as string[]) ?? [],
		match: (s.match as string[]) ?? [],
		ignore: (s.ignore as string[]) ?? [],
		followSymlinks: (s.followSymlinks as boolean) ?? false,
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
			return {
				adapter: "static-upload-server",
				url: d.url as string,
				token: d.token as string,
				timeout: (d.timeout as number) ?? 300_000,
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

	const result: FileRelayConfig = {
		logDir: resolvePath(c.logDir as string, baseDir),
		trackDir: resolvePath(c.trackDir as string, baseDir),
		source,
		destination,
	};
	if (transfer) result.transfer = transfer;
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
