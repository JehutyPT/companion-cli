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
  configDirOf,
  type ConfigRoot,
  describeDatabase,
  type InstallContext,
  installContext,
  isInstallDatabase,
  launchEnvironment,
  resolveDatabaseTarget,
  sameRoot,
  type ServerCommandLine,
} from "./paths.ts";
import {
  type CompanionLaunch,
  type CompanionServer,
  DatabaseInUseError,
  DEFAULT_QUIT_TIMEOUT_MS,
  DEFAULT_START_TIMEOUT_MS,
  defaultProcessControl,
  type ProcessControl,
} from "./process.ts";

/**
 * The shared apply pipeline. Every writer goes through it, in this order:
 *
 *  1. in live-install mode (no `dbPath`), refuse any platform without an
 *     install location (macOS and Windows have one). List the running
 *     servers (`locateServers`, failing closed) and take the database in the
 *     configuration root: the running
 *     server's `--config-dir`, else `COMPANION_CONFIG_BASEDIR`, else the
 *     platform default (`resolveConfigRoot`);
 *  2. read and validate the whole description file (no database access);
 *  3. the writer's `resolve`, once (environment values; in live-install mode
 *     what the running Companion knows, so before step 4 quits it); then on
 *     a read-only snapshot copy: the DB version guard and the writer's
 *     own database checks, so a refusal leaves the original files
 *     byte-identical (they are copied, never opened). Companion may still be
 *     running at this point;
 *  4. live-install mode: list the servers again; refuse if one runs on
 *     another configuration root than step 1 chose; if the Companion server
 *     process is running, on Windows refuse unless this process runs in the
 *     launcher's session (a graceful quit reaches only that session) and the
 *     launcher's executable is known, then quit Companion and wait for the
 *     server (and on Windows the launcher) to exit.
 *     With an explicit database path (macOS and Windows, the platforms with
 *     an install database): refuse the install's database while Companion
 *     runs, that is the database in a running server's `--config-dir` (or
 *     in the configured root when a server names none). For the database in
 *     the configured root a failing listing refuses; for any other path it
 *     does not, as step 5 still refuses a database Companion holds open.
 *     Never quit or start Companion;
 *  5. on macOS and Windows, refuse if any other process has the database or
 *     its WAL files open (the in-use guard; it also catches a Companion step
 *     4 does not recognise), then back up the database and its WAL files;
 *  6. in one transaction, under the write lock: repeat the version guard and
 *     the writer's checks, let the writer write, run `pragma integrity_check`;
 *     commit only if it returns `ok`, otherwise roll back so the database
 *     content is unchanged;
 *  7. start Companion again if step 4 quit it, also after a failure in 4
 *     (except a wait timeout), 5 or 6;
 *     Companion's launcher gets this process's environment with
 *     `COMPANION_CONFIG_BASEDIR` set to the root, or removed when the root is
 *     the default (`launchEnvironment`), so it runs on the same root;
 *  8. after a successful write and start, wait for a server to be listed
 *     and check its `--config-dir` is the old root (a mismatch is
 *     `restart_failed`, committed; no server listed in time is a
 *     warning), then run `ApplyOptions.waitForRest` (the CLI waits for
 *     Companion's REST API) and report its outcome.
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
  /**
   * The running Companion servers, when the caller already listed them
   * (`locateServers`). Left out, live-install mode lists them through
   * `processControl` to find the install's configuration root.
   */
  servers?: readonly ServerCommandLine[];
  /** How long to wait for the server process to exit after a quit. */
  quitTimeoutMs?: number;
  /** How long to wait for a server to be listed after the restart. */
  startTimeoutMs?: number;
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
  /**
   * The install's configuration root and the rule that chose it; null with
   * `--db`. A restart starts Companion again on this root.
   */
  root: ConfigRoot | null;
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
  /** The install's configuration root and its rule; null with `--db`. */
  root: ConfigRoot | null;
  /** What located the install's database (home, platform, environment, servers). */
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
  const install = installContext({
    ...options,
    servers: await locateServers(request.dbPath, options),
  });
  const target = resolveDatabaseTarget(request.dbPath, install);
  const { dbPath, live, root } = target;

  const { writer, plan: parsed } = loadDescription(
    request.descriptionPath,
    request.writers,
  );

  assertDatabaseExists(dbPath, describeDatabase(target));

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
    root,
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
  const { platform } = installContext(options);
  const { dbPath, live, root, install, writer, plan, warnings } =
    await prepareApply(request, options);

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
      root,
      restarted: false,
      rest: null,
      warnings,
    };
  };

  if (!live) {
    // macOS and Windows have an install database to protect; on any other
    // platform there is none (`isInstallDatabase` would refuse it).
    if (platform === "darwin" || platform === "win32") {
      // The database in the configured folder (COMPANION_CONFIG_BASEDIR or the
      // default) needs the listing, failing closed, as before. Any other path
      // is the install's database only if a running server's --config-dir
      // holds it; when that listing fails, the in-use check that follows still
      // refuses a database Companion holds open, and itself fails closed.
      const configured = isInstallDatabase(dbPath, { ...install, servers: [] });
      const servers = configured
        ? await runningServers(control)
        : await runningServers(control).catch(() => []);
      if (
        servers.length > 0 &&
        isInstallDatabase(dbPath, { ...install, servers })
      ) {
        throw new CliError(
          `refusing to write the Companion install's database (${dbPath}) while Companion is running; quit Companion or omit --db to let the tool stop and restart it`,
          COMPANION_RUNNING,
        );
      }
    }
    return write();
  }

  if (root === null) {
    throw new Error("live-install mode without a configuration root");
  }
  const servers = await runningServers(control);
  assertSameRoot(servers, root, platform);
  if (servers.length === 0) return write();
  if (platform === "win32") await assertSameSession(control, servers);
  const launch: CompanionLaunch = {
    env: launchEnvironment(install, root.root),
    launcherPath: servers[0]?.launcher?.path ?? null,
  };

  // From here on the tool may have stopped Companion: every exit except a
  // wait timeout starts it again.
  const timeoutMs = options.quitTimeoutMs ?? DEFAULT_QUIT_TIMEOUT_MS;
  options.log?.("quitting Companion");
  let exited: boolean;
  try {
    await control.quit(servers);
    exited = await control.waitForExit(servers, timeoutMs);
  } catch (error) {
    // Nothing is written yet; a start is harmless if Companion still runs
    // (a second launcher only focuses the first and exits).
    return startAfterFailure(
      control,
      launch,
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
    return startAfterFailure(control, launch, options, error);
  }
  options.log?.("starting Companion");
  try {
    await control.start(launch);
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
  const unchecked = await confirmRestartRoot(
    control,
    root,
    platform,
    options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    result.backupDir,
  );
  const rest = (await options.waitForRest?.()) ?? null;
  return {
    ...result,
    restarted: true,
    rest,
    warnings: [...result.warnings, ...unchecked],
  };
}

const SAME_SESSION_HINT =
  "run this from the desktop session that runs Companion";

/**
 * Windows, before the quit: refuses unless this process runs in the session
 * of every server's launcher and each launcher's executable is known.
 * `taskkill` without `/F` closes the launcher's window only from its own
 * session (spike #36), and the restart needs the executable. Nothing has
 * been quit, so nothing is started.
 */
async function assertSameSession(
  control: ProcessControl,
  servers: readonly CompanionServer[],
): Promise<void> {
  const refusal = { ...COMPANION_RUNNING, hint: SAME_SESSION_HINT };
  let own: number | null;
  try {
    own = await control.ownSessionId();
  } catch (error) {
    throw new CliError(
      `cannot tell which Windows session this command runs in (${errorMessage(error)}), so it cannot tell whether Companion can be quit gracefully from here; ${SAME_SESSION_HINT}; nothing quit or written`,
      { ...refusal, cause: error },
    );
  }
  for (const server of servers) {
    const { launcher } = server;
    if (launcher === null || launcher.path === null) {
      throw new CliError(
        `cannot find the launcher of Companion's server (PID ${server.pid}), so the tool could neither quit Companion gracefully nor start it again; ${SAME_SESSION_HINT}; nothing quit or written`,
        refusal,
      );
    }
    if (
      own === null ||
      launcher.sessionId === null ||
      launcher.sessionId !== own
    ) {
      throw new CliError(
        `Companion runs in Windows session ${launcher.sessionId ?? "unknown"} and this command in session ${own ?? "unknown"}: Companion can only be quit gracefully from its own session; ${SAME_SESSION_HINT}; nothing quit or written`,
        refusal,
      );
    }
  }
}

/**
 * After the restart that follows a write: waits for a server to be listed
 * and checks it runs on `root`. A server on another root means Companion now
 * uses another database than the one written: `restart_failed`, committed.
 * When it cannot check (no server listed in time, a failing listing) it
 * returns a warning instead; the write and the start both succeeded.
 */
async function confirmRestartRoot(
  control: ProcessControl,
  root: ConfigRoot,
  platform: NodeJS.Platform,
  timeoutMs: number,
  backupDir: string,
): Promise<string[]> {
  const cannot = (why: string) => [
    `warning: could not confirm Companion started again on the configuration folder ${root.root}: ${why}`,
  ];
  let servers: CompanionServer[];
  try {
    servers = await control.waitForStart(timeoutMs);
  } catch (error) {
    return cannot(`cannot list its processes (${errorMessage(error)})`);
  }
  if (servers.length === 0) {
    return cannot(
      `no Companion server was listed within ${timeoutMs / 1000} seconds`,
    );
  }
  // A server whose command line names no folder (headless, not supported)
  // is not checked, as before the quit (`assertSameRoot`).
  const folders = servers
    .map((server) => configDirOf(server.commandLine, platform))
    .filter((folder) => folder !== null);
  const other = folders.find(
    (folder) => !sameRoot(folder, root.root, platform),
  );
  if (other !== undefined) {
    throw new CliError(
      `the change was written to the configuration folder ${root.root} (backup kept at ${backupDir}), but Companion started again with the configuration folder ${other}, so it does not use the database written`,
      {
        code: "restart_failed",
        hint: `quit Companion and start it on ${root.root} (COMPANION_CONFIG_BASEDIR); the write is committed`,
        committed: true,
        backup: backupDir,
      },
    );
  }
  return [];
}

/**
 * Starts Companion after a failure once the tool quit it, then rethrows the
 * original error, adding the start error if that fails too.
 */
async function startAfterFailure(
  control: ProcessControl,
  launch: CompanionLaunch,
  options: ApplyOptions,
  error: unknown,
): Promise<never> {
  options.log?.("starting Companion");
  try {
    await control.start(launch);
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

/** The running Companion server processes. A failing check refuses the apply (fails closed). */
async function runningServers(
  control: ProcessControl,
): Promise<CompanionServer[]> {
  try {
    return await control.servers();
  } catch (error) {
    throw new CliError(
      `cannot tell whether Companion is running (${errorMessage(error)}); refusing to write`,
      { ...COMPANION_RUNNING, cause: error },
    );
  }
}

/**
 * The running servers that locate the install's database without `--db`
 * (macOS and Windows), listed once up front because the resolver is
 * synchronous: `options.servers` when the caller listed them, none with
 * `--db` or on another platform (the resolver needs no list there), else the
 * process control's listing. A failing listing refuses (fails closed): the
 * tool never guesses the folder while a server may run on another one.
 */
export async function locateServers(
  dbPath: string | undefined,
  options: {
    platform?: NodeJS.Platform | undefined;
    processControl?: ProcessControl | undefined;
    servers?: readonly ServerCommandLine[] | undefined;
  },
): Promise<readonly ServerCommandLine[] | undefined> {
  if (options.servers !== undefined) return options.servers;
  const platform = options.platform ?? process.platform;
  if (dbPath !== undefined) return undefined;
  if (platform !== "darwin" && platform !== "win32") return [];
  const control = options.processControl ?? defaultProcessControl(platform);
  try {
    return await control.servers();
  } catch (error) {
    throw new CliError(
      `cannot tell whether Companion is running (${errorMessage(error)}), so cannot tell which configuration folder holds the install's database; pass --db with a database path`,
      { code: "companion_running", hint: "pass --db <path>", cause: error },
    );
  }
}

/**
 * Live-install mode, before the quit: refuses when a server now running uses
 * another configuration root than the resolved one (one started since the
 * root was resolved, or with a different `COMPANION_CONFIG_BASEDIR`), so the
 * tool never writes a database the running Companion does not use.
 */
function assertSameRoot(
  servers: readonly CompanionServer[],
  root: ConfigRoot,
  platform: NodeJS.Platform,
): void {
  for (const server of servers) {
    const serverRoot = configDirOf(server.commandLine, platform);
    if (serverRoot !== null && !sameRoot(serverRoot, root.root, platform)) {
      throw new CliError(
        `Companion is running with the configuration folder ${serverRoot}, not ${root.root}; nothing written`,
        {
          ...COMPANION_RUNNING,
          hint: "quit Companion and retry, or pass --db <path>",
        },
      );
    }
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
