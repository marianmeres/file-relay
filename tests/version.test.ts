// `src/version.ts` is written from `package.json` by `scripts/sync-version.ts` during
// `pnpm run release`. This fails when the two disagree (e.g. a hand edit of one of them).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { VERSION } from "../src/version.ts";

test("VERSION matches package.json", async () => {
	const pkg = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	) as { version: string };
	assert.equal(VERSION, pkg.version);
});
