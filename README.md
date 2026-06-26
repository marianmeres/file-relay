# @marianmeres/file-relay

[![JSR](https://jsr.io/badges/@marianmeres/file-relay)](https://jsr.io/@marianmeres/file-relay)
[![License](https://img.shields.io/npm/l/@marianmeres/file-relay)](LICENSE)

> Mirror a source directory tree to a destination, transferring anything not yet transferred.

CLI tool and library for transferring local files to a remote destination. Scans
a source directory, uploads unprocessed files, and tracks successful transfers to
prevent duplicates. Designed for cron-based offsite backup relay.

## Installation

```bash
# Run directly (no install needed)
deno run -A jsr:@marianmeres/file-relay config.json

# Scaffold a new relay instance interactively
deno run -A jsr:@marianmeres/file-relay/install <dirname>

# Or add to your project
deno add jsr:@marianmeres/file-relay
```

## Quick Start

### Scaffolding a New Instance

The fastest way to set up a new relay:

```bash
deno run -A jsr:@marianmeres/file-relay/install my-backup
```

This interactively prompts for source directory and adapter type, then creates a
ready-to-use directory with `config.json`, `deno.json`, `.env.example`, `log/`,
and `track/`. After that:

```bash
cd my-backup
cp .env.example .env && $EDITOR .env   # fill in credentials
# setup cron: deno task backup
```

### Manual Setup

Create a `relay-config.json`:

```json
{
	"logDir": "/var/log/file-relay",
	"trackDir": "/var/lib/file-relay/track",
	"source": {
		"dir": "/data/backups",
		"glob": "**/*.sql.gz",
		"exclude": ["**/*-latest.sql.gz"]
	},
	"destination": {
		"adapter": "static-upload-server",
		"url": "https://files.example.com/backups",
		"token": "${RELAY_UPLOAD_TOKEN}"
	}
}
```

Run it:

```bash
# Dry run (see what would be transferred)
deno run -A jsr:@marianmeres/file-relay relay-config.json --dry-run

# Actual transfer
deno run -A jsr:@marianmeres/file-relay relay-config.json
```

Set up as a cron job:

```bash
# Every hour
0 * * * * RELAY_UPLOAD_TOKEN=secret deno run -A jsr:@marianmeres/file-relay /etc/file-relay/config.json

# Daily, loading credentials (upload token, SMTP, ...) from an .env file
0 3 * * * deno run -A --env-file=/etc/file-relay/.env jsr:@marianmeres/file-relay /etc/file-relay/config.json
```

With a `notify` block configured (see [Email Notifications](#email-notifications-optional)),
each run emails you its result — a daily "it ran" confirmation, or an immediate
alert when a transfer fails.

## CLI Options

```
deno run -A jsr:@marianmeres/file-relay <config.json> [options]

Options:
  --dry-run                Find and report files without transferring
  --verbose                Enable debug-level log output
  --concurrency=N          Override config.transfer.concurrency
  --retry-attempts=N       Override config.transfer.retry.attempts
  --no-notify              Suppress the email notification for this run
  --help                   Show help message
  --version                Show version
```

The process exits with:

| Code  | Meaning                                                   |
| ----- | --------------------------------------------------------- |
| `0`   | Every attempted transfer succeeded (or nothing to do)     |
| `1`   | At least one transfer failed, or adapter preflight failed |
| `2`   | Config/usage error, or fatal error before transfer        |
| `130` | Run was aborted via SIGINT/SIGTERM                        |

## Configuration

### Source

| Field            | Type       | Default  | Description                                            |
| ---------------- | ---------- | -------- | ------------------------------------------------------ |
| `dir`            | `string`   | required | Absolute path to source directory                      |
| `glob`           | `string`   | `"**/*"` | Glob pattern for file matching                         |
| `exclude`        | `string[]` | `[]`     | Glob patterns to exclude                               |
| `match`          | `string[]` | `[]`     | Regex whitelist — path must match at least one pattern |
| `ignore`         | `string[]` | `[]`     | Regex blacklist — matching paths are excluded          |
| `followSymlinks` | `boolean`  | `false`  | Whether to follow symlinks                             |

`match` and `ignore` use JavaScript regular expressions tested via `RegExp.test()`
against the file's **relative path** (partial match — no anchoring unless you use
`^`/`$`). Inline flags like `(?i)` are supported for case-insensitive matching.

When both glob and regex filters are configured, the filtering pipeline is:
`glob` → `exclude` → `match` → `ignore`.

> **Note:** Since patterns are stored in JSON, backslashes must be doubled
> (e.g., `"\\.sql\\.gz$"` to match the literal `.sql.gz` suffix).

**Example** — relay only files from paths containing "daily" or "weekly", but skip
anything ending in `-latest.sql.gz`:

```json
{
	"source": {
		"dir": "/data/backups",
		"glob": "**/*.sql.gz",
		"exclude": ["**/*-latest.sql.gz"],
		"match": ["daily", "weekly"],
		"ignore": ["-latest\\.sql\\.gz$"]
	}
}
```

### Destination: `static-upload-server`

Uploads via HTTP POST (multipart/form-data) to a
[@marianmeres/deno-static-upload-server](https://jsr.io/@marianmeres/deno-static-upload-server) instance.

| Field     | Type                     | Default  | Description                       |
| --------- | ------------------------ | -------- | --------------------------------- |
| `adapter` | `"static-upload-server"` | required | Adapter type                      |
| `url`     | `string`                 | required | Server URL including project path |
| `token`   | `string`                 | required | Bearer token for auth             |
| `timeout` | `number`                 | `300000` | Request timeout in ms             |

### Destination: `filesystem`

Copies files to a local or mounted directory.

| Field     | Type                 | Default  | Description                             |
| --------- | -------------------- | -------- | --------------------------------------- |
| `adapter` | `"filesystem"`       | required | Adapter type                            |
| `dir`     | `string`             | required | Absolute path to target directory       |
| `verify`  | `"size" \| "sha256"` | `"size"` | Post-copy verification mode (see below) |

`verify: "size"` (the default) compares the copied file's byte size against
the source — fast, catches truncation. `verify: "sha256"` additionally hashes
both files and compares digests, catching silent corruption. The SHA-256 path
buffers the file in memory (WebCrypto has no streaming digest); use it when
correctness matters more than throughput.

### Transfer (optional)

Top-level `transfer` object controls retry and concurrency for all adapters:

| Field                | Type     | Default | Description                                            |
| -------------------- | -------- | ------- | ------------------------------------------------------ |
| `concurrency`        | `number` | `1`     | Max files transferred in parallel                      |
| `retry.attempts`     | `number` | `1`     | Total attempts per file (including the first)          |
| `retry.backoffMs`    | `number` | `1000`  | Initial backoff between retries (doubles each attempt) |
| `retry.maxBackoffMs` | `number` | `30000` | Cap on the computed backoff delay                      |

```json
{
	"transfer": {
		"concurrency": 4,
		"retry": { "attempts": 3, "backoffMs": 1000 }
	}
}
```

### Email Notifications (optional)

Add a top-level `notify` block to get an email after each run — a "the cron ran"
heartbeat plus an immediate alert when something fails. The email subject carries
the status at a glance (so you can triage from the inbox), and the body is the run's
log output. Uses [@marianmeres/send-email](https://jsr.io/@marianmeres/send-email)
(SMTP) under the hood.

```json
{
	"notify": {
		"to": "ops@example.com",
		"from": "file-relay@myserver",
		"on": "always",
		"smtp": {
			"host": "${SMTP_HOST}",
			"port": 587,
			"user": "${SMTP_USER}",
			"pass": "${SMTP_PASS}"
		}
	}
}
```

| Field           | Type                   | Default          | Description                                                |
| --------------- | ---------------------- | ---------------- | ---------------------------------------------------------- |
| `to`            | `string \| string[]`   | required         | Recipient address(es)                                      |
| `from`          | `string`               | required         | Sender address                                             |
| `on`            | `"always" \| "failure"`| `"always"`       | Send every run, or only on a failed/abnormal run           |
| `subjectPrefix` | `string`               | `"[file-relay]"` | Prepended to every subject line                            |
| `replyTo`       | `string`               | —                | Reply-To address                                           |
| `cc` / `bcc`    | `string \| string[]`   | —                | Carbon-copy recipient(s)                                   |
| `attachLog`     | `boolean`              | `false`          | Also attach the captured output as a `.log` file           |
| `smtp.host`     | `string`               | required         | SMTP server hostname                                       |
| `smtp.port`     | `number`               | `587`            | SMTP port (`465` for implicit TLS)                         |
| `smtp.secure`   | `boolean`              | `port === 465`   | Use implicit TLS                                           |
| `smtp.user`     | `string`               | —                | SMTP AUTH username (set together with `pass`)              |
| `smtp.pass`     | `string`               | —                | SMTP AUTH password (set together with `user`)              |
| `smtp.connectionTimeout` | `number`      | —                | Connect timeout (ms) — keep modest so a dead SMTP host can't stall the cron |
| `smtp.socketTimeout` | `number`          | —                | Socket/data timeout (ms)                                   |
| `smtp.tls`      | `object`               | —                | `{ servername?, rejectUnauthorized? }` TLS overrides       |

`on: "failure"` fires when the run status is `failed`, `partial`, `preflight-failed`,
or `aborted`, or when a fatal error is thrown. A subject like
`[file-relay] OK on host — 3 transferred` means everything is fine;
`[file-relay] FAILED on host — 0 transferred, 2 failed` means look now.

Notes:

- Like all config strings, SMTP credentials support `${ENV_VAR}` — keep secrets in
  `.env`, never in the committed config.
- Notifications are **skipped** for `--dry-run` and when `--no-notify` is passed.
  (`${ENV_VAR}`s referenced under `notify.smtp` must still resolve at load time even
  then — interpolation happens once, when the config is loaded.)
- A failed email send **never** changes the exit code — it is logged as a warning
  to stderr (so a cron `MAILTO` still catches it) and the run's own status stands.
- Omit `notify` entirely and nothing changes — the SMTP dependency is only loaded
  when a notification is actually sent.

### Environment Variable Interpolation

String values in config support `${ENV_VAR}` syntax, resolved at load time:

```json
{
	"destination": {
		"token": "${MY_SECRET_TOKEN}"
	}
}
```

## Programmatic API

```typescript
import { loadConfig, relay } from "@marianmeres/file-relay/mod";

const config = await loadConfig("./relay-config.json");

// Optional AbortSignal — in-flight transfers honour it.
const controller = new AbortController();

const result = await relay(config, {
	dryRun: false,
	signal: controller.signal,
});

switch (result.status) {
	case "ok":
		console.log(`Transferred ${result.transfers.length} file(s)`);
		break;
	case "idle":
		console.log("Nothing to do");
		break;
	case "partial":
		console.warn(`Some transfers failed`);
		break;
	case "failed":
		console.error("All transfers failed");
		break;
	case "preflight-failed":
		console.error("Destination is not reachable");
		break;
	case "aborted":
		console.warn("Aborted by caller");
		break;
}
```

Files are streamed to the destination — `file-relay` does not buffer the
entire file in memory, so multi-gigabyte backups are safe on modest hardware.

## Logging

Each `relay()` call automatically creates a timestamped log file in `logDir`
(e.g. `file-relay-2026-03-18T12-54-01-927Z.log`). This works from both the CLI
and the programmatic API. Console output continues normally via `@marianmeres/clog`.

## How It Works

1. **Scan** -- Recursively walk source directory, filter by glob and regex patterns
2. **Filter** -- Skip files already marked as transferred (via filesystem marker files)
3. **Transfer** -- Upload/copy each file using the configured adapter
4. **Track** -- Write a `.transferred.json` marker for each successful transfer
5. **Log** -- Write detailed per-run log file to `logDir`
6. **Notify** -- (CLI, optional) email the run output via SMTP when `notify` is configured

Each run is idempotent: re-running transfers only new/unprocessed files.

## Example

A working example against a real server is included in `example/`:

```bash
# Copy and fill in your credentials
cp example/.env.example example/.env

# Run the example
deno task example
```

## API

See [API.md](API.md) for complete API documentation.

## Upgrading to 1.3

Mostly additive, but a few edge-case behaviours changed. **Nothing that was
previously valid stops working** — but the following are worth being aware of:

- **HTTP uploads are now streamed.** Pre-1.3 loaded the entire file into memory
  via `Deno.readFile()`. 1.3 streams the multipart body directly from disk.
  Memory footprint is now constant regardless of file size. No config change
  needed. The `Content-Length` header is now always set (it wasn't before).
- **Adapters run a preflight check before any transfer.** If the destination
  is unreachable/unwritable, the run now fails fast with
  `status: "preflight-failed"` instead of attempting each file and recording
  N per-file errors. Net behavioural change: `transfers` in the result is
  empty in this case (was N-long before). Exit code is still non-zero.
- **`RelayRunResult.status`** — new field with `"ok" | "partial" | "failed" |
  "idle" | "aborted" | "preflight-failed"`. The boolean `success` is still
  set for backwards compatibility and still means "no transfer failed".
  A `"preflight-failed"` run reports `success: false`.
- **Absolute paths with trailing slashes** (`/tmp/logs/`) used to be silently
  re-rooted under `baseDir` when `loadConfig` was called from a different
  directory. They now resolve correctly (`/tmp/logs`). If you were relying on
  the buggy behaviour, use explicitly relative paths instead.
- **`createClog.global.hook` is no longer clobbered.** Pre-1.3 `relay()`
  replaced the global hook while running so per-run log files captured
  output. It still does that, but the replacement is now reentrancy-safe and
  restored on finish. Two `relay()` calls running in parallel in the same
  process no longer corrupt each other's log files. If your code explicitly
  read `createClog.global.hook` while a relay was running, you'd still
  observe a temporary replacement — that's intentional.
- **Symlink cycles no longer hang.** With `followSymlinks: true`, cyclic
  symlinks are now detected via a visited-realpath set instead of recursing
  forever.

No new Deno permissions are required.

## License

[MIT](LICENSE)
