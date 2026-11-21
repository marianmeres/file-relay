# @marianmeres/file-relay -- Agent Guide

## Quick Reference

```yaml
name: "@marianmeres/file-relay"
license: "MIT"
repository: "https://github.com/marianmeres/file-relay"
registry_npm: "https://www.npmjs.com/package/@marianmeres/file-relay"
registry_jsr: "https://jsr.io/@marianmeres/file-relay"
```

- **Stack**: TypeScript on Node (>= 24.12, type stripping), pnpm, Biome; published
  to npm (built `dist/`) and JSR (the `.ts` source, for Deno users)
- **Run**: `file-relay <config.json>` (npm bin) /
  `deno run -A jsr:@marianmeres/file-relay <config.json>` (JSR)
- **Install** (scaffolder; writes a Node instance): `file-relay-install <dirname>` (npm bin) /
  `deno run -A jsr:@marianmeres/file-relay/install <dirname>` (JSR)
- **Test**: `pnpm test` (node:test); `pnpm run test:deno` (same suite on Deno)
- **Type check**: `pnpm run typecheck` (`tsc --noEmit`, the type gate: Node never checks)
- **Lint / format**: `pnpm run lint` / `pnpm run format` (Biome)
- **All gates**: `pnpm run ci` (typecheck + lint + test + npm tarball smoke)

## Purpose

CLI tool and library that scans a local source directory, transfers unprocessed
files to a remote destination, and tracks successful transfers to prevent
duplicates. Designed for cron-based offsite backup relay (e.g. database dumps).

## Architecture

### File Structure

```
src/
  cli.ts                          # CLI: runCli(args) -> exit code; JSR "." (runs when main)
  bin.ts                          # npm `file-relay` bin: runs runCli unconditionally
  version.ts                      # VERSION constant, synced from package.json on release
  mod.ts                          # Programmatic API (JSR "./mod"; npm "." and "./mod")
  install.ts                      # Scaffolder: runInstall(args); JSR "./install" (runs when main)
  bin-install.ts                  # npm `file-relay-install` bin: runs runInstall unconditionally
  config.ts                       # Config types, loading, validation, env interpolation
  file-finder.ts                  # Recursive dir scan with glob/exclude + regex match/ignore filtering
  _glob-to-regexp.ts              # globToRegExp vendored from @std/path 1.1.5 (no @std dependency)
  tracker.ts                      # Filesystem marker-file deduplication (+ sweepTmp)
  relay.ts                        # Orchestrator, retry/concurrency/abort, per-run log writer
  notify.ts                       # CLI-only email notification (send-email/SMTP). NOT exported from mod
  adapters/
    adapter.ts                    # RelayAdapter + TransferOptions + CheckResult + factory
    static-upload-server.ts       # HTTP streaming multipart upload adapter
    filesystem.ts                 # Raw copy adapter (with optional sha256 verify)
tests/
  _helpers.ts                     # Test utilities (temp dirs, mock upload server, serve())
  cli.e2e.test.ts                 # Spawns the CLI (CLI_RUNTIME=deno: the JSR entry on Deno)
  install.e2e.test.ts             # Spawns the scaffolder with piped answers (same switch)
  version.test.ts                 # src/version.ts == package.json version
  config.test.ts                  # Config validation tests (incl. notify block)
  file-finder.test.ts             # File discovery tests (incl. symlink cycle)
  tracker.test.ts                 # Tracker + sweepTmp tests
  relay.test.ts                   # Integration tests (retry, concurrency, abort)
  notify.test.ts                  # Notification logic (shouldNotify, buildNotificationMessage)
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
  smoke-npm.ts                    # Packs + npm-installs the tarball, runs bins and library
  sync-version.ts                 # release --before-commit: package.json -> src/version.ts
example2/                         # A scaffolded (Node) instance, as install writes it
package.json                      # Manifest of record (npm): scripts, deps, bin, exports
jsr.json                          # JSR manifest: exports, jsr: import map, publish file set
tsconfig.json                     # Type gate (src, tests, scripts, example)
tsconfig.build.json               # npm build: src -> dist
biome.json                        # Format + lint
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
            -> _writeErrorDump() on failure [full diagnostics -> own file in logDir]
       -> close log file, restore clog hook (reentrancy-safe)
  -> RelayRunResult { status, success, transfers, ... }
  -> [CLI only] if config.notify && !dryRun && !--no-notify:
       sendNotification() emails the captured run output via SMTP
       (failure is logged, never alters the relay exit code)
```

