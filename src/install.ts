/**
 * @module
 *
 * The `file-relay-install` scaffolder: after a few prompts, writes a new file-relay
 * instance directory — `config.json`, `.env.example`, `log/`, `track/`, and a
 * `package.json` that depends on `@marianmeres/file-relay` and runs it on Node
 * (`npm run backup`). From npm it is the `file-relay-install` bin
 * (`bin-install.ts`); from JSR, this module run directly:
 *
 * ```bash
 * npx -p @marianmeres/file-relay file-relay-install <dirname>
 * deno run -A jsr:@marianmeres/file-relay/install <dirname>
 * ```
 *
 * Either way the instance it writes runs on Node.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { VERSION } from "./version.ts";

/**
 * The instance's `npm run backup`. Runs the installed bin's JS file directly, so
 * Node's own `--env-file` loads `.env` (if there is one; a filesystem-only setup
 * needs none) — the `node_modules/.bin` entry is a shell shim under pnpm.
 */
const BACKUP_SCRIPT =
	"node --env-file-if-exists=.env node_modules/@marianmeres/file-relay/dist/bin.js config.json";

function printUsage() {
	console.log(
		`
file-relay install

Scaffold a new file-relay directory with config, env template, and package.json.

Usage:
  file-relay-install <dirname>

  Without installing: npx -p @marianmeres/file-relay file-relay-install <dirname>
  On Deno (JSR):      deno run -A jsr:@marianmeres/file-relay/install <dirname>

After install (the instance runs on Node >= 24.12):
  1. npm install
  2. Edit .env with your credentials
  3. Setup cron: npm run backup
`.trim(),
	);
}

/** Reads answers from stdin, one line per question. */
interface LineReader {
	/** Shows `question` and a space, as the `prompt()` global did, and reads a line. */
	ask(question: string): Promise<string>;
	close(): void;
}

/**
 * A {@linkcode LineReader} over stdin. Lines are queued as they arrive, so piped
 * answers (`printf '...' | file-relay install dir`) are all consumed, one per
 * question, as with Deno's `prompt()`; readline's `question()` would drop the lines
 * that arrive before it is asked. Without an output stream readline does no line
 * editing of its own: a terminal echoes the typing itself.
 */
function createLineReader(): LineReader {
	const rl = createInterface({ input: process.stdin });
	const lines = rl[Symbol.asyncIterator]();
	return {
		async ask(question) {
			process.stdout.write(`${question} `);
			const next = await lines.next();
			if (next.done)
				throw new Error("stdin closed before every question was answered");
			return next.value;
		},
		close() {
			rl.close();
		},
	};
}

async function askRequired(rl: LineReader, question: string): Promise<string> {
	while (true) {
		const answer = await rl.ask(question);
		if (answer.trim()) return answer.trim();
		console.log("  Value is required.");
	}
}

async function askChoice(
	rl: LineReader,
	question: string,
	choices: string[],
	defaultChoice?: string,
): Promise<string> {
	const hint = choices.map((c) => (c === defaultChoice ? `[${c}]` : c)).join("/");
	while (true) {
		const answer = await rl.ask(`${question} (${hint})`);
		if (!answer.trim() && defaultChoice) return defaultChoice;
		if (choices.includes(answer.trim())) return answer.trim();
		console.log(`  Please choose one of: ${choices.join(", ")}`);
	}
}

async function dirExists(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		return info.isDirectory();
	} catch {
		return false;
	}
}

/**
 * Runs the scaffolder: prompts on the terminal, then writes the instance.
 *
 * @param args - The command-line arguments (`process.argv.slice(2)`): the target
 *   directory, or `--help`.
 * @returns The process exit code: `0` done (or help), `1` the directory exists or
 *   stdin ended before every question was answered, `2` usage error.
 */
