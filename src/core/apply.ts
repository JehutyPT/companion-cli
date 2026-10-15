import { DatabaseSync } from "node:sqlite";
import { backupDatabase, defaultBackupRoot } from "./backup.ts";
import {
  assertSupportedVersion,
  checkWriteVerify,
  withReadOnlySnapshot,
  WriteFailure,
} from "./database.ts";

export { runIntegrityCheck } from "./database.ts";
import { loadDescription, type WriterRegistry } from "./description.ts";
import { resolvePlan, type WriterRuntime } from "./resolve.ts";
import type { DescriptionKind, Writer } from "./writer.ts";
import {
  CliError,
  errorDetails,
  errorMessage,
  UnsupportedVersionError,
} from "./errors.ts";
import {
  assertDatabaseExists,
  assertLiveWriteSupported,
  type InstallContext,
  installContext,
  isDefaultInstallDatabase,
  resolveDatabaseTarget,
} from "./paths.ts";
import {
  DatabaseInUseError,
  DEFAULT_QUIT_TIMEOUT_MS,
  defaultProcessControl,
  type ProcessControl,
} from "./process.ts";

/**
 * The shared apply pipeline. Every writer goes through it, in this order:
 *
 *  1. in live-install mode (no `dbPath`), refuse any platform without an
 *     install location (macOS and Windows have one), and refuse a write on
 *     Windows, where the tool cannot stop and start Companion yet (a dry run
 *     goes ahead);
 *  2. read and validate the whole description file (no database access);
 *  3. the writer's `resolve`, once (environment values; in live-install mode
 *     what the running Companion knows, so before step 4 quits it); then on
 *     a read-only snapshot copy: the DB version guard and the writer's
 *     own database checks, so a refusal leaves the original files
 *     byte-identical (they are copied, never opened). Companion may still be
 *     running at this point;
 *  4. live-install mode: if the Companion server process is running, quit
 *     Companion and wait for that process to exit. With an explicit database
 *     path: refuse the install's database while Companion runs, and never
 *     quit or start Companion;
 *  5. on macOS and Windows, refuse if any other process has the database or
 *     its WAL files open (the in-use guard; it also catches a Companion step
 *     4 does not recognise), then back up the database and its WAL files;
 *  6. in one transaction, under the write lock: repeat the version guard and
 *     the writer's checks, let the writer write, run `pragma integrity_check`;
 *     commit only if it returns `ok`, otherwise roll back so the database
 *     content is unchanged;
 *  7. start Companion again if step 4 quit it, also after a failure in 4
 *     (except a wait timeout), 5 or 6;
 *  8. after a successful write and start, run `ApplyOptions.waitForRest`
 *     (the CLI waits for Companion's REST API) and report its outcome.
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
   * before the integrity check. Throwing simulates a write failure. A dry run
   * calls it too, on its private copy.
   */
  afterWrite?: (db: DatabaseSync) => void;
  /**
   * Test seam: replaces `pragma integrity_check`. Must return its result rows.
   */
  integrityCheck?: (db: DatabaseSync) => string[];
}

export interface ApplyOptions extends WriterRuntime {
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
  /** Quits, waits for and starts Companion. Defaults to the platform's implementation. */
  processControl?: ProcessControl;
  /** How long to wait for the server process to exit after a quit. */
  quitTimeoutMs?: number;
  /**
   * Runs after the start that follows a successful write, and only then. The
   * CLI waits for Companion's REST API here. Must not throw: the write is
   * committed. `null` means no wait happened.
   */
  waitForRest?: () => Promise<RestReadiness | null>;
  /** Directory for the temporary database copies (the read-only snapshot and a dry run's copy). Defaults to the OS temp directory. */
  tmpdir?: string;
}

export interface ApplyRequest {
  descriptionPath: string;
  /** The database to write. Omitted: the local install's database (live-install mode). */
  dbPath?: string | undefined;
  writers: WriterRegistry;
  /** `--unchecked`: settings no definition can check are accepted with a warning. */
  unchecked?: boolean;
}

