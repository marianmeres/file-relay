# API

## Functions

### `loadConfig(path)`

Load, parse, interpolate environment variables, and validate a JSON config file.
Relative paths in the file are resolved against the config file's directory.

**Parameters:**

- `path` (`string`) -- Path to the JSON config file

**Returns:** `Promise<FileRelayConfig>`

**Throws:** `Error` if the file is not valid JSON, validation fails, or referenced env vars are unset.

**Example:**

```typescript
import { loadConfig } from "@marianmeres/file-relay/mod";

const config = await loadConfig("./relay-config.json");
```

---

### `validateConfig(raw, baseDir?)`

Validate a raw object as a `FileRelayConfig`. Useful when constructing config programmatically.

Relative paths in the config are resolved against `baseDir` if provided, otherwise
against `Deno.cwd()`. When calling programmatically, prefer passing an explicit
`baseDir` (or using absolute paths) to avoid cwd-dependent behaviour.

**Parameters:**

- `raw` (`unknown`) -- Raw object to validate
- `baseDir` (`string`, optional) -- Base directory for resolving relative paths

**Returns:** `FileRelayConfig`

**Throws:** `Error` with descriptive message on invalid input.

**Example:**

```typescript
import { validateConfig } from "@marianmeres/file-relay/mod";

const config = validateConfig({
	logDir: "/tmp/logs",
	trackDir: "/tmp/track",
	source: { dir: "/data/backups", glob: "**/*.sql.gz" },
	destination: { adapter: "filesystem", dir: "/mnt/offsite" },
	transfer: { concurrency: 4, retry: { attempts: 3 } },
});
```

---

### `findFiles(source)`

Recursively scan a source directory and return matching files, sorted by mtime descending.
When `followSymlinks: true`, symlink cycles are detected via a visited-realpath set.

**Parameters:**

- `source` (`SourceConfig`) -- Source directory configuration

**Returns:** `Promise<FileInfo[]>`

**Example:**

```typescript
import { findFiles } from "@marianmeres/file-relay/mod";

const files = await findFiles({
	dir: "/data/backups",
	glob: "**/*.sql.gz",
	exclude: ["**/*-latest.sql.gz"],
	match: ["daily", "weekly"], // regex whitelist (OR logic)
	ignore: ["\\.tmp$"], // regex blacklist
});
// files[0] is the most recently modified
```

---

### `createTracker(trackDir)`

Create a filesystem-based tracker for deduplication. Stores `.transferred.json` marker files under `trackDir`, mirroring the source directory structure.

**Parameters:**

- `trackDir` (`string`) -- Directory for marker files

**Returns:** `Tracker`

**Example:**

```typescript
import { createTracker } from "@marianmeres/file-relay/mod";

const tracker = createTracker("/var/lib/file-relay/track");

// Remove stray .tmp markers from a previous crash
const swept = await tracker.sweepTmp();

if (!await tracker.isTransferred("daily/backup.sql.gz")) {
	// ... transfer the file ...
	await tracker.markTransferred("daily/backup.sql.gz", {
		transferredAt: new Date().toISOString(),
		sourcePath: "/data/backups/daily/backup.sql.gz",
		sourceSize: 1024,
		destinationInfo: "https://host/backups",
	});
}
```

---

### `createAdapter(config)`

Create a `RelayAdapter` based on the destination config. Dispatches on the `adapter` discriminator field.

**Parameters:**

- `config` (`DestinationConfig`) -- Destination configuration

**Returns:** `RelayAdapter`

**Example:**

```typescript
import { createAdapter } from "@marianmeres/file-relay/mod";

const adapter = createAdapter({
	adapter: "static-upload-server",
	url: "https://files.example.com/backups",
	token: "secret",
});

// Optional: verify the destination is reachable before transferring
const check = await adapter.check?.();
if (check && !check.ok) throw new Error(check.error);
```

---

### `relay(config, options?)`

Run the file relay: scan source, filter already-transferred files, transfer new files, and record results. Automatically creates a timestamped log file in `config.logDir`.

**Parameters:**

- `config` (`FileRelayConfig`) -- Full relay configuration
- `options` (`RelayOptions`, optional)
  - `options.dryRun` (`boolean`) -- Find files without transferring. Default: `false`
  - `options.clog` (`ClogFn | Clog`) -- Logger instance. Default: `createClog("file-relay")`
  - `options.signal` (`AbortSignal`) -- Abort the run; in-flight transfers are cancelled, already-completed transfers stay committed.

