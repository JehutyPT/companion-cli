import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError } from "./errors.ts";

/** The Companion 5.1 install's database on macOS, relative to the home directory. */
export const DEFAULT_DATABASE_RELATIVE_PATH = join(
  "Library",
  "Application Support",
  "companion",
  "v5.1",
  "db.sqlite",
);

export function defaultDatabasePath(homedir: string): string {
  return join(homedir, DEFAULT_DATABASE_RELATIVE_PATH);
}

/** Expands a leading `~` (the shell does this for unquoted arguments only). */
export function expandHome(path: string, homedir: string): string {
  if (path === "~") return homedir;
  if (path.startsWith("~/")) return join(homedir, path.slice(2));
  return path;
}

/** Resolves symlinks where the path exists; falls back to a plain absolute path. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * True when `dbPath` is, or links to, the install's default database. When
 * both exist, comparing device and inode also catches hard links and the
 * different spellings a case-insensitive file system accepts.
 */
export function isDefaultInstallDatabase(
  dbPath: string,
  homedir: string,
): boolean {
  const defaultPath = defaultDatabasePath(homedir);
  if (canonical(dbPath) === canonical(defaultPath)) return true;
  try {
    const a = statSync(dbPath);
    const b = statSync(defaultPath);
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
 * Resolves `--db` (with `~` expanded) or, without it, the install's database.
 * Live-install mode is refused on any platform but macOS.
 */
export function resolveDatabaseTarget(
  requested: string | undefined,
  homedir: string,
  platform: NodeJS.Platform,
): DatabaseTarget {
  if (requested === undefined) {
    if (platform !== "darwin") {
      throw new CliError(
        `unsupported platform "${platform}": live-install mode only supports macOS; pass --db with a database path`,
        { code: "unsupported_platform", hint: "pass --db <path>" },
      );
    }
    return { dbPath: defaultDatabasePath(homedir), live: true };
  }
  return { dbPath: resolve(expandHome(requested, homedir)), live: false };
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