export interface ApplyResult {
  backupDir: string;
  summary: string;
  /** The description's kind. */
  kind: DescriptionKind;
  /** The database written. */
  dbPath: string;
  /** Live-install mode: no `--db`, so the install's database. */
  live: boolean;
  /** Live-install mode quit Companion and started it again. */
  restarted: boolean;
  /** The wait for REST after the restart; `null` when there was none. */
  rest: RestReadiness | null;
  /** The writer's warnings (settings `--unchecked` let through unchecked). */
  warnings: string[];
}

/** How the wait for Companion's REST API after a restart ended. */
export type RestReadiness = "ready" | "timeout" | "not_configured";

/** A refusal that quitting Companion resolves. */
const COMPANION_RUNNING = {
  code: "companion_running",
  hint: "quit Companion and retry",
} as const;

/** The checked target of an apply or a dry run. */
export interface PreparedApply {
  dbPath: string;
  /** Live-install mode: no `--db`, so the install's database. */
  live: boolean;
  /** What located the install's database (home, platform, environment). */
  install: InstallContext;
  writer: Writer;
  plan: unknown;
  /** The writer's warnings from `resolve`. */
  warnings: string[];
}

/**
 * Steps 1 to 3, shared by `apply` and `dryRun` so both refuse with the same
 * messages: the platform guard, the description, the database's existence,
 * the writer's `resolve` (once: environment values and, in live-install
 * mode, what the running Companion knows, before it is quit), and the
 * version guard and the writer's checks on a read-only snapshot.
 */
export async function prepareApply(
  request: ApplyRequest,
  options: ApplyOptions = {},
): Promise<PreparedApply> {
  const install = installContext(options);
  const { dbPath, live } = resolveDatabaseTarget(request.dbPath, install);

  const { writer, plan: parsed } = loadDescription(
    request.descriptionPath,
    request.writers,
  );

  assertDatabaseExists(dbPath);

  const { plan, warnings } = await resolvePlan(writer, parsed, {
    live,
    unchecked: request.unchecked ?? false,
    runtime: options,
    read: (reader) =>
      withReadOnlySnapshot(
        dbPath,
        (db) => {
          assertSupportedVersion(db);
          return reader(db);
        },
        options.tmpdir,
      ),
  });

  withReadOnlySnapshot(
    dbPath,
    (db) => {
      assertSupportedVersion(db);
      writer.check?.(db, plan);
    },
    options.tmpdir,
  );
  return {
    dbPath,
    live,
    install,
    writer,
    plan,
    warnings,
  };
}

export async function apply(
  request: ApplyRequest,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  // Step 1's write refusal comes before the description is read, as the
  // platform guard does. #40 removes it.
  const { platform } = installContext(options);
  if (request.dbPath === undefined) assertLiveWriteSupported(platform);
  const { dbPath, live, install, writer, plan, warnings } = await prepareApply(
    request,
    options,
  );

  const control = options.processControl ?? defaultProcessControl(platform);
  // Steps 5 and 6, after the in-use guard. On other platforms (`--db` only)
  // there is no process check at all.
  const write = async (): Promise<ApplyResult> => {
    if (platform === "darwin" || platform === "win32") {
      await assertNotInUse(control, dbPath);
    }
    const written = writeStopped(dbPath, writer, plan, options);
    return {
      ...written,
      kind: writer.kind,
      dbPath,
      live,
      restarted: false,
      rest: null,
      warnings,
    };
  };

  if (!live) {
    if (
      platform === "darwin" &&
      isDefaultInstallDatabase(dbPath, install) &&
      (await runningServer(control)).length > 0
    ) {
      throw new CliError(
        `refusing to write the Companion install's database (${dbPath}) while Companion is running; quit Companion or omit --db to let the tool stop and restart it`,
        COMPANION_RUNNING,
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
        { ...COMPANION_RUNNING, cause: error },
      ),
    );
  }
  if (!exited) {
    throw new CliError(
      `Companion's server process did not exit within ${timeoutMs / 1000} seconds; nothing written. Companion may be partly stopped: check it and start it if needed`,
      { code: "quit_timeout", hint: COMPANION_RUNNING.hint },
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
      {
        code: "restart_failed",
        hint: "start Companion manually; the write is committed",
        committed: true,
        backup: result.backupDir,
        cause: error,
      },
    );
  }
  const rest = (await options.waitForRest?.()) ?? null;
  return { ...result, restarted: true, rest };
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
      { ...errorDetails(error), hint: restartHint(error), cause: error },
    );
  }
  throw error;
}