export async function runInstall(args: string[]): Promise<number> {
	const dirname = args[0];

	if (!dirname || dirname === "--help" || dirname === "-h") {
		printUsage();
		return dirname ? 0 : 2;
	}

	const targetDir = resolve(dirname);

	if (await dirExists(targetDir)) {
		console.error(`Error: directory already exists: ${targetDir}`);
		return 1;
	}

	const rl = createLineReader();
	try {
		await scaffold(rl, dirname, targetDir);
	} catch (err) {
		console.error(`\nError: ${err instanceof Error ? err.message : err}`);
		return 1;
	} finally {
		rl.close();
	}
	return 0;
}

async function scaffold(rl: LineReader, dirname: string, targetDir: string) {
	// Interactive prompts
	const sourceDir = await askRequired(rl, "Source directory to relay files from:");
	const adapter = await askChoice(
		rl,
		"Destination adapter:",
		["static-upload-server", "filesystem"],
		"static-upload-server",
	);

	let destinationConfig: Record<string, string>;
	let envExample: string;

	if (adapter === "filesystem") {
		const destDir = await askRequired(
			rl,
			"Destination directory (filesystem copy target):",
		);
		destinationConfig = { adapter: "filesystem", dir: destDir };
		envExample = "# No environment variables needed for filesystem adapter\n";
	} else {
		destinationConfig = {
			adapter: "static-upload-server",
			url: "${STATIC_UPLOAD_SERVER_URL}",
			token: "${STATIC_UPLOAD_SERVER_TOKEN}",
		};
		envExample = "STATIC_UPLOAD_SERVER_URL=...\nSTATIC_UPLOAD_SERVER_TOKEN=...\n";
	}

	// Optional email notification (e.g. a "the cron ran" heartbeat + failure alerts).
	const wantNotify =
		(await askChoice(
			rl,
			"Enable email notifications after each run?",
			["yes", "no"],
			"no",
		)) === "yes";

	let notifyConfig: Record<string, unknown> | undefined;
	if (wantNotify) {
		notifyConfig = {
			to: "${NOTIFY_TO}",
			from: "${NOTIFY_FROM}",
			on: "always",
			smtp: {
				host: "${SMTP_HOST}",
				port: 587,
				user: "${SMTP_USER}",
				pass: "${SMTP_PASS}",
			},
		};
		envExample +=
			"\n# Email notifications\n" +
			"NOTIFY_TO=ops@example.com\n" +
			"NOTIFY_FROM=file-relay@example.com\n" +
			"SMTP_HOST=smtp.example.com\n" +
			"SMTP_USER=...\n" +
			"SMTP_PASS=...\n";
	}

	const configJson = JSON.stringify(
		{
			logDir: "./log",
			trackDir: "./track",
			source: { dir: sourceDir, glob: "**/*" },
			destination: destinationConfig,
			...(notifyConfig ? { notify: notifyConfig } : {}),
		},
		null,
		"\t",
	);

	const packageJson = JSON.stringify(
		{
			private: true,
			scripts: { backup: BACKUP_SCRIPT },
			dependencies: { "@marianmeres/file-relay": `^${VERSION}` },
		},
		null,
		2, // npm's own package.json indent
	);

	// Create directory structure
	await mkdir(resolve(targetDir, "log"), { recursive: true });
	await mkdir(resolve(targetDir, "track"), { recursive: true });

	await writeFile(resolve(targetDir, "config.json"), configJson + "\n");
	await writeFile(resolve(targetDir, "package.json"), packageJson + "\n");
	await writeFile(resolve(targetDir, ".env.example"), envExample);
	await writeFile(resolve(targetDir, "log", ".gitkeep"), "");
	await writeFile(resolve(targetDir, "track", ".gitkeep"), "");

	console.log(`\nCreated file-relay instance at: ${targetDir}`);
	console.log(`\nNext steps:`);
	console.log(`  1. cd ${dirname} && npm install`);
	console.log(`  2. cp .env.example .env && edit .env`);
	console.log(`  3. Setup cron: cd ${targetDir} && npm run backup`);
}

// Run when this module is the program entrypoint — the JSR `./install` export, as
// `deno run -A jsr:@marianmeres/file-relay/install` executes it.
if (import.meta.main) {
	process.exitCode = await runInstall(process.argv.slice(2));
}
