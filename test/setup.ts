/**
 * Test bootstrap, loaded before any test code (`--import` in the `test`
 * script, and imported first by helpers.ts for single-file runs).
 *
 * It points `HOME`, `USERPROFILE` and `APPDATA` at a fresh temp directory,
 * and removes `LOCALAPPDATA`, `XDG_CONFIG_HOME` and `COMPANION_CONFIG_BASEDIR`,
 * so `os.homedir()` (the
 * fallback for a missing `homedir` option) and the Windows app-data directory
 * can never resolve to the developer's real profile: a dropped option then
 * fails on a missing database instead of writing the real Companion install's
 * database.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, relative, isAbsolute, win32 } from "node:path";
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
// Moves Companion's configuration root (the Windows dev box sets it
// machine-wide, pointing at a git-tracked folder).
delete process.env["COMPANION_CONFIG_BASEDIR"];
process.on("exit", () => rmSync(TEST_HOME, { recursive: true, force: true }));

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Throws when `path` is inside a real home directory and not inside the test
 * home. The test home itself may be inside the real one: on Windows the temp
 * directory is usually `%LOCALAPPDATA%\Temp`, under the profile.
 */
export function assertNotRealHome(path: string): void {
  if (isInside(path, TEST_HOME)) return;
  for (const real of REAL_HOMES) {
    if (isInside(path, real)) {
      throw new Error(`test resolved ${path}, inside the real home ${real}`);
    }
  }
}

if (homedir() !== TEST_HOME) {
  throw new Error(`os.homedir() is ${homedir()}, not the test home`);
}
assertNotRealHome(
  defaultDatabasePath({ homedir: homedir(), platform: "darwin", env: {} }),
);

/**
 * True when the Windows path `path` is inside `dir`, with Windows path rules
 * (case-insensitive) on every host.
 */
export function isInsideWindows(path: string, dir: string): boolean {
  const rel = win32.relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !win32.isAbsolute(rel));
}

/** The Windows install's database with the bootstrap's `APPDATA`. */
export const TEST_WINDOWS_DATABASE = defaultDatabasePath({
  homedir: homedir(),
  platform: "win32",
  env: process.env,
});
if (!isInsideWindows(TEST_WINDOWS_DATABASE, TEST_HOME)) {
  throw new Error(
    `the Windows install's database ${TEST_WINDOWS_DATABASE} is outside the test home`,
  );
}
