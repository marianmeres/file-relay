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
  config.json     Path to the JSON config file (required)

Options:
  --dry-run       Find and report files without transferring
  --verbose       Enable debug-level log output
  --help          Show this help message
  --version       Show version
`.trim());
}

function parseArgs(args: string[]) {
	let configPath: string | null = null;
	let dryRun = false;
	let verbose = false;

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

	return { configPath, dryRun, verbose };
}

async function main() {
	const { configPath, dryRun, verbose } = parseArgs(Deno.args);

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

	if (!verbose) {
		createClog.global.debug = false;
	}

	const clog = createClog("file-relay");

	try {
		const result = await relay(config, { dryRun, clog });
		Deno.exit(result.success ? 0 : 1);
	} catch (err) {
		clog.error(
			`Fatal error: ${err instanceof Error ? err.message : err}`,
		);
		Deno.exit(2);
	}
}

main();
