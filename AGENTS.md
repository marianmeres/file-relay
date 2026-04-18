# @marianmeres/file-relay -- Agent Guide

## Quick Reference

```yaml
name: "@marianmeres/file-relay"
license: "MIT"
repository: "https://github.com/marianmeres/file-relay"
registry_jsr: "https://jsr.io/@marianmeres/file-relay"
```

- **Stack**: TypeScript, Deno
- **Run**: `deno run -A jsr:@marianmeres/file-relay <config.json>`
- **Install**: `deno run -A jsr:@marianmeres/file-relay/install <dirname>`
- **Test**: `deno test -A`
- **Lint**: `deno lint`
- **Format**: `deno fmt`

## Purpose

CLI tool and library that scans a local source directory, transfers unprocessed
files to a remote destination, and tracks successful transfers to prevent
duplicates. Designed for cron-based offsite backup relay (e.g. database dumps).

## Architecture

### File Structure

```
src/
  cli.ts                          # CLI entry point (default export ".")
  mod.ts                          # Programmatic API (export "./mod")
  install.ts                      # Scaffolding CLI (export "./install")
  config.ts                       # Config types, loading, validation, env interpolation
  file-finder.ts                  # Recursive dir scan with glob/exclude + regex match/ignore filtering
  tracker.ts                      # Filesystem marker-file deduplication (+ sweepTmp)
  relay.ts                        # Orchestrator, retry/concurrency/abort, per-run log writer
  adapters/
    adapter.ts                    # RelayAdapter + TransferOptions + CheckResult + factory
    static-upload-server.ts       # HTTP streaming multipart upload adapter
    filesystem.ts                 # Raw copy adapter (with optional sha256 verify)
tests/
  _helpers.ts                     # Test utilities (temp dirs, mock server)
  config.test.ts                  # Config validation tests
  file-finder.test.ts             # File discovery tests (incl. symlink cycle)
  tracker.test.ts                 # Tracker + sweepTmp tests
  relay.test.ts                   # Integration tests (retry, concurrency, abort)
  adapters/
    static-upload-server.test.ts  # HTTP adapter tests (streaming, preflight, non-JSON 2xx)
    filesystem.test.ts            # Copy adapter tests (preflight, sha256)
example/
  file-relay-example.ts           # Working example against real server
  .env                            # Real credentials (gitignored)
  .env.example                    # Credential template
  source/                         # Test source files (gitignored)
  log/                            # Per-run log files (gitignored)
  track/                          # Transfer markers (gitignored)
scripts/
  build-npm.ts                    # npm distribution build
deno.json                         # Config, tasks, imports
```

### Data Flow

```
config.json
  -> loadConfig() [parse, interpolate ${ENV_VARs}, validate]
  -> relay()
       -> _initLogFileWriter() [create timestamped log file in logDir]
       -> tracker.sweepTmp()    [clean stale .tmp markers from previous crash]
       -> findFiles()           [walk (w/ cycle detection), glob+exclude, match+ignore, sort by mtime]
       -> tracker.isTransferred() (per file)
       -> adapter.check?()      [preflight — short-circuit run if not ok]
       -> runPool(concurrency):
            -> re-stat file
            -> adapter.transfer(file, { signal }) [with retries on failure]
            -> tracker.markTransferred() on success
       -> close log file, restore clog hook (reentrancy-safe)
  -> RelayRunResult { status, success, transfers, ... }
```

### Core Components

1. **Config** (`config.ts`): JSON config with `${ENV_VAR}` interpolation. Validates
   source (dir, glob, exclude, match, ignore, followSymlinks), destination
   (adapter union + optional `verify: "size" | "sha256"` for filesystem), and
   optional `transfer` (concurrency, retry.attempts/backoffMs/maxBackoffMs).
   Absolute paths use `isAbsolute()`, not string compare — trailing slashes
   are handled correctly.

2. **File Finder** (`file-finder.ts`): Recursive directory walker using `join()`.
   When `followSymlinks: true`, a `Set<realPath>` prevents infinite recursion
   on cyclic symlinks. Glob include/exclude, then regex whitelist (`match`) /
   blacklist (`ignore`). Guards against any relative path escaping source.dir.

