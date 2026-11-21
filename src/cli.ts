/**
 * @module
 *
 * The `file-relay` CLI. From npm it is the `file-relay` bin (`bin.ts`); from JSR,
 * this module run directly:
 *
 * ```bash
 * npx @marianmeres/file-relay config.json --dry-run
 * deno run -A jsr:@marianmeres/file-relay config.json --dry-run
 * ```
 *
 * All logic lives in {@linkcode runCli}, which takes the argument list and resolves
 * to the process exit code (it never exits the process itself).
 */

import { hostname } from "node:os";
import process from "node:process";
import { createClog } from "@marianmeres/clog";
import { loadConfig } from "./config.ts";
import { relay, type RelayRunResult } from "./relay.ts";
import { type NotifyContext, sendNotification, shouldNotify } from "./notify.ts";
import { VERSION } from "./version.ts";

/** Best-effort machine identifier for notification subject/body. */
function getHost(): string {
	try {
		return hostname();
	} catch {
		return process.env.HOSTNAME ?? "unknown-host";
	}
}

/** Render a captured clog record into a compact email-body line. */
// biome-ignore lint/suspicious/noExplicitAny: a clog hook record
function formatCapturedLine(data: Record<string, any>): string {
	const level = data.level ?? "INFO";
	const msg = (data.args ?? [])
		.map((a: unknown) => (typeof a === "string" ? a : JSON.stringify(a)))
		.join(" ");
	return level === "INFO" ? msg : `[${level}] ${msg}`;
}

function printHelp() {
	console.log(`
file-relay v${VERSION}

Transfer local files to a remote destination based on config.

Usage:
  file-relay <config.json> [options]

  Without installing: npx @marianmeres/file-relay <config.json> [options]
  On Deno (JSR):      deno run -A jsr:@marianmeres/file-relay <config.json> [options]

Arguments:
  config.json              Path to the JSON config file (required)

Options:
  --dry-run                Find and report files without transferring
  --verbose                Enable debug-level log output
  --concurrency=N          Override config.transfer.concurrency
  --retry-attempts=N       Override config.transfer.retry.attempts
  --no-notify              Suppress the email notification for this run
  --help                   Show this help message
  --version                Show version

Signals:
  SIGINT / SIGTERM         Abort gracefully — finish in-flight transfer(s)
                           and exit with a non-zero code.
`.trim());
}

/** Parsed command line, or the exit code to stop with right away. */
type ParsedArgs =
	| { exit: number }
	| {
		exit?: undefined;
		configPath: string;
		dryRun: boolean;
		verbose: boolean;
		noNotify: boolean;
		concurrency: number | undefined;
		retryAttempts: number | undefined;
	};

function parseArgs(args: string[]): ParsedArgs {
	let configPath: string | null = null;
	let dryRun = false;
	let verbose = false;
	let noNotify = false;
	let concurrency: number | undefined;
	let retryAttempts: number | undefined;

	for (const arg of args) {
		if (arg === "--help" || arg === "-h") {
			printHelp();
			return { exit: 0 };
		}
		if (arg === "--version" || arg === "-v") {
			console.log(VERSION);
			return { exit: 0 };
		}
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--verbose") {
			verbose = true;
			continue;
		}
		if (arg === "--no-notify") {
			noNotify = true;
			continue;
		}
		if (arg.startsWith("--concurrency=")) {
			const v = Number(arg.slice("--concurrency=".length));
			if (!Number.isInteger(v) || v < 1) {
				console.error(`--concurrency must be a positive integer`);
				return { exit: 2 };
			}
			concurrency = v;
			continue;
		}
		if (arg.startsWith("--retry-attempts=")) {
			const v = Number(arg.slice("--retry-attempts=".length));
			if (!Number.isInteger(v) || v < 1) {
				console.error(`--retry-attempts must be a positive integer`);
				return { exit: 2 };
			}
			retryAttempts = v;
			continue;
		}
		if (arg.startsWith("-")) {
			console.error(`Unknown option: ${arg}`);
			return { exit: 2 };
		}
		if (!configPath) {
			configPath = arg;
		} else {
			console.error(`Unexpected argument: ${arg}`);
			return { exit: 2 };
		}
	}

	if (!configPath) {
		console.error("Error: config file path is required\n");
		printHelp();
		return { exit: 2 };
	}

	return { configPath, dryRun, verbose, noNotify, concurrency, retryAttempts };
}

