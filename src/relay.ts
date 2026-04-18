import { type Clog, createClog } from "@marianmeres/clog";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import type { FileRelayConfig, RetryConfig } from "./config.ts";
import { type FileInfo, findFiles } from "./file-finder.ts";
import { createTracker } from "./tracker.ts";
import {
	createAdapter,
	type RelayAdapter,
	type TransferResult,
} from "./adapters/adapter.ts";

/**
 * A clog-like callable logger. Accepts the full {@linkcode Clog} instance
 * from `@marianmeres/clog` as well as any compatible shape (the library only
 * uses the call signature + `.debug` / `.warn` / `.error`).
 *
 * Kept as a loose type alias for backwards compatibility with 1.x callers.
 */
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
	clog?: ClogFn | Clog;
	/**
	 * Abort signal. When triggered, any in-flight transfer is cancelled and
	 * no new transfers are started. Files currently being transferred will
	 * report `success: false`. Already-completed transfers stay committed.
	 */
	signal?: AbortSignal;
}

/** Aggregated status of a relay run. */
export type RelayStatus =
	/** No files needed transferring. */
	| "idle"
	/** Every attempted transfer succeeded. */
	| "ok"
	/** Some transfers succeeded, some failed. */
	| "partial"
	/** Every attempted transfer failed. */
	| "failed"
	/** The run was aborted before finishing. */
	| "aborted"
	/** Adapter preflight check failed — no transfer was attempted. */
	| "preflight-failed";

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
	/** Structured run status. See {@linkcode RelayStatus}. */
	status: RelayStatus;
	/**
	 * `true` if no transfer failed. Kept for 1.x compatibility — prefer
	 * `status` for new code. A `"preflight-failed"` run reports `success: false`.
	 */
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((res, rej) => {
		if (signal?.aborted) {
			rej(signal.reason ?? new Error("Aborted"));
			return;
		}
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			res();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			rej(signal?.reason ?? new Error("Aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Transfer a single file via the adapter, retrying on failure as per
 * `retryCfg`. Re-stats the file right before each attempt so callers
 * observe the actual bytes/mtime we shipped.
 */
async function transferWithRetry(
	adapter: RelayAdapter,
	file: FileInfo,
	retryCfg: RetryConfig,
	signal: AbortSignal | undefined,
	log: ClogFn | Clog,
): Promise<TransferResult> {
	const attempts = retryCfg.attempts ?? 1;
	const baseBackoff = retryCfg.backoffMs ?? 1000;
	const maxBackoff = retryCfg.maxBackoffMs ?? 30_000;

	let last: TransferResult | null = null;
	for (let i = 1; i <= attempts; i++) {
		if (signal?.aborted) {
			return {
				success: false,
				sourceFile: file,
				destination: "(aborted)",
				error: "aborted",
				attempts: i - 1,
			};
		}

		// re-stat to pick up replacements / deletions between discovery and transfer
		let current: FileInfo = file;
		try {
			const stat = await Deno.stat(file.path);
			current = {
				...file,
				size: stat.size,
				mtime: stat.mtime ?? file.mtime,
			};
		} catch (err) {
			return {
				success: false,
				sourceFile: file,
				destination: file.path,
				error: err instanceof Error ? err.message : String(err),
				attempts: i,
			};
		}

		const res = await adapter.transfer(current, { signal });
		last = { ...res, attempts: i };
		if (res.success) return last;

		if (signal?.aborted) return last;
		if (i < attempts) {
			const delay = Math.min(
				maxBackoff,
				baseBackoff * Math.pow(2, i - 1),
			);
			log.warn(
				`  attempt ${i}/${attempts} failed: ${res.error} — ` +
					`retrying in ${delay}ms`,
			);
			try {
				await sleep(delay, signal);
			} catch {
				return last;
			}
		}
	}
	return last!;
}

/**
 * Run up to `concurrency` tasks in parallel, preserving input order in the
 * returned result array. Stops scheduling new tasks once `signal` is aborted.
 */
async function runPool<T, R>(
	items: T[],
	concurrency: number,
	signal: AbortSignal | undefined,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const n = items.length;
	const results: R[] = new Array(n);
	let next = 0;
	const pool: Promise<void>[] = [];
	const lanes = Math.min(concurrency, n);

	for (let lane = 0; lane < lanes; lane++) {
		pool.push((async () => {
			while (true) {
				if (signal?.aborted) return;
				const i = next++;
				if (i >= n) return;
				results[i] = await worker(items[i], i);
			}
		})());
	}
	await Promise.all(pool);
	return results;
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
 * console.log(result.status); // "ok" | "partial" | "idle" | ...
 * ```
 */
export async function relay(
	config: FileRelayConfig,
	options?: RelayOptions,
): Promise<RelayRunResult> {
	const dryRun = options?.dryRun ?? false;
	const signal = options?.signal;
	const defaultLog = createClog("file-relay") as unknown as ClogFn;
	const log: ClogFn | Clog = options?.clog ?? defaultLog;

	// Per-run log file writer. Attached as a local hook; never touches the
	// global clog hook — so concurrent relay() calls don't interfere.
	const logWriter = await _initLogFileWriter(config.logDir);
	const prevHook = createClog.global.hook;
	if (logWriter) {
		createClog.global.hook = (data) => {
			const prev = typeof prevHook === "function" ? prevHook(data) : undefined;
			logWriter.write(data);
			return prev;
		};
	}

	const concurrency = config.transfer?.concurrency ?? 1;
	const retry: RetryConfig = config.transfer?.retry ?? {};

	const startedAt = new Date().toISOString();
	const start = performance.now();

	const finish = (result: RelayRunResult): RelayRunResult => {
		// Only restore if we're still the active hook (don't stomp on another
		// relay() that started while we were running).
		if (
			logWriter &&
			// deno-lint-ignore no-explicit-any
			(createClog.global as any).hook &&
			// deno-lint-ignore no-explicit-any
			(createClog.global as any).hook.__fileRelayWriter === logWriter
		) {
			createClog.global.hook = prevHook;
		} else if (logWriter) {
			// Another relay() has replaced the hook mid-flight. Best we can
			// do is leave it alone — our writer will stop receiving writes
			// once the outer relay() finishes.
		}
		logWriter?.close();
		return result;
	};

	// tag the hook so finish() can detect whether it's still ours
	if (logWriter) {
		// deno-lint-ignore no-explicit-any
		(createClog.global.hook as any).__fileRelayWriter = logWriter;
	}

	log(`Starting relay run${dryRun ? " (DRY RUN)" : ""}`);

	// 0. Sweep stale .tmp marker files from a previous crash
	const tracker = createTracker(config.trackDir);
	try {
		const swept = await tracker.sweepTmp();
		if (swept > 0) {
			log.warn(`Swept ${swept} stale .tmp marker file(s) from trackDir`);
		}
	} catch {
		// non-fatal
	}

	// 1. Find files
	log(`Scanning source: ${config.source.dir}`);
	const files = await findFiles(config.source);
	log(`Found ${files.length} file(s) matching criteria`);

	// 2. Check tracker for already-transferred files
	const toTransfer: FileInfo[] = [];
	let alreadyTransferred = 0;

	for (const file of files) {
		if (await tracker.isTransferred(file.relativePath)) {
			alreadyTransferred++;
			log.debug(`Skipping (already transferred): ${file.relativePath}`);
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
			status: "idle",
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
			status: "idle",
			success: true,
		});
	}

	// 3. Create adapter and run preflight
	const adapter = createAdapter(config.destination);
	log(`Using adapter: ${adapter.name}`);

	if (adapter.check) {
		const check = await adapter.check();
		if (!check.ok) {
			log.error(`Preflight check failed: ${check.error}`);
			return finish({
				startedAt,
				finishedAt: new Date().toISOString(),
				durationMs: performance.now() - start,
				filesFound: files.length,
				filesAlreadyTransferred: alreadyTransferred,
				transfers: [],
				status: "preflight-failed",
				success: false,
			});
		}
	}

	// 4. Transfer (optionally with concurrency)
	if (concurrency > 1) {
		log(`Concurrency: ${concurrency}`);
	}

	const transfers = await runPool(
		toTransfer,
		concurrency,
		signal,
		async (file) => {
			log(
				`Transferring: ${file.relativePath}` +
					` (${formatBytes(file.size)})`,
			);
			const result = await transferWithRetry(
				adapter,
				file,
				retry,
				signal,
				log,
			);
			if (result.success) {
				log(
					`  OK -> ${result.destination}` +
						` (${result.durationMs?.toFixed(0)}ms)`,
				);
				await tracker.markTransferred(file.relativePath, {
					transferredAt: new Date().toISOString(),
					sourcePath: file.path,
					sourceSize: result.bytesTransferred ?? file.size,
					destinationInfo: result.destination,
				});
			} else {
				log.error(`  FAILED: ${result.error}`);
			}
			return result;
		},
	);

	// If the run was aborted, `runPool` may have left trailing slots unfilled.
	// Drop those to avoid surfacing `undefined` to callers.
	const completed = transfers.filter((t): t is TransferResult => Boolean(t));

	const durationMs = performance.now() - start;
	const failures = completed.filter((t) => !t.success).length;
	const successes = completed.length - failures;

	let status: RelayStatus;
	if (signal?.aborted) {
		status = "aborted";
	} else if (failures === 0) {
		status = "ok";
	} else if (successes === 0) {
		status = "failed";
	} else {
		status = "partial";
	}

	log(
		`Relay run finished in ${(durationMs / 1000).toFixed(1)}s:` +
			` ${successes} succeeded, ${failures} failed` +
			(status === "aborted" ? " (aborted)" : ""),
	);

	return finish({
		startedAt,
		finishedAt: new Date().toISOString(),
		durationMs,
		filesFound: files.length,
		filesAlreadyTransferred: alreadyTransferred,
		transfers: completed,
		status,
		success: failures === 0 && status !== "aborted",
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
		fh = Deno.openSync(logFile, {
			write: true,
			create: true,
			append: true,
		});
	} catch {
		return null;
	}

	let writeFailures = 0;
	let warnedOnce = false;

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
				writeFailures = 0;
			} catch (err) {
				writeFailures++;
				// Surface repeated failures once via stderr so a broken log
				// path doesn't silently swallow every line.
				if (!warnedOnce && writeFailures >= 3) {
					warnedOnce = true;
					const reason = err instanceof Error ? err.message : String(err);
					try {
						Deno.stderr.writeSync(_encoder.encode(
							`[file-relay] log file writes failing (${reason}) — ` +
								`further errors suppressed\n`,
						));
					} catch {
						// ignore
					}
				}
			}
		},
		close() {
			try {
				fh.syncSync();
			} catch {
				// ignore
			}
			try {
				fh.close();
			} catch {
				// ignore
			}
		},
	};
}
