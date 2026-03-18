/**
 * Example: relay test files to a real static-upload-server.
 *
 * Usage:
 *   deno run -A --env-file=example/.env example/file-relay-example.ts
 *
 * Required env vars (see .env.example):
 *   STATIC_UPLOAD_SERVER_URL
 *   STATIC_UPLOAD_SERVER_TOKEN
 */

import { dirname, fromFileUrl, join } from "@std/path";
import { ensureDir } from "@std/fs";
import { relay, validateConfig } from "../src/mod.ts";

const url = Deno.env.get("STATIC_UPLOAD_SERVER_URL");
const token = Deno.env.get("STATIC_UPLOAD_SERVER_TOKEN");

if (!url || !token) {
	console.error(
		"Missing STATIC_UPLOAD_SERVER_URL or STATIC_UPLOAD_SERVER_TOKEN.",
		"\nRun with: deno run -A --env-file=example/.env example/file-relay-example.ts",
	);
	Deno.exit(2);
}

// --- dirs relative to this script's location ---

const exampleDir = dirname(fromFileUrl(import.meta.url));
const sourceDir = join(exampleDir, "source");
const logDir = join(exampleDir, "log");
const trackDir = join(exampleDir, "track");

// --- create a timestamped dummy file before each run ---

await ensureDir(join(sourceDir, "dummy"));

const ts = new Date().toISOString().replace(/[:.]/g, "-");
await Deno.writeTextFile(
	join(sourceDir, "dummy", `${ts}.txt`),
	`file-relay example run at ${new Date().toISOString()}\n`,
);

console.log(`Source dir: ${sourceDir}`);
console.log(`Log dir:    ${logDir}`);
console.log(`Track dir:  ${trackDir}`);
console.log(`Target:     ${url}`);
console.log();

// --- run relay ---

const config = validateConfig({
	logDir,
	trackDir,
	source: {
		dir: sourceDir,
		glob: "**/*.txt",
	},
	destination: {
		adapter: "static-upload-server",
		url,
		token,
	},
});

const result = await relay(config);

console.log();
console.log("--- Result ---");
console.log(`Success:             ${result.success}`);
console.log(`Files found:         ${result.filesFound}`);
console.log(`Already transferred: ${result.filesAlreadyTransferred}`);
console.log(`Transfers:           ${result.transfers.length}`);
console.log(`Duration:            ${(result.durationMs / 1000).toFixed(1)}s`);

for (const t of result.transfers) {
	console.log(
		`  ${t.success ? "OK" : "FAIL"} ${t.sourceFile.relativePath}` +
			` -> ${t.destination}`,
	);
}
