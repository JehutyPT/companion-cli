import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CliError,
  type CliErrorOptions,
  errorMessage,
  UnsupportedVersionError,
} from "./errors.ts";
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

const UNREADABLE: CliErrorOptions = { code: "database_unreadable" };

/**
 * The files a snapshot copies: the database and its WAL, never `-shm`.
 * SQLite rebuilds the WAL index from the WAL when it opens the copy, so data
 * only in the WAL is still read, and copying `-shm` while Companion runs can
 * fail on Windows' mandatory locks.
 */
export const SNAPSHOT_FILE_SUFFIXES = ["", "-wal"] as const;

/** Copy errors a running Companion, antivirus or the indexer can cause briefly. */
const TRANSIENT_COPY_ERRORS = new Set(["EBUSY", "EPERM", "EACCES"]);

/** Waits between snapshot copy attempts: about one second in all. */
export const SNAPSHOT_COPY_RETRY_DELAYS_MS = [50, 100, 200, 300, 350] as const;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeSnapshotDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export interface DatabaseCopyOptions {
  /** Open the copy read-only. */
  readOnly: boolean;
  /** Directory for the temporary copy. Defaults to the OS temp directory. */
  tmpdir?: string | undefined;
  /** Copies one file. Defaults to `copyFileSync`; a test seam. */
  copyFile?: ((source: string, target: string) => void) | undefined;
  /** Removes the temporary directory. Defaults to `rmSync` with retries; a test seam. */
  removeDir?: ((dir: string) => void) | undefined;
  /** Blocks between copy retries. Defaults to a synchronous sleep; a test seam. */
  sleep?: ((ms: number) => void) | undefined;
}

/**
 * Copies one snapshot file, retrying transient lock errors over about one
 * second. A copy that still fails is `database_unreadable` naming the file.
 */
function copySnapshotFile(
  source: string,
  target: string,
  options: DatabaseCopyOptions,
): void {
  const copyFile = options.copyFile ?? copyFileSync;
  const sleep = options.sleep ?? sleepSync;
  for (let attempt = 0; ; attempt += 1) {
    try {
      copyFile(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const delay = SNAPSHOT_COPY_RETRY_DELAYS_MS[attempt];
      if (code && TRANSIENT_COPY_ERRORS.has(code) && delay !== undefined) {
        sleep(delay);
        continue;
      }
      const message = errorMessage(error);
      const detail =
        !code || message.startsWith(code) ? message : `${code}: ${message}`;
      throw new CliError(`cannot copy ${source}: ${detail}`, {
        ...UNREADABLE,
        cause: error,
      });
    }
  }
}

/**
 * Runs `fn` against a private copy of the database and its `-wal` (never
 * `-shm`, see `SNAPSHOT_FILE_SUFFIXES`) in a new temporary directory that is
 * deleted on every path; a failed deletion never masks the result or error.
 * Opening even read-only creates or rewrites `-shm`, so the original files
 * are only copied, never opened: they stay byte-identical. Errors from `fn`
 * that are not CliErrors become "cannot read database".
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
    for (const suffix of SNAPSHOT_FILE_SUFFIXES) {
      if (existsSync(dbPath + suffix)) {
        copySnapshotFile(dbPath + suffix, copyPath + suffix, options);
      }
    }
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(copyPath, { readOnly: options.readOnly });
    } catch (error) {
      throw new CliError(
        `cannot open database ${dbPath}: ${errorMessage(error)}`,
        UNREADABLE,
      );
    }
    try {
      return fn(db);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        `cannot read database ${dbPath}: ${errorMessage(error)}`,
        UNREADABLE,
      );
    } finally {
      db.close();
    }
  } finally {
    try {
      (options.removeDir ?? removeSnapshotDir)(dir);
    } catch {
      // A leftover temporary directory must not change the command's outcome.
    }
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

export const SNAPSHOT_INCONSISTENT_HINT = "retry, or quit Companion and retry";

/**
 * Refuses a snapshot copy whose `pragma integrity_check` fails. `label` names
 * the command in the message, such as "dry run" or "read".
 */
export function assertSnapshotConsistent(
  db: DatabaseSync,
  label: string,
): void {
  const rows = runIntegrityCheck(db);
  if (isIntegrityOk(rows)) return;
  throw new CliError(
    `${label}: the database snapshot is inconsistent (integrity check: ${integrityText(rows)}), perhaps copied while Companion was writing; nothing written. Retry, or quit Companion and retry`,
    { code: "snapshot_inconsistent", hint: SNAPSHOT_INCONSISTENT_HINT },
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
