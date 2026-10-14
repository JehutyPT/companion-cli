import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CliError, errorMessage, UnsupportedVersionError } from "./errors.ts";

/** `page_config_version` of Companion 5.1. The only DB version the tool supports. */
export const SUPPORTED_DB_VERSION = 17;

/** The database file and the WAL files SQLite keeps next to it. */
export const DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;

/**
 * Copies the database file and whichever of its WAL files exist to
 * `targetPath` plus the same suffixes. `mode` is passed to copyFileSync.
 */
export function copyDatabaseFiles(
  dbPath: string,
  targetPath: string,
  mode = 0,
): void {
  for (const suffix of DATABASE_FILE_SUFFIXES) {
    if (existsSync(dbPath + suffix)) {
      copyFileSync(dbPath + suffix, targetPath + suffix, mode);
    }
  }
}

/**
 * Parses a stored `value` cell. Companion declares `value STRING`, which
 * SQLite gives NUMERIC affinity, so `"17"` comes back as the integer 17;
 * converting to text first restores the stored JSON. Text that is not JSON is
 * returned as is.
 */
export function parseStoredJson(value: unknown): unknown {
  const text = String(value);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Reads one JSON value from a Companion key/value table. */
export function readJsonValue(
  db: DatabaseSync,
  table: string,
  id: string,
): unknown {
  const row = db.prepare(`SELECT value FROM ${table} WHERE id = ?`).get(id);
  return row === undefined ? undefined : parseStoredJson(row["value"]);
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
  );
}

/** Refuses any database whose `main.page_config_version` is not exactly 17. */
export function assertSupportedVersion(db: DatabaseSync): void {
  const version = tableExists(db, "main")
    ? readJsonValue(db, "main", "page_config_version")
    : undefined;
  if (version === SUPPORTED_DB_VERSION) return;
  const found = version === undefined ? "missing" : JSON.stringify(version);
  throw new UnsupportedVersionError(
    `unsupported database: page_config_version is ${found}; only ${SUPPORTED_DB_VERSION} (Companion 5.1) is supported`,
  );
}

/**
 * Runs `fn` against a read-only copy of the database, including its WAL files.
 * Opening even read-only creates or rewrites `-shm`, so the original files are
 * only copied, never opened: a refused apply leaves them byte-identical.
 */
export function withReadOnlySnapshot<T>(
  dbPath: string,
  fn: (db: DatabaseSync) => T,
): T {
  const dir = mkdtempSync(join(tmpdir(), "companion-cli-snapshot-"));
  try {
    const snapshotPath = join(dir, basename(dbPath));
    copyDatabaseFiles(dbPath, snapshotPath);
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(snapshotPath, { readOnly: true });
    } catch (error) {
      throw new CliError(
        `cannot open database ${dbPath}: ${errorMessage(error)}`,
      );
    }
    try {
      return fn(db);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        `cannot read database ${dbPath}: ${errorMessage(error)}`,
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