### Core Components

1. **Config** (`config.ts`): JSON config with `${ENV_VAR}` interpolation. Validates
   source (dir, glob, exclude, match, ignore, followSymlinks), destination
   (adapter union + optional `verify: "size" | "sha256"` for filesystem),
   optional `transfer` (concurrency, retry.attempts/backoffMs/maxBackoffMs), and
   optional `notify` (email recipients/from/on/smtp; SMTP auth is all-or-nothing).
   `notify` is validated here but acted upon only by the CLI runner.
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
   - `static-upload-server`: two wire formats, selected by `destination.mode`.
     `"put"` (**default**) sends the file as the raw body of
     `PUT {url}/{relativePath}` — the server streams it to disk, so neither side
     buffers. Requires upload-server >= 1.7.0; a 404 is turned into an explicit
     "server too old" error. `"multipart"` is the legacy POST form for older
     servers and costs the server ~3x the file size in RSS. Both stream from disk.
     Accepts non-JSON 2xx responses; respects external `AbortSignal` in addition
     to its own timeout (a timeout is reported as such, not as a bare abort).
     NOTE: `fetch` sends a streamed body without `Content-Length` (always
     chunked, on Node and Deno alike), so never rely on the server seeing one.
     `"put"` responses carry the stored byte count instead, and the adapter
     fails the transfer on a mismatch — that is the only truncation guard there
     is.
   - `filesystem`: `copyFile` (node:fs) with size verification; `verify: "sha256"`
     additionally compares digests (opt-in; buffers for hashing).
   - On failure both populate `TransferResult.errorDetail` — the verbose dump
     (request, response status/headers, full body, or stack + `cause` chain).
     `error` stays short and single-line for the log/email; `errorDetail` holds
     everything. Never put credentials in either.

5. **Relay** (`relay.ts`): Orchestrator.
   - Per-run log writer hook (synced close, surfaces repeated write errors
     once via stderr).
   - `runPool` schedules transfers at `config.transfer.concurrency` (default 1).
   - `transferWithRetry` re-stats the file before every attempt and retries
     on failure with exponential backoff capped at `maxBackoffMs`.
   - `_writeErrorDump` writes each failure's `errorDetail` to its own
     `file-relay-{runTs}-failure-{n}-{slug}.log` in `logDir` and logs the path.
     Never throws — a failed dump must not escalate a transfer failure.
   - Honours `options.signal` — in-flight transfers are cancelled, no new
     transfers scheduled, and `status: "aborted"` is returned.

6. **CLI** (`cli.ts`): `runCli(args)` resolves to the exit code and never exits
   the process; `bin.ts` (npm) and the `import.meta.main` guard (JSR) set
   `process.exitCode` from it. Arg parsing (`--concurrency`, `--retry-attempts`,
   `--dry-run`, `--verbose`, `--no-notify`), SIGINT/SIGTERM handler that flips an
   `AbortController`, calls `relay()`. Exit codes: 0=ok, 1=any failure,
   2=config/fatal, 130=aborted. When `config.notify` is set (and not a dry run /
   `--no-notify`), captures the run's clog output via a chained global hook and,
   after the run, hands it to `notify.ts` — dynamically imported so the SMTP
   dependency loads only when a mail is actually sent.

