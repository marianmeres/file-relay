/**
 * Carries the `package.json` version into `src/version.ts` — the release tool's
 * `--before-commit` step (`pnpm run release`), so the bump and the constant land in
 * the same tagged commit.
 *
 *   node scripts/sync-version.ts
 *
 * Re-running it when the two already agree is a no-op. `tests/version.test.ts`
 * checks the same agreement on every `pnpm test`, so a hand edit that skips this
 * script fails there.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { exit } from "node:process";

const ROOT = new URL("../", import.meta.url);
const TARGET = new URL("src/version.ts", ROOT);
const CONSTANT = /^export const VERSION: string = "[^"]*";$/m;

const version = (
	JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8")) as {
		version?: unknown;
	}
).version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
	console.error(
		`sync-version: package.json has no semver "version" (got ${JSON.stringify(version)}).`,
	);
	exit(1);
}

const source = readFileSync(TARGET, "utf8");
if (!CONSTANT.test(source)) {
	console.error("sync-version: src/version.ts has no `export const VERSION` line.");
	exit(1);
}

const next = source.replace(CONSTANT, `export const VERSION: string = "${version}";`);
if (next !== source) {
	writeFileSync(TARGET, next);
	console.log(`sync-version: src/version.ts → ${version}`);
}