**Returns:** `Promise<RelayRunResult>`

**Example:**

```typescript
import { loadConfig, relay } from "@marianmeres/file-relay/mod";

const config = await loadConfig("./config.json");
const controller = new AbortController();
const result = await relay(config, {
	dryRun: true,
	signal: controller.signal,
});

if (result.status === "ok") {
	console.log(`Found: ${result.filesFound}`);
}
```

---

## Types

### `FileRelayConfig`

```typescript
interface FileRelayConfig {
	logDir: string; // Directory for per-run log files
	trackDir: string; // Directory for deduplication markers
	source: SourceConfig;
	destination: DestinationConfig;
	transfer?: TransferConfig; // Optional retry/concurrency
	notify?: NotifyConfig; // Optional email notification (CLI runner only)
}
```

---

### `SourceConfig`

```typescript
interface SourceConfig {
	dir: string; // Base directory (absolute)
	glob?: string; // Glob pattern. Default: "**/*"
	exclude?: string[]; // Glob exclusion patterns. Default: []
	match?: string[]; // Regex whitelist (partial match). Default: []
	ignore?: string[]; // Regex blacklist (partial match). Default: []
	followSymlinks?: boolean; // Default: false
}
```

---

### `DestinationConfig`

Discriminated union:

```typescript
type DestinationConfig =
	| StaticUploadServerDestination
	| FilesystemCopyDestination;
```

---

### `StaticUploadServerDestination`

```typescript
type StaticUploadMode = "put" | "multipart";

interface StaticUploadServerDestination {
	adapter: "static-upload-server";
	url: string; // Server URL with project path
	token: string; // Bearer token (supports ${ENV_VAR})
	timeout?: number; // Request timeout in ms. Default: 300000
	mode?: StaticUploadMode; // Wire format. Default: "put"
}
```

