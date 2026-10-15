/**
 * Test bootstrap, loaded before any test code (`--import` in the `test`
 * script, and imported first by helpers.ts for single-file runs).
 *
 * It points `HOME`, `USERPROFILE` and `APPDATA` at a fresh temp directory,
 * and removes `LOCALAPPDATA` and `XDG_CONFIG_HOME`, so `os.homedir()` (the
 * fallback for a missing `homedir` option) and the Windows app-data directory
 * can never resolve to the developer's real profile: a dropped option then
 * fails on a missing database instead of writing the real Companion install's
 * database.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { defaultDatabasePath } from "../src/core/paths.ts";

/** The home directories a test must never resolve to. */
export const REAL_HOMES: readonly string[] = [
  ...new Set([homedir(), userInfo().homedir]),
];

export const TEST_HOME = mkdtempSync(join(tmpdir(), "companion-cli-home-"));

process.env["HOME"] = TEST_HOME;
process.env["USERPROFILE"] = TEST_HOME;
process.env["APPDATA"] = TEST_HOME;
delete process.env["LOCALAPPDATA"];
delete process.env["XDG_CONFIG_HOME"];
process.on("exit", () => rmSync(TEST_HOME, { recursive: true, force: true }));

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Throws when `path` is inside a real home directory. */
export function assertNotRealHome(path: string): void {
  for (const real of REAL_HOMES) {
    if (isInside(path, real)) {
      throw new Error(`test resolved ${path}, inside the real home ${real}`);
    }
  }
}

if (homedir() !== TEST_HOME) {
  throw new Error(`os.homedir() is ${homedir()}, not the test home`);
}
assertNotRealHome(defaultDatabasePath(homedir()));
