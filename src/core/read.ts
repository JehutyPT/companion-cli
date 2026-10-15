/**
 * The shared read path. Every read command (list, find, export, validate,
 * the census) goes through it with its own reader:
 *
 *  1. resolve the target: `--db` with `~` expanded or, without it, the
 *     install's database (macOS and Windows) in the configuration root that
 *     the running servers (`ReadOptions.servers`, listed by the caller),
 *     `COMPANION_CONFIG_BASEDIR` or the platform default give;
 *  2. refuse a missing database;
 *  3. copy the database and its `-wal` if present (never `-shm`) into a new
 *     temporary directory, retrying transient lock errors, and open the copy
 *     read-only (the target files are copied, never opened, so they stay
 *     byte-identical);
 *  4. run `pragma integrity_check` on the copy;
 *  5. the version guard;
 *  6. run the reader, then delete the temporary directory, on every path.
 *
 * It never calls the process-control seam itself (the caller lists the
 * servers up front, read-only) and never quits or starts Companion, so it
 * works while Companion runs, including on the install's database.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  assertSnapshotConsistent,
  assertSupportedVersion,
  withReadOnlySnapshot,
} from "./database.ts";
import { CliError, errorMessage } from "./errors.ts";
import type { Env } from "../rest/endpoint.ts";
import {
  assertDatabaseExists,
  type ConfigRoot,
  describeDatabase,
  installContext,
  resolveDatabaseTarget,
  type ServerCommandLine,
} from "./paths.ts";

export interface ReadOptions {
  /** Home directory used for `~` and the install path. Defaults to the OS home. */
  homedir?: string;
  /** Platform deciding whether live-install mode is supported. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Environment locating the install (`APPDATA` on Windows). Defaults to `process.env`. */
  env?: Env;
  /** Directory for the temporary copy. Defaults to the OS temp directory. */
  tmpdir?: string;
  /**
   * The running Companion servers (`locateServers`), which locate the
   * install's database without `--db`. Required then: the resolver throws
   * without them.
   */
  servers?: readonly ServerCommandLine[] | undefined;
}

export interface ReadResult<T> {
  /** The resolved database path. */
  database: string;
  /** The install's configuration root and its rule; null with `--db`. */
  root: ConfigRoot | null;
  value: T;
}

/** Runs `reader` on a checked read-only snapshot of the target database. */
export function readDatabase<T>(
  requestedPath: string | undefined,
  options: ReadOptions,
  reader: (db: DatabaseSync) => T,
): ReadResult<T> {
  const target = resolveDatabaseTarget(requestedPath, installContext(options));
  const { dbPath, root } = target;
  assertDatabaseExists(dbPath, describeDatabase(target));
  try {
    const value = withReadOnlySnapshot(
      dbPath,
      (db) => {
        assertSnapshotConsistent(db, "read");
        assertSupportedVersion(db);
        return reader(db);
      },
      options.tmpdir,
    );
    return { database: dbPath, root, value };
  } catch (error) {
    if (error instanceof CliError) throw error;
    // Copying the files failed (permissions, a missing temp directory).
    throw new CliError(
      `cannot read database ${dbPath}: ${errorMessage(error)}`,
      { code: "database_unreadable", cause: error },
    );
  }
}