`mode: "put"` (the default) uploads the file as the raw body of
`PUT {url}/{relativePath}`, which the server streams straight to disk — required for
large files, and requires deno-static-upload-server >= 1.7.0. `mode: "multipart"` is the
legacy `multipart/form-data` POST, which makes the server buffer the entire file in
memory (~3x the file size in RSS); use it only against a server older than 1.7.0. See the
[README](./README.md#mode--and-why-the-default-matters-for-large-files) for measurements.

In `"put"` mode a successful response reports the number of bytes the server stored;
the adapter fails the transfer if that doesn't match the source size, so an upload
truncated by a dropped connection is retried rather than marked as transferred.

---

### `FilesystemCopyDestination`

```typescript
interface FilesystemCopyDestination {
	adapter: "filesystem";
	dir: string; // Target directory (absolute)
	verify?: "size" | "sha256"; // Post-copy verification. Default: "size"
}
```

---

### `TransferConfig`

```typescript
interface TransferConfig {
	concurrency?: number; // Max parallel transfers. Default: 1
	retry?: RetryConfig; // Retry policy. Default: no retry
}
```

---

### `RetryConfig`

```typescript
interface RetryConfig {
	attempts?: number; // Total attempts incl. first. Default: 1
	backoffMs?: number; // Initial delay ms. Default: 1000
	maxBackoffMs?: number; // Cap on computed backoff. Default: 30000
}
```

Backoff doubles between attempts, capped at `maxBackoffMs`.

---

### `NotifyConfig`

Optional email notification for a relay run. Acted upon **only by the CLI runner** —
the programmatic `relay()` ignores it, so importing `@marianmeres/file-relay/mod`
never pulls in an SMTP dependency. All string fields support `${ENV_VAR}` interpolation.

```typescript
interface NotifyConfig {
	to: string | string[]; // Recipient(s)
	from: string; // Sender address
	on?: NotifyTrigger; // When to send. Default: "always"
	subjectPrefix?: string; // Subject prefix. Default: "[file-relay]"
	replyTo?: string; // Reply-To address
	cc?: string | string[]; // CC recipient(s)
	bcc?: string | string[]; // BCC recipient(s)
	attachLog?: boolean; // Attach captured output as a .log file. Default: false
	smtp: NotifySmtpConfig; // SMTP connection settings
}
```

The email subject summarizes the outcome (e.g. `[file-relay] OK on host — 3 transferred`)
and the body is the captured run output preceded by a one-line status header.

---

### `NotifyTrigger`

```typescript
type NotifyTrigger =
	| "always" // Send after every run (heartbeat + alerts)
	| "failure"; // Send only on failed/partial/preflight-failed/aborted or a fatal error
```

---

### `NotifySmtpConfig`

```typescript
interface NotifySmtpConfig {
	host: string; // SMTP server hostname
	port?: number; // SMTP port. Default: 587 (465 for implicit TLS)
	secure?: boolean; // Use implicit TLS. Default: port === 465
	user?: string; // SMTP AUTH username (set together with pass)
	pass?: string; // SMTP AUTH password (set together with user)
	connectionTimeout?: number; // TCP connect timeout (ms)
	socketTimeout?: number; // Socket/data timeout (ms)
	tls?: { // TLS overrides for vanity hosts / self-signed certs
		servername?: string;
		rejectUnauthorized?: boolean;
	};
}
```

---

### `FileInfo`

```typescript
interface FileInfo {
	path: string; // Absolute path
	relativePath: string; // Relative to source.dir
	name: string; // Basename
	size: number; // Bytes
	mtime: Date; // Modification time
}
```

---

### `TransferResult`

```typescript
interface TransferResult {
	success: boolean;
	sourceFile: FileInfo;
	destination: string; // Human-readable description
	error?: string; // Short, single-line error message if failed
	errorDetail?: string; // Verbose multi-line diagnostic dump if failed
	bytesTransferred?: number;
	durationMs?: number;
	attempts?: number; // Set when retries were used
}
```

`error` is kept short and single-line (a long HTTP error body is truncated to 300
chars) because it goes into the run log and the notification email.

`errorDetail` is the unabridged version: request as sent, response status line and
all response headers, and the full response body — or, when no response arrived,
whether it timed out vs. was aborted plus the thrown error's stack and `cause`
chain. `relay()` writes it to a per-failure dump file in `logDir`; see the
[Failure dumps](./README.md#failure-dumps) section. Credentials are never included.

---

### `TransferOptions`

```typescript
interface TransferOptions {
	signal?: AbortSignal; // Cancel the in-flight transfer
}
```

---

### `CheckResult`

```typescript
interface CheckResult {
	ok: boolean;
	error?: string; // Set when ok is false
}
```

---

### `RelayStatus`

```typescript
type RelayStatus =
	| "idle" // No files needed transferring
	| "ok" // All attempted transfers succeeded
	| "partial" // Some succeeded, some failed
	| "failed" // All failed
	| "aborted" // Run was aborted
	| "preflight-failed"; // Destination preflight failed
```

---

### `RelayRunResult`

```typescript
interface RelayRunResult {
	startedAt: string; // ISO timestamp
	finishedAt: string; // ISO timestamp
	durationMs: number;
	filesFound: number;
	filesAlreadyTransferred: number;
	transfers: TransferResult[];
	status: RelayStatus; // Structured outcome
	success: boolean; // true iff no transfer failed (kept for 1.x compat)
}
```

---

### `RelayAdapter`

```typescript
interface RelayAdapter {
	readonly name: string;
	transfer(
		file: FileInfo,
		options?: TransferOptions,
	): Promise<TransferResult>;
	check?(): Promise<CheckResult>; // Optional preflight
}
```

---

### `Tracker`

```typescript
interface Tracker {
	isTransferred(relativePath: string): Promise<boolean>;
	markTransferred(relativePath: string, meta: TransferMeta): Promise<void>;
	sweepTmp(): Promise<number>; // Remove stale *.transferred.json.tmp files
}
```

---

### `TransferMeta`

```typescript
interface TransferMeta {
	transferredAt: string; // ISO timestamp
	sourcePath: string; // Absolute path to source file
	sourceSize: number; // Bytes
	destinationInfo: string; // Human-readable description
}
```

---

### `RelayOptions`

```typescript
interface RelayOptions {
	dryRun?: boolean; // Find files without transferring
	clog?: ClogFn | Clog; // Logger instance (compatible with @marianmeres/clog)
	signal?: AbortSignal; // Abort the run
}
```
