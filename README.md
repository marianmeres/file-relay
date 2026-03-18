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
```

## CLI Options

```
deno run -A jsr:@marianmeres/file-relay <config.json> [options]

Options:
  --dry-run       Find and report files without transferring
  --verbose       Enable debug-level log output
  --help          Show help message
  --version       Show version
```

## Configuration

### Source

| Field            | Type       | Default  | Description                       |
| ---------------- | ---------- | -------- | --------------------------------- |
| `dir`            | `string`   | required | Absolute path to source directory |
| `glob`           | `string`   | `"**/*"` | Glob pattern for file matching    |
| `exclude`        | `string[]` | `[]`     | Glob patterns to exclude          |
| `followSymlinks` | `boolean`  | `false`  | Whether to follow symlinks        |

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

| Field     | Type           | Default  | Description                       |
| --------- | -------------- | -------- | --------------------------------- |
| `adapter` | `"filesystem"` | required | Adapter type                      |
| `dir`     | `string`       | required | Absolute path to target directory |

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
const result = await relay(config, { dryRun: false });

if (result.success) {
	console.log(`Transferred ${result.transfers.length} file(s)`);
} else {
	console.error("Some transfers failed");
}
```

## Logging

Each `relay()` call automatically creates a timestamped log file in `logDir`
(e.g. `file-relay-2026-03-18T12-54-01-927Z.log`). This works from both the CLI
and the programmatic API. Console output continues normally via `@marianmeres/clog`.

## How It Works

1. **Scan** -- Recursively walk source directory, match files by glob, exclude patterns
2. **Filter** -- Skip files already marked as transferred (via filesystem marker files)
3. **Transfer** -- Upload/copy each file using the configured adapter
4. **Track** -- Write a `.transferred.json` marker for each successful transfer
5. **Log** -- Write detailed per-run log file to `logDir`

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

## License

[MIT](LICENSE)
