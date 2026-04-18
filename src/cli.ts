import { createClog } from "@marianmeres/clog";
import { loadConfig } from "./config.ts";
import { relay } from "./relay.ts";

import denoJson from "../deno.json" with { type: "json" };

const VERSION = denoJson.version;

function printHelp() {
	console.log(`
file-relay v${VERSION}

Transfer local files to a remote destination based on config.

Usage:
  deno run -A jsr:@marianmeres/file-relay <config.json> [options]

Arguments:
  config.json              Path to the JSON config file (required)

Options:
  --dry-run                Find and report files without transferring
  --verbose                Enable debug-level log output
  --concurrency=N          Override config.transfer.concurrency
  --retry-attempts=N       Override config.transfer.retry.attempts
  --help                   Show this help message
  --version                Show version

Signals:
  SIGINT / SIGTERM         Abort gracefully — finish in-flight transfer(s)
                           and exit with a non-zero code.
`.trim());
}

function parseArgs(args: string[]) {
	let configPath: string | null = null;
	let dryRun = false;
	let verbose = false;
	let concurrency: number | undefined;
	let retryAttempts: number | undefined;

	for (const arg of args) {
		if (arg === "--help" || arg === "-h") {
			printHelp();
			Deno.exit(0);
		}
		if (arg === "--version" || arg === "-v") {
			console.log(VERSION);
			Deno.exit(0);
		}
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--verbose") {
			verbose = true;
			continue;
		}
		if (arg.startsWith("--concurrency=")) {
			const v = Number(arg.slice("--concurrency=".length));
			if (!Number.isInteger(v) || v < 1) {
				console.error(`--concurrency must be a positive integer`);
				Deno.exit(2);
			}
			concurrency = v;
			continue;
		}
		if (arg.startsWith("--retry-attempts=")) {
			const v = Number(arg.slice("--retry-attempts=".length));
			if (!Number.isInteger(v) || v < 1) {
				console.error(`--retry-attempts must be a positive integer`);
				Deno.exit(2);
			}
			retryAttempts = v;
			continue;
		}
		if (arg.startsWith("-")) {
			console.error(`Unknown option: ${arg}`);
			Deno.exit(2);
		}
		if (!configPath) {
			configPath = arg;
		} else {
			console.error(`Unexpected argument: ${arg}`);
			Deno.exit(2);
		}
	}

	if (!configPath) {
		console.error("Error: config file path is required\n");
		printHelp();
		Deno.exit(2);
	}

	return { configPath, dryRun, verbose, concurrency, retryAttempts };
}

async function main() {
	const { configPath, dryRun, verbose, concurrency, retryAttempts } = parseArgs(
		Deno.args,
	);

	// Load config
	let config;
	try {
		config = await loadConfig(configPath);
	} catch (err) {
		console.error(
			`Config error: ${err instanceof Error ? err.message : err}`,
		);
		Deno.exit(2);
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

	// Graceful abort on SIGINT/SIGTERM — avoids half-logged state when the
	// user interrupts a long cron run.
	const controller = new AbortController();
	const onSignal = () => {
		clog.warn("Received signal — aborting relay run...");
		controller.abort();
	};
	try {
		Deno.addSignalListener("SIGINT", onSignal);
		Deno.addSignalListener("SIGTERM", onSignal);
	} catch {
		// signals may not be available on all platforms — non-fatal
	}

	try {
		const result = await relay(config, {
			dryRun,
			clog,
			signal: controller.signal,
		});
		if (result.status === "aborted") Deno.exit(130);
		Deno.exit(result.success ? 0 : 1);
	} catch (err) {
		clog.error(
			`Fatal error: ${err instanceof Error ? err.message : err}`,
		);
		Deno.exit(2);
	} finally {
		try {
			Deno.removeSignalListener("SIGINT", onSignal);
			Deno.removeSignalListener("SIGTERM", onSignal);
		} catch {
			// ignore
		}
	}
}

main();
