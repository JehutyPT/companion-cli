import { existsSync, statSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupDatabase, defaultBackupRoot } from "./backup.ts";
import { assertSupportedVersion, withReadOnlySnapshot } from "./database.ts";
import { loadDescription, type WriterRegistry } from "./description.ts";
import type { Writer } from "./writer.ts";
import { CliError, errorMessage, UnsupportedVersionError } from "./errors.ts";
import {
  defaultDatabasePath,
  expandHome,
  isDefaultInstallDatabase,
} from "./paths.ts";
import {
  DEFAULT_QUIT_TIMEOUT_MS,
  macosProcessControl,
  type ProcessControl,
} from "./process.ts";

/**
 * The shared apply pipeline. Every writer goes through it, in this order:
 *
 *  1. in live-install mode (no `dbPath`), refuse any platform but macOS;
 *  2. read and validate the whole description file (no database access);
 *  3. on a read-only snapshot copy: the DB version guard and the writer's
 *     own database checks, so a refusal leaves the original files
 *     byte-identical (they are copied, never opened). Companion may still be
 *     running at this point;
 *  4. live-install mode: if the Companion server process is running, quit
 *     Companion and wait for that process to exit. With an explicit database
 *     path: refuse the install's database while Companion runs, and never
 *     quit or start Companion;
 *  5. on macOS, refuse if any other process has the database or its WAL
 *     files open (the in-use guard; it also catches a Companion step 4 does
 *     not recognise), then back up the database and its WAL files;
 *  6. in one transaction, under the write lock: repeat the version guard and
 *     the writer's checks, let the writer write, run `pragma integrity_check`;
 *     commit only if it returns `ok`, otherwise roll back so the database
 *     content is unchanged;
 *  7. start Companion again if step 4 quit it, also after a failure in 4
 *     (except a wait timeout), 5 or 6.
 *
 * Process control goes through `ApplyOptions.processControl`; the pipeline
 * never runs commands itself.
 *
 * Writers (src/writers/) only parse descriptions and write rows; they cannot
 * change these guarantees.
 */

export interface ApplyHooks {
  /**
   * Test seam: runs after the backup and before the database is opened for
   * writing. Lets a test change the database between the snapshot check and
   * the write.
   */
  afterBackup?: (dbPath: string) => void;
  /**
   * Test seam: runs inside the transaction after the writer has written and
   * before the integrity check. Throwing simulates a write failure.
   */
  afterWrite?: (db: DatabaseSync) => void;
  /** Test seam: replaces `pragma integrity_check`. Must return its result rows. */
  integrityCheck?: (db: DatabaseSync) => string[];
}

export interface ApplyOptions {
  /** Home directory used for `~` and the install path. Defaults to the OS home. */
  homedir?: string;
  /** Directory that receives timestamped backups. Defaults to `companion-cli-backups` next to the database. */
  backupRoot?: string;
  /** Clock for the backup directory name. */
  now?: () => Date;
  /** Progress lines (the backup path) as they happen, before the write. */
  log?: (line: string) => void;
  hooks?: ApplyHooks;
  /** Platform deciding whether live-install mode is supported. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Quits, waits for and starts Companion. Defaults to the macOS implementation. */
  processControl?: ProcessControl;
  /** How long to wait for the server process to exit after a quit. */
  quitTimeoutMs?: number;
}

export interface ApplyRequest {
  descriptionPath: string;
  /** The database to write. Omitted: the local install's database (live-install mode). */
  dbPath?: string | undefined;
  writers: WriterRegistry;
}

export interface ApplyResult {
  backupDir: string;
  summary: string;
}

export function runIntegrityCheck(db: DatabaseSync): string[] {
  return db
    .prepare("PRAGMA integrity_check")
    .all()
    .map((row) => String(Object.values(row)[0]));
}

