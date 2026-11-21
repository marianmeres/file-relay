/**
 * The package version, as the CLI prints it.
 *
 * A module constant rather than a `package.json` read: the CLI runs from `src/`
 * (Node, tests), from `dist/` (npm) and from JSR's https-served source (Deno), and a
 * `.ts` constant resolves the same way in all three. `scripts/sync-version.ts` writes
 * it from `package.json` during `pnpm run release`; `tests/version.test.ts` fails when
 * the two disagree.
 *
 * @module
 */

/** The package version. */
export const VERSION: string = "1.7.0";