/**
 * The hint when Companion did not start after a failure: start it, then what
 * the failure's own hint says about the database once a backup exists.
 */
function restartHint(error: unknown): string {
  const start = "start Companion manually";
  return error instanceof CliError &&
    error.code === "write_failed" &&
    error.hint !== undefined
    ? `${start}; ${error.hint}`
    : `${start}; nothing was written`;
}

/** The running Companion server process's PIDs. A failing check refuses the apply (fails closed). */
async function runningServer(control: ProcessControl): Promise<number[]> {
  try {
    return await control.serverPids();
  } catch (error) {
    throw new CliError(
      `cannot tell whether Companion is running (${errorMessage(error)}); refusing to write`,
      { ...COMPANION_RUNNING, cause: error },
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
    if (error instanceof DatabaseInUseError) {
      throw new CliError(
        `refusing to write ${dbPath}: the database is open in another process; close it first`,
        { ...COMPANION_RUNNING, cause: error },
      );
    }
    throw new CliError(
      `cannot tell whether the database is in use (${errorMessage(error)}); refusing to write ${dbPath}`,
      { ...COMPANION_RUNNING, cause: error },
    );
  }
  const others = holders.filter((pid) => pid !== process.pid);
  if (others.length > 0) {
    throw new CliError(
      `refusing to write ${dbPath}: the database is open in another process (PID ${others.join(", ")}); close it first`,
      COMPANION_RUNNING,
    );
  }
}

/** Steps 5 and 6: back up and write a database nothing else has open. */
function writeStopped<Plan>(
  dbPath: string,
  writer: Writer<Plan>,
  plan: Plan,
  options: ApplyOptions,
): { backupDir: string; summary: string } {
  const backupDir = backupDatabase(
    dbPath,
    options.backupRoot ?? defaultBackupRoot(dbPath),
    (options.now ?? (() => new Date()))(),
  );
  options.log?.(`backup: ${backupDir}`);
  const unchanged = {
    code: "write_failed",
    hint: `the database is unchanged; the backup is at ${backupDir}`,
    backup: backupDir,
  } as const;

  const hooks = options.hooks ?? {};
  hooks.afterBackup?.(dbPath);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
  } catch (error) {
    throw new CliError(
      `cannot open database ${dbPath} for writing: ${errorMessage(error)} (backup kept at ${backupDir})`,
      { ...unchanged, cause: error },
    );
  }
  try {
    db.exec("BEGIN IMMEDIATE");
    const summary = checkWriteVerify(db, writer, plan, hooks);
    db.exec("COMMIT");
    return { backupDir, summary };
  } catch (error) {
    if (db.isTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new CliError(
          `write failed and rollback failed; restore from the backup at ${backupDir}: ${errorMessage(error)}; ${errorMessage(rollbackError)}`,
          {
            ...unchanged,
            hint: `restore from the backup at ${backupDir}`,
            cause: error,
          },
        );
      }
    }
    if (!(error instanceof WriteFailure) && error instanceof CliError) {
      // A refusal under the write lock (version guard or writer check), not a write failure.
      const ErrorType =
        error instanceof UnsupportedVersionError
          ? UnsupportedVersionError
          : CliError;
      throw new ErrorType(
        `${error.message} (nothing written; backup kept at ${backupDir})`,
        { ...errorDetails(error), backup: backupDir, cause: error },
      );
    }
    throw new CliError(
      `write failed, rolled back, database unchanged (backup kept at ${backupDir}): ${errorMessage(error)}`,
      {
        ...unchanged,
        cause: error instanceof WriteFailure ? error.cause : error,
      },
    );
  } finally {
    db.close();
  }
}