3. **Tracker** (`tracker.ts`): Dedup via `{trackDir}/{relativePath}.transferred.json`
   marker files. Atomic writes (temp + rename). `sweepTmp()` removes stray
   `*.transferred.json.tmp` leftovers from a crashed prior run.

4. **Adapters** (`adapters/`): `RelayAdapter` with `transfer(file, { signal })`
   and optional `check()` preflight returning `CheckResult`.
   - `static-upload-server`: streams multipart body from disk (no in-memory
     buffering); sets `Content-Length`; accepts non-JSON 2xx responses;
     respects external `AbortSignal` in addition to its own timeout.
   - `filesystem`: `Deno.copyFile` with size verification; `verify: "sha256"`
     additionally compares digests (opt-in; buffers for hashing).

5. **Relay** (`relay.ts`): Orchestrator.
   - Per-run log writer hook (synced close, surfaces repeated write errors
     once via stderr).
   - `runPool` schedules transfers at `config.transfer.concurrency` (default 1).
   - `transferWithRetry` re-stats the file before every attempt and retries
     on failure with exponential backoff capped at `maxBackoffMs`.
   - Honours `options.signal` — in-flight transfers are cancelled, no new
     transfers scheduled, and `status: "aborted"` is returned.

6. **CLI** (`cli.ts`): Arg parsing (`--concurrency`, `--retry-attempts`,
   `--dry-run`, `--verbose`), SIGINT/SIGTERM handler that flips an
   `AbortController`, calls `relay()`. Exit codes: 0=ok, 1=any failure,
   2=config/fatal, 130=aborted.

7. **Install** (`install.ts`): Scaffolding CLI. Prompts for source dir and
   adapter type, creates a ready-to-use directory with config.json, deno.json,
   .env.example, log/, track/.

### Adapter Pattern

```typescript
interface RelayAdapter {
	readonly name: string;
	transfer(
		file: FileInfo,
		options?: TransferOptions,
	): Promise<TransferResult>;
	check?(): Promise<CheckResult>;
}
```

To add a new adapter:

1. Create `src/adapters/my-adapter.ts` implementing `RelayAdapter`
2. Honour `options.signal` (abort promptly on external cancellation)
3. Provide `check()` so relay can preflight the destination
4. Stream rather than buffer — assume files can be multi-GB
5. Add case to `createAdapter()` switch in `src/adapters/adapter.ts`
6. Add destination type to `DestinationConfig` union in `src/config.ts`
7. Add validation case in `validateDestination()` in `src/config.ts`
8. Export the new destination type from `src/mod.ts`

## Critical Conventions

1. All paths in config are resolved: absolute ones as-is; relative ones
   against `baseDir` (config file's dir for `loadConfig`, else `Deno.cwd()`).
2. Config string values support `${ENV_VAR}` interpolation (error if var unset).
3. Symlinks are skipped by default (`followSymlinks: false`); cycles are
   detected when enabled.
4. Logging uses `@marianmeres/clog` — never raw `console.log` inside `relay()`.
5. `relay()` is reentrancy-safe: the per-run clog hook does not stomp on a
   concurrent run's hook.
6. Adapters must stream file contents — never load an entire file into memory
   for transfer. The opt-in `sha256` verify is the only exception (documented).
7. Formatting: tabs, 90 char line width, 4-space indent width.
8. Tests use temp directories with `try/finally` cleanup; `createClog.global.debug = false`
   at the top of noisy test files.

## Invariants

- Marker file relative paths cannot escape `trackDir` (file-finder drops any
  `rel` starting with `..` or being absolute).
- `.transferred.json.tmp` files are sweep targets, never read as markers
  (`isTransferred()` requires the non-tmp name + `isFile`).
- `RelayRunResult.success` is a strict alias for "no transfer failed"; use
  `status` for structured decisions in new code.
- A `preflight-failed` run has `transfers: []` — do not assume a per-file
  failure array is non-empty when `success === false`.

## Before Making Changes

- Check existing patterns in similar adapter/module files
- Run `deno test -A` and `deno lint` and `deno fmt --check`
- Follow the adapter interface contract when adding new adapters
- Ensure all exported symbols have JSDoc comments (JSR requirement)
- If changing `RelayRunResult` or `RelayAdapter`, update API.md and the
  "Upgrading" section of README.md, and mention behavioural deltas explicitly
