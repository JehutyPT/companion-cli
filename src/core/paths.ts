import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join, resolve, win32 } from "node:path";
import type { Env } from "../rest/endpoint.ts";
import { CliError } from "./errors.ts";

/**
 * What locates the Companion install's database: the home directory, the
 * platform and the environment (`APPDATA` on Windows).
 */
export interface InstallContext {
  homedir: string;
  platform: NodeJS.Platform;
  env: Env;
}

/** The install context from command options, defaulting to this process's. */
export function installContext(options: {
  homedir?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  env?: Env | undefined;
}): InstallContext {
  return {
    homedir: options.homedir ?? osHomedir(),
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
  };
}

/**
 * The Companion 5.1 install's database on macOS, relative to the home
 * directory (host path rules).
 */
export const DEFAULT_DATABASE_RELATIVE_PATH = join(
  "Library",
  "Application Support",
  "companion",
  "v5.1",
  "db.sqlite",
);

/**
 * The platform's default configuration root, the folder Companion's launcher
 * passes to the server as `--config-dir` when nothing overrides it:
 *
 * - macOS: `~/Library/Application Support/companion`, with host path rules;
 * - Windows: `<APPDATA>\companion`, with `APPDATA` falling back to
 *   `<home>\AppData\Roaming` when unset or empty (Electron's `appData`),
 *   with Windows path rules on any host.
 *
 * Any other platform is refused. This is the last step of the root
 * resolution: the running server's `--config-dir` and
 * `COMPANION_CONFIG_BASEDIR` (#43) come before it.
 */
export function defaultConfigRoot(install: InstallContext): string {
  switch (install.platform) {
    case "darwin":
      return join(
        install.homedir,
        "Library",
        "Application Support",
        "companion",
      );
    case "win32": {
      const appData =
        install.env["APPDATA"] ||
        win32.join(install.homedir, "AppData", "Roaming");
      return win32.join(appData, "companion");
    }
    default:
      throw new CliError(
        `unsupported platform "${install.platform}": the local install is found on macOS and Windows only; pass --db with a database path`,
        { code: "unsupported_platform", hint: "pass --db <path>" },
      );
  }
}

/**
 * The Companion 5.1 database inside a configuration root: the server appends
 * `v5.1`. Windows roots use Windows path rules on any host.
 */
export function databaseInRoot(
  root: string,
  platform: NodeJS.Platform,
): string {
  return (platform === "win32" ? win32.join : join)(root, "v5.1", "db.sqlite");
}

/** The install's database at the platform's default configuration root. */
export function defaultDatabasePath(install: InstallContext): string {
  return databaseInRoot(defaultConfigRoot(install), install.platform);
}

/**
 * Expands a leading `~` (the shell does this for unquoted arguments only):
 * `~/` everywhere, and `~\` on Windows.
 */
export function expandHome(
  path: string,
  homedir: string,
  platform: NodeJS.Platform,
): string {
  if (path === "~") return homedir;
  if (platform === "win32" && /^~[\\/]/.test(path))
    return win32.join(homedir, path.slice(2));
  if (path.startsWith("~/")) return join(homedir, path.slice(2));
  return path;
}

/**
 * Resolves symlinks where the path exists; falls back to a plain absolute
 * path, with Windows path rules for a Windows install.
 */
function canonical(path: string, platform: NodeJS.Platform): string {
  try {
    return realpathSync(path);
  } catch {
    return platform === "win32" ? win32.resolve(path) : resolve(path);
  }
}

/**
 * True when `dbPath` is, or links to, the install's default database. When
 * both exist, comparing device and inode also catches hard links and the
 * different spellings a case-insensitive file system accepts. On Windows the
 * path comparison ignores case, as NTFS does.
 */
export function isDefaultInstallDatabase(
  dbPath: string,
  install: InstallContext,
): boolean {
  const defaultPath = defaultDatabasePath(install);
  const fold = (path: string) => {
    const full = canonical(path, install.platform);
    return install.platform === "win32" ? full.toLowerCase() : full;
  };
  if (fold(dbPath) === fold(defaultPath)) return true;
  try {
    const a = statSync(dbPath, { bigint: true });
    const b = statSync(defaultPath, { bigint: true });
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/** The database a command targets. */
export interface DatabaseTarget {
  dbPath: string;
  /** Live-install mode: no `--db`, so the install's database. */
  live: boolean;
}

/**
 * Resolves the target database:
 *
 *  1. `--db`, with `~` expanded;
 *  2. otherwise the install's database, `<root>/v5.1/db.sqlite` at the
 *     platform's default configuration root (macOS and Windows; any other
 *     platform is refused).
 *
 * #43 inserts the running server's `--config-dir` and
 * `COMPANION_CONFIG_BASEDIR` between the two, as the root step.
 */
export function resolveDatabaseTarget(
  requested: string | undefined,
  install: InstallContext,
): DatabaseTarget {
  if (requested === undefined) {
    return { dbPath: defaultDatabasePath(install), live: true };
  }
  return {
    dbPath: resolve(expandHome(requested, install.homedir, install.platform)),
    live: false,
  };
}

/**
 * Refuses a live-install write (no `--db`) where the tool cannot stop and
 * start Companion yet: Windows, until its process control lands (#40). Any
 * other platform without an install location is refused by the resolver.
 */
export function assertLiveWriteSupported(platform: NodeJS.Platform): void {
  if (platform === "win32") {
    throw new CliError(
      "live-install writes on Windows are not supported yet: the tool cannot stop and start Companion there; pass --db with a database path, or use apply --dry-run",
      { code: "unsupported_platform", hint: "pass --db <path>" },
    );
  }
}

/** Refuses a database path that is not an existing file. */
export function assertDatabaseExists(dbPath: string): void {
  if (!existsSync(dbPath) || !statSync(dbPath).isFile()) {
    throw new CliError(`database not found: ${dbPath}`, {
      code: "database_not_found",
      hint: "pass --db <path>, or check that Companion 5.1 has been run once",
    });
  }
}
