import { createClog } from "@marianmeres/clog";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import type { FileRelayConfig } from "./config.ts";
import { findFiles } from "./file-finder.ts";
import { createTracker } from "./tracker.ts";
import { createAdapter, type TransferResult } from "./adapters/adapter.ts";

/** A callable clog logger instance with level methods. */
// deno-lint-ignore no-explicit-any
export type ClogFn = ((...args: any[]) => any) & {
	// deno-lint-ignore no-explicit-any
	debug: (...args: any[]) => any;
	// deno-lint-ignore no-explicit-any
	warn: (...args: any[]) => any;
	// deno-lint-ignore no-explicit-any
	error: (...args: any[]) => any;
};

/** Options for the {@linkcode relay} function. */
export interface RelayOptions {
	/** If true, find and report files but don't transfer. */
	dryRun?: boolean;
	/** Logger instance (clog). Defaults to `createClog("file-relay")`. */
	clog?: ClogFn;
}

/** Result of a complete relay run. */
export interface RelayRunResult {
	/** ISO timestamp of run start. */
	startedAt: string;
	/** ISO timestamp of run end. */
	finishedAt: string;
	/** Total run duration in milliseconds. */
	durationMs: number;
	/** Total number of files found matching source criteria. */
	filesFound: number;
	/** Number of files skipped because already transferred. */
	filesAlreadyTransferred: number;
	/** Individual transfer results for each attempted file. */
	transfers: TransferResult[];
	/** `true` if all attempted transfers succeeded. */
	success: boolean;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Run the file relay: scan source directory, filter already-transferred files,
 * transfer new files via the configured adapter, and record successful transfers.
 *
 * @example
 * ```ts
 * import { loadConfig, relay } from "@marianmeres/file-relay/mod";
 *
 * const config = await loadConfig("./relay-config.json");
 * const result = await relay(config);
 * console.log(result.success ? "All done" : "Some transfers failed");
 * ```
 */
export async function relay(
	config: FileRelayConfig,
	options?: RelayOptions,
): Promise<RelayRunResult> {
	const dryRun = options?.dryRun ?? false;
	const log = options?.clog ?? createClog("file-relay");

	// set up log file writer
	const logWriter = await _initLogFileWriter(config.logDir);
	const prevHook = createClog.global.hook;
	if (logWriter) {
		createClog.global.hook = (data) => {
			if (typeof prevHook === "function") prevHook(data);
			logWriter.write(data);
		};
	}

	const finish = (result: RelayRunResult): RelayRunResult => {
		createClog.global.hook = prevHook;
		logWriter?.close();
		return result;
	};

	const startedAt = new Date().toISOString();
	const start = performance.now();

	log(`Starting relay run${dryRun ? " (DRY RUN)" : ""}`);

	// 1. Find files
	log(`Scanning source: ${config.source.dir}`);
	const files = await findFiles(config.source);
	log(`Found ${files.length} file(s) matching criteria`);

	// 2. Check tracker for already-transferred files
	const tracker = createTracker(config.trackDir);
	const toTransfer = [];
	let alreadyTransferred = 0;

	for (const file of files) {
		if (await tracker.isTransferred(file.relativePath)) {
			alreadyTransferred++;
			log.debug(
				`Skipping (already transferred): ${file.relativePath}`,
			);
		} else {
			toTransfer.push(file);
		}
	}

	if (alreadyTransferred > 0) {
		log(`Skipped ${alreadyTransferred} already-transferred file(s)`);
	}

	if (toTransfer.length === 0) {
		log(`No new files to transfer`);
		return finish({
			startedAt,
			finishedAt: new Date().toISOString(),
			durationMs: performance.now() - start,
			filesFound: files.length,
			filesAlreadyTransferred: alreadyTransferred,
			transfers: [],
			success: true,
		});
	}

	log(`${toTransfer.length} file(s) to transfer`);

	if (dryRun) {
		log(`DRY RUN — would transfer:`);
		for (const f of toTransfer) {
			log(`  ${f.relativePath} (${formatBytes(f.size)})`);
		}
		return finish({
			startedAt,
			finishedAt: new Date().toISOString(),
			durationMs: performance.now() - start,
			filesFound: files.length,
			filesAlreadyTransferred: alreadyTransferred,
			transfers: [],
			success: true,
		});
	}

	// 3. Create adapter and transfer
	const adapter = createAdapter(config.destination);
	log(`Using adapter: ${adapter.name}`);

	const transfers: TransferResult[] = [];
	let failures = 0;

	for (const file of toTransfer) {
		log(
			`Transferring: ${file.relativePath}` +
				` (${formatBytes(file.size)})`,
		);

		const result = await adapter.transfer(file);
		transfers.push(result);

		if (result.success) {
			log(
				`  OK -> ${result.destination}` +
					` (${result.durationMs?.toFixed(0)}ms)`,
			);

			// mark as transferred
			await tracker.markTransferred(file.relativePath, {
				transferredAt: new Date().toISOString(),
				sourcePath: file.path,
				sourceSize: file.size,
				destinationInfo: result.destination,
			});
		} else {
			failures++;
			log.error(
				`  FAILED: ${result.error}`,
			);
		}
	}

	const durationMs = performance.now() - start;

	log(
		`Relay run finished in ${(durationMs / 1000).toFixed(1)}s:` +
			` ${transfers.length - failures} succeeded,` +
			` ${failures} failed`,
	);

	return finish({
		startedAt,
		finishedAt: new Date().toISOString(),
		durationMs,
		filesFound: files.length,
		filesAlreadyTransferred: alreadyTransferred,
		transfers,
		success: failures === 0,
	});
}

// -----------------------------------------------------------------------------
// Log file writer
// -----------------------------------------------------------------------------

const _encoder = new TextEncoder();

async function _initLogFileWriter(logDir: string) {
	try {
		await ensureDir(logDir);
	} catch {
		return null;
	}

	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const logFile = join(logDir, `file-relay-${ts}.log`);
	let fh: Deno.FsFile;
	try {
		fh = await Deno.open(logFile, {
			write: true,
			create: true,
			append: true,
		});
	} catch {
		return null;
	}

	return {
		// deno-lint-ignore no-explicit-any
		write(data: Record<string, any>) {
			const level = data.level ?? "INFO";
			const timestamp = data.timestamp ?? new Date().toISOString();
			const ns = data.namespace ? `[${data.namespace}] ` : "";
			const msg = (data.args ?? [])
				.map((a: unknown) => typeof a === "string" ? a : JSON.stringify(a))
				.join(" ");
			const line = `[${timestamp}] [${level}] ${ns}${msg}\n`;
			try {
				fh.writeSync(_encoder.encode(line));
			} catch {
				// log file write failure — don't crash the relay
			}
		},
		close() {
			try {
				fh.close();
			} catch {
				// ignore
			}
		},
	};
}
