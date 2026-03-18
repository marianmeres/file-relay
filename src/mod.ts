/**
 * @module
 *
 * Programmatic API for `@marianmeres/file-relay`. Scans a source directory,
 * transfers unprocessed files to a remote destination (HTTP upload or
 * filesystem copy), and tracks successful transfers to avoid duplicates.
 *
 * @example
 * ```ts
 * import { loadConfig, relay } from "@marianmeres/file-relay/mod";
 *
 * const config = await loadConfig("./relay-config.json");
 * const result = await relay(config, { dryRun: true });
 * console.log(`Found ${result.filesFound} files`);
 * ```
 */

export type {
	DestinationConfig,
	FileRelayConfig,
	FilesystemCopyDestination,
	SourceConfig,
	StaticUploadServerDestination,
} from "./config.ts";
export { loadConfig, validateConfig } from "./config.ts";

export type { FileInfo } from "./file-finder.ts";
export { findFiles } from "./file-finder.ts";

export type { Tracker, TransferMeta } from "./tracker.ts";
export { createTracker } from "./tracker.ts";

export type { RelayAdapter, TransferResult } from "./adapters/adapter.ts";
export { createAdapter } from "./adapters/adapter.ts";

export type { ClogFn, RelayOptions, RelayRunResult } from "./relay.ts";
export { relay } from "./relay.ts";
