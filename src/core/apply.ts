import { existsSync, statSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupDatabase, defaultBackupRoot } from "./backup.ts";
import { assertSupportedVersion, withReadOnlySnapshot } from "./database.ts";
import { loadDescription, type WriterRegistry } from "./description.ts";
import { CliError, errorMessage, UnsupportedVersionError } from "./errors.ts";
import { expandHome, isDefaultInstallDatabase } from "./paths.ts";

/**
 * The shared apply pipeline. Every writer goes through it, in this order:
 *
 *  1. refuse the install's default database (until live-install mode lands);
 *  2. read and validate the whole description file (no database access);
 *  3. on a read-only snapshot copy: the DB version guard and the writer's
 *     own database checks, so a refusal leaves the original files
 *     byte-identical (they are copied, never opened);
 *  4. back up the database and its WAL files;
 *  5. in one transaction, under the write lock: repeat the version guard and
 *     the writer's checks, let the writer write, run `pragma integrity_check`;
 *     commit only if it returns `ok`, otherwise roll back so the database
 *     content is unchanged.
 *
 * It does not stop or restart Companion: the caller must ensure Companion is
 * not running. Live-install mode will add that around this pipeline.
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
  /** Home directory used for `~` and the default install path. Defaults to the OS home. */
  homedir?: string;
  /** Directory that receives timestamped backups. Defaults to `companion-cli-backups` next to the database. */
  backupRoot?: string;
  /** Clock for the backup directory name. */
  now?: () => Date;
  /** Progress lines (the backup path) as they happen, before the write. */
  log?: (line: string) => void;
  hooks?: ApplyHooks;
}

export interface ApplyRequest {
  descriptionPath: string;
  dbPath: string;
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

export function apply(
  request: ApplyRequest,
  options: ApplyOptions = {},
): ApplyResult {
  const home = options.homedir ?? osHomedir();
  const dbPath = resolve(expandHome(request.dbPath, home));

  if (isDefaultInstallDatabase(dbPath, home)) {
    throw new CliError(
      `refusing to write the Companion install's default database (${dbPath}); work on a copy until live-install mode exists`,
    );
  }

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