/**
 * Runs the `file-relay` CLI.
 *
 * Exit codes: `0` success (or nothing to do), `1` a transfer or the preflight
 * failed, `2` usage, config or fatal error, `130` aborted by SIGINT/SIGTERM.
 *
 * @param args - The command-line arguments, without the runtime and script
 *   (`process.argv.slice(2)`).
 * @returns The process exit code.
 */
export async function runCli(args: string[]): Promise<number> {
	const parsed = parseArgs(args);
	if (parsed.exit !== undefined) return parsed.exit;
	const { configPath, dryRun, verbose, noNotify, concurrency, retryAttempts } = parsed;

	// Load config
	let config;
	try {
		config = await loadConfig(configPath);
	} catch (err) {
		console.error(
			`Config error: ${err instanceof Error ? err.message : err}`,
		);
		return 2;
	}

	if (concurrency !== undefined || retryAttempts !== undefined) {
		config = {
			...config,
			transfer: {
				...(config.transfer ?? {}),
				...(concurrency !== undefined ? { concurrency } : {}),
				...(retryAttempts !== undefined
					? {
						retry: {
							...(config.transfer?.retry ?? {}),
							attempts: retryAttempts,
						},
					}
					: {}),
			},
		};
	}

	if (!verbose) {
		createClog.global.debug = false;
	}

	const clog = createClog("file-relay");

	// Email notification is opt-in (config.notify) and never runs for a dry run
	// or when explicitly suppressed. When active, capture the run's log output
	// via a chained global hook so we can mail it. relay() chains whatever hook
	// it finds, so our capture survives relay()'s own per-run log writer.
	const notifyEnabled = Boolean(config.notify) && !dryRun && !noNotify;
	const captured: string[] = [];
	const prevHook = createClog.global.hook;
	if (notifyEnabled) {
		createClog.global.hook = (data) => {
			captured.push(formatCapturedLine(data));
			return typeof prevHook === "function" ? prevHook(data) : undefined;
		};
	}

	// Graceful abort on SIGINT/SIGTERM — avoids half-logged state when the
	// user interrupts a long cron run.
	const controller = new AbortController();
	const onSignal = () => {
		clog.warn("Received signal — aborting relay run...");
		controller.abort();
	};
	try {
		process.on("SIGINT", onSignal);
		process.on("SIGTERM", onSignal);
	} catch {
		// signals may not be available on all platforms — non-fatal
	}

	let result: RelayRunResult | null = null;
	let fatalError: Error | null = null;
	let exitCode = 0;
	try {
		result = await relay(config, {
			dryRun,
			clog,
			signal: controller.signal,
		});
		exitCode = result.status === "aborted" ? 130 : result.success ? 0 : 1;
	} catch (err) {
		fatalError = err instanceof Error ? err : new Error(String(err));
		clog.error(`Fatal error: ${fatalError.message}`);
		exitCode = 2;
	} finally {
		try {
			process.off("SIGINT", onSignal);
			process.off("SIGTERM", onSignal);
		} catch {
			// ignore
		}
	}

	// Send the notification (if enabled) before exiting. A mail failure is
	// surfaced as a warning but must not change the relay's own exit code.
	if (notifyEnabled && config.notify) {
		createClog.global.hook = prevHook; // stop capturing our own mail logs
		const ctx: NotifyContext = {
			result,
			error: fatalError,
			logText: captured.join("\n"),
			host: getHost(),
		};
		// Gate on the trigger *before* sendNotification so the SMTP/nodemailer
		// dependency (dynamically imported inside it) is pulled only when an email
		// is genuinely sent — an `on: "failure"` heartbeat that succeeds pays nothing.
		if (shouldNotify(config.notify.on, ctx)) {
			const outcome = await sendNotification(config.notify, ctx);
			if (outcome.error) {
				clog.warn(`Notification email failed: ${outcome.error}`);
			} else if (outcome.sent) {
				clog.log("Notification email sent");
			}
		} else {
			clog.log(`Notification skipped (trigger "${config.notify.on}" not met)`);
		}
	}

	return exitCode;
}

// Run as a CLI when this module is the program entrypoint — the JSR `.` export,
// as `deno run -A jsr:@marianmeres/file-relay` executes it. Imported (the npm bin
// does that), it only defines runCli.
if (import.meta.main) {
	process.exitCode = await runCli(process.argv.slice(2));
}