export async function apply(
  request: ApplyRequest,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const home = options.homedir ?? osHomedir();
  const platform = options.platform ?? process.platform;
  const requested = request.dbPath;
  const live = requested === undefined;
  if (live && platform !== "darwin") {
    throw new CliError(
      `unsupported platform "${platform}": live-install mode only supports macOS; pass --db with a database path`,
    );
  }
  const dbPath = live
    ? defaultDatabasePath(home)
    : resolve(expandHome(requested, home));

  const { writer, plan } = loadDescription(
    request.descriptionPath,
    request.writers,
  );

  if (!existsSync(dbPath) || !statSync(dbPath).isFile()) {
    throw new CliError(`database not found: ${dbPath}`);
  }

  withReadOnlySnapshot(dbPath, (db) => {
    assertSupportedVersion(db);
    writer.check?.(db, plan);
  });

  const control = options.processControl ?? macosProcessControl();
  // Steps 5 and 6, after the in-use guard. On non-macOS (`--db` only) there
  // is no process check at all.
  const write = async () => {
    if (platform === "darwin") await assertNotInUse(control, dbPath);
    return writeStopped(dbPath, writer, plan, options);
  };

  if (!live) {
    if (
      platform === "darwin" &&
      isDefaultInstallDatabase(dbPath, home) &&
      (await runningServer(control)).length > 0
    ) {
      throw new CliError(
        `refusing to write the Companion install's database (${dbPath}) while Companion is running; quit Companion or omit --db to let the tool stop and restart it`,
      );
    }
    return write();
  }

  const pids = await runningServer(control);
  if (pids.length === 0) return write();

  // From here on the tool may have stopped Companion: every exit except a
  // wait timeout starts it again.
  const timeoutMs = options.quitTimeoutMs ?? DEFAULT_QUIT_TIMEOUT_MS;
  options.log?.("quitting Companion");
  let exited: boolean;
  try {
    await control.quit();
    exited = await control.waitForExit(pids, timeoutMs);
  } catch (error) {
    // Nothing is written yet; `open -a` is harmless if Companion still runs.
    return startAfterFailure(
      control,
      options,
      new CliError(
        `cannot quit Companion: ${errorMessage(error)}; nothing written`,
        { cause: error },
      ),
    );
  }
  if (!exited) {
    throw new CliError(
      `Companion's server process did not exit within ${timeoutMs / 1000} seconds; nothing written. Companion may be partly stopped: check it and start it if needed`,
    );
  }

  let result: ApplyResult;
  try {
    result = await write();
  } catch (error) {
    return startAfterFailure(control, options, error);
  }
  options.log?.("starting Companion");
  try {
    await control.start();
  } catch (error) {
    throw new CliError(
      `the change was written (backup kept at ${result.backupDir}) but Companion did not start again; start Companion manually: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  return result;
}

/**
 * Starts Companion after a failure once the tool quit it, then rethrows the
 * original error, adding the start error if that fails too.
 */
async function startAfterFailure(
  control: ProcessControl,
  options: ApplyOptions,
  error: unknown,
): Promise<never> {
  options.log?.("starting Companion");
  try {
    await control.start();
  } catch (startError) {
    throw new CliError(
      `${errorMessage(error)}; Companion was quit and did not start again, start Companion manually: ${errorMessage(startError)}`,
      { cause: error },
    );
  }
  throw error;
}

/** The running Companion server process's PIDs. A failing check refuses the apply (fails closed). */
async function runningServer(control: ProcessControl): Promise<number[]> {
  try {
    return await control.serverPids();
  } catch (error) {
    throw new CliError(
      `cannot tell whether Companion is running (${errorMessage(error)}); refusing to write`,
      { cause: error },
    );
  }
}

/**
 * Refuses when any other process has the database or its WAL files open.
 * A failing check refuses too (fails closed).
 */
async function assertNotInUse(
  control: ProcessControl,
  dbPath: string,
): Promise<void> {
  let holders: number[];
  try {
    holders = await control.databaseHolders(dbPath);
  } catch (error) {
    throw new CliError(
      `cannot tell whether the database is in use (${errorMessage(error)}); refusing to write ${dbPath}`,
      { cause: error },
    );
  }
  const others = holders.filter((pid) => pid !== process.pid);
  if (others.length > 0) {
    throw new CliError(
      `refusing to write ${dbPath}: the database is open in another process (PID ${others.join(", ")}); close it first`,
    );
  }
}

/** Steps 5 and 6: back up and write a database nothing else has open. */
function writeStopped<Plan>(
  dbPath: string,
  writer: Writer<Plan>,
  plan: Plan,
  options: ApplyOptions,
): ApplyResult {
  const backupDir = backupDatabase(
    dbPath,
    options.backupRoot ?? defaultBackupRoot(dbPath),
    (options.now ?? (() => new Date()))(),
  );
  options.log?.(`backup: ${backupDir}`);

  const hooks = options.hooks ?? {};
  hooks.afterBackup?.(dbPath);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
  } catch (error) {
    throw new CliError(
      `cannot open database ${dbPath} for writing: ${errorMessage(error)} (backup kept at ${backupDir})`,
    );
  }
  let writing = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    assertSupportedVersion(db);
    writer.check?.(db, plan);
    writing = true;
    const summary = writer.write(db, plan);
    hooks.afterWrite?.(db);
    const integrity = (hooks.integrityCheck ?? runIntegrityCheck)(db);
    if (integrity.length !== 1 || integrity[0] !== "ok") {
      throw new CliError(
        `integrity check failed: ${integrity.join("; ") || "no result"}`,
      );
    }
    db.exec("COMMIT");
    return { backupDir, summary };
  } catch (error) {
    if (db.isTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new CliError(
          `write failed and rollback failed; restore from the backup at ${backupDir}: ${errorMessage(error)}; ${errorMessage(rollbackError)}`,
          { cause: error },
        );
      }
    }
    if (!writing && error instanceof CliError) {
      // A refusal under the write lock (version guard or writer check), not a write failure.
      const ErrorType =
        error instanceof UnsupportedVersionError
          ? UnsupportedVersionError
          : CliError;
      throw new ErrorType(
        `${error.message} (nothing written; backup kept at ${backupDir})`,
        { cause: error },
      );
    }
    throw new CliError(
      `write failed, rolled back, database unchanged (backup kept at ${backupDir}): ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  } finally {
    db.close();
  }
}
