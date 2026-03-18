# @marianmeres/file-relay -- Agent Guide

## Quick Reference

```yaml
name: "@marianmeres/file-relay"
version: "1.0.1"
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
  file-finder.ts                  # Recursive dir scan with glob/exclude filtering
  tracker.ts                      # Filesystem marker-file deduplication
  relay.ts                        # Main orchestrator + log file writer
  adapters/
    adapter.ts                    # RelayAdapter interface + factory
    static-upload-server.ts       # HTTP multipart upload adapter
    filesystem.ts                 # Raw copy adapter
tests/
  _helpers.ts                     # Test utilities (temp dirs, mock server)
  config.test.ts                  # Config validation tests
  file-finder.test.ts             # File discovery tests
  tracker.test.ts                 # Tracker tests
  relay.test.ts                   # Integration tests
  adapters/
    static-upload-server.test.ts  # HTTP adapter tests
    filesystem.test.ts            # Copy adapter tests
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
       -> findFiles() [recursive walk, glob match, exclude filter, sort by mtime]
       -> tracker.isTransferred() [check marker file existence]
       -> adapter.transfer() [HTTP POST or filesystem copy]
       -> tracker.markTransferred() [write marker JSON]
       -> close log file, restore clog hook
  -> RelayRunResult [summary with timing, counts, per-file results]
```

### Core Components

1. **Config** (`config.ts`): JSON config with `${ENV_VAR}` interpolation. Validates
   source (dir, glob, exclude, followSymlinks) and destination (adapter discriminated union).

2. **File Finder** (`file-finder.ts`): Recursive directory walker. Glob include/exclude
   via `@std/path/glob-to-regexp`. Symlink-aware. Returns `FileInfo[]` sorted by mtime desc.

3. **Tracker** (`tracker.ts`): Dedup via `{trackDir}/{relativePath}.transferred.json`
   marker files. Atomic writes (temp + rename). Check = stat existence.

4. **Adapters** (`adapters/`): `RelayAdapter` interface with `transfer(FileInfo): TransferResult`.
   - `static-upload-server`: HTTP POST multipart/form-data with Bearer auth
   - `filesystem`: `Deno.copyFile` with size verification

5. **Relay** (`relay.ts`): Orchestrator. find -> filter tracked -> transfer -> mark.
   Supports dry-run. Logs via `@marianmeres/clog`. Automatically creates a timestamped
   log file in `logDir` via clog global hook (works from both CLI and programmatic API).

6. **CLI** (`cli.ts`): Thin wrapper — arg parsing, clog debug toggle, calls `relay()`.
   Exit codes: 0=success, 1=transfer failure, 2=config/fatal error.

7. **Install** (`install.ts`): Scaffolding CLI. Prompts for source dir and adapter type,
   creates a ready-to-use directory with config.json, deno.json, .env.example, log/, track/.

### Adapter Pattern

```typescript
interface RelayAdapter {
	readonly name: string;
	transfer(file: FileInfo): Promise<TransferResult>;
}
```

To add a new adapter:

1. Create `src/adapters/my-adapter.ts` implementing `RelayAdapter`
2. Add case to `createAdapter()` switch in `src/adapters/adapter.ts`
3. Add destination type to `DestinationConfig` union in `src/config.ts`
4. Add validation case in `validateDestination()` in `src/config.ts`

## Critical Conventions

1. All paths in config must be absolute
2. Config string values support `${ENV_VAR}` interpolation (error if var unset)
3. Symlinks are skipped by default (`followSymlinks: false`)
4. Logging uses `@marianmeres/clog` -- never raw `console.log`
5. Formatting: tabs, 90 char line width, 4-space indent width
6. Tests use temp directories with `try/finally` cleanup

## Before Making Changes

- Check existing patterns in similar adapter/module files
- Run `deno test -A` and `deno lint` and `deno fmt --check`
- Follow the adapter interface contract when adding new adapters
- Ensure all exported symbols have JSDoc comments (JSR requirement)