7. **Install** (`install.ts`): Scaffolding CLI (`runInstall(args)`; reads one
   stdin line per prompt through a queued node:readline reader, so piped answers
   work). Prompts for source dir, adapter type, and optional email
   notifications, creating a ready-to-use directory with config.json,
   .env.example, log/, track/ and a package.json depending on
   `@marianmeres/file-relay@^VERSION` whose `npm run backup` is
   `node --env-file-if-exists=.env node_modules/@marianmeres/file-relay/dist/bin.js config.json`
   (the bin's JS file: `.bin/` holds a shell shim under pnpm). The instance runs
   on Node whichever runtime ran the scaffolder.

8. **Notify** (`notify.ts`): CLI-only. `shouldNotify()` (trigger gate),
   `buildNotificationMessage()` (pure subject/body builder — unit-tested), and
   `sendNotification()` (calls `@marianmeres/send-email`'s `send()`; never
   throws — a send failure is returned, not propagated, so it can't change the
   relay exit code). Not re-exported from `mod.ts`, keeping nodemailer out of
   the programmatic API's dependency graph.

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
5. On failure, set both `error` (short, single-line) and `errorDetail` (verbose)
6. Add case to `createAdapter()` switch in `src/adapters/adapter.ts`
7. Add destination type to `DestinationConfig` union in `src/config.ts`
8. Add validation case in `validateDestination()` in `src/config.ts`
9. Export the new destination type from `src/mod.ts`

## Critical Conventions

1. All paths in config are resolved: absolute ones as-is; relative ones
   against `baseDir` (config file's dir for `loadConfig`, else `process.cwd()`).
2. Config string values support `${ENV_VAR}` interpolation (error if var unset).
3. Symlinks are skipped by default (`followSymlinks: false`); cycles are
   detected when enabled.
4. Logging uses `@marianmeres/clog` — never raw `console.log` inside `relay()`.
5. `relay()` is reentrancy-safe: the per-run clog hook does not stomp on a
   concurrent run's hook.
6. Adapters must stream file contents — never load an entire file into memory
   for transfer. The opt-in `sha256` verify is the only exception (documented).
7. Formatting: Biome — tabs, 90 char line width, 4-space indent width.
8. Tests use temp directories with `try/finally` cleanup; `createClog.global.debug = false`
   at the top of noisy test files.
9. Email notification is a CLI-layer concern only. `relay()` and `mod.ts` stay
   free of `@marianmeres/send-email`/nodemailer — only `cli.ts` imports
   `notify.ts`, which imports send-email dynamically, at send time. Keep it that
   way: the programmatic API must not load an SMTP dependency. (On npm send-email
   is a regular dependency, since the bin needs it; installed is not loaded.) A
   notification send must never throw into the run.
10. Runtime contract: source uses web standards plus `node:*` only — no `Deno.*`
    or `Bun.*`, no `jsr:` / `npm:` / `https:` specifiers, erasable-only TS
    (`import type`, no `enum` / `namespace` / parameter properties), explicit
    `.ts` import extensions. It runs unchanged on Node (npm) and Deno (JSR).
    jsr.json's `imports` map keeps the JSR build on the JSR copies of the
    `@marianmeres/*` dependencies; keep its ranges in step with package.json.
11. Node `fs` traps: `Stats` / `Dirent` have `isFile()` / `isDirectory()`
    **methods** (Deno had properties); read text through `TextDecoder` where a
    BOM must be dropped (`loadConfig`); never write to a raw fd after closing it.
12. The version lives in package.json; `pnpm run release` copies it into
    `src/version.ts` (`tests/version.test.ts` fails when they disagree). Never
    hand-edit either.
13. Test servers listen on port 0 (OS-assigned); nothing here binds a fixed port.

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
- Run `pnpm run ci` (typecheck, Biome, Node tests, npm smoke) and
  `pnpm run test:deno` (the suite on Deno, as JSR serves it)
- Follow the adapter interface contract when adding new adapters
- Ensure all exported symbols have JSDoc comments (JSR requirement);
  `pnpm run jsr:check` is the JSR dry run (type check + slow types + file set)
- If changing `RelayRunResult` or `RelayAdapter`, update API.md and the
  "Upgrading" section of README.md, and mention behavioural deltas explicitly
