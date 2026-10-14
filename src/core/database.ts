import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CliError, errorMessage, UnsupportedVersionError } from "./errors.ts";
import type { Writer } from "./writer.ts";

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

export interface DatabaseCopyOptions {
  /** Open the copy read-only. */
  readOnly: boolean;
  /** Directory for the temporary copy. Defaults to the OS temp directory. */
  tmpdir?: string | undefined;
}

/**
 * Runs `fn` against a private copy of the database, including its WAL files,
 * in a new temporary directory that is deleted on every path. Opening even
 * read-only creates or rewrites `-shm`, so the original files are only
 * copied, never opened: they stay byte-identical. Errors from `fn` that are
 * not CliErrors become "cannot read database".
 */
export function withDatabaseCopy<T>(
  dbPath: string,
  options: DatabaseCopyOptions,
  fn: (db: DatabaseSync) => T,
): T {
  const dir = mkdtempSync(
    join(options.tmpdir ?? tmpdir(), "companion-cli-copy-"),
  );
  try {
    const copyPath = join(dir, basename(dbPath));
    copyDatabaseFiles(dbPath, copyPath);
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(copyPath, { readOnly: options.readOnly });
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

/** Runs `fn` against a read-only copy of the database (see `withDatabaseCopy`). */
export function withReadOnlySnapshot<T>(
  dbPath: string,
  fn: (db: DatabaseSync) => T,
  tmpdir?: string,
): T {
  return withDatabaseCopy(dbPath, { readOnly: true, tmpdir }, fn);
}

export function runIntegrityCheck(db: DatabaseSync): string[] {
  return db
    .prepare("PRAGMA integrity_check")
    .all()
    .map((row) => String(Object.values(row)[0]));
}

/** Whether `pragma integrity_check` rows say the database is consistent. */
export function isIntegrityOk(rows: string[]): boolean {
  return rows.length === 1 && rows[0] === "ok";
}

/** The rows of a failed integrity check on one line. */
export function integrityText(rows: string[]): string {
  return (
    rows.map((row) => row.replace(/\s*\n\s*/g, " ")).join("; ") || "no result"
  );
}

/**
 * The checked write shared by `apply` and the dry run, inside the caller's
 * transaction: the version guard and the writer's checks, then `beforeWrite`,
 * the write, the `afterWrite` hook and `pragma integrity_check` (or the hook
 * replacing it). Anything failing from the write on is a `WriteFailure`;
 * refusals before it are thrown as they are.
 */
export function checkWriteVerify<Plan>(
  db: DatabaseSync,
  writer: Writer<Plan>,
  plan: Plan,
  hooks: WriteHooks = {},
  beforeWrite?: () => void,
): string {
  assertSupportedVersion(db);
  writer.check?.(db, plan);
  beforeWrite?.();
  try {
    const summary = writer.write(db, plan);
    hooks.afterWrite?.(db);
    const integrity = (hooks.integrityCheck ?? runIntegrityCheck)(db);
    if (!isIntegrityOk(integrity)) {
      throw new CliError(`integrity check failed: ${integrityText(integrity)}`);
    }
    return summary;
  } catch (error) {
    throw new WriteFailure(error);
  }
}

/** The hooks `checkWriteVerify` honours (see `ApplyHooks`). */
export interface WriteHooks {
  afterWrite?: (db: DatabaseSync) => void;
  integrityCheck?: (db: DatabaseSync) => string[];
}

/** A failure during or after the write; `cause` is the original error. */
export class WriteFailure extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = "WriteFailure";
  }
}
