/**
 * The shared read path. Every read command (list, find, export, validate,
 * the census) goes through it with its own reader:
 *
 *  1. resolve the target: `--db` with `~` expanded or, without it, the
 *     install's database (macOS only);
 *  2. refuse a missing database;
 *  3. copy the database and whichever WAL files exist into a new temporary
 *     directory and open the copy read-only (the target files are copied,
 *     never opened, so they stay byte-identical);
 *  4. run `pragma integrity_check` on the copy;
 *  5. the version guard;
 *  6. run the reader, then delete the temporary directory, on every path.
 *
 * It never calls the process-control seam, so it works while Companion runs,
 * including on the install's database.
 */
import { homedir as osHomedir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import {
  assertSnapshotConsistent,
  assertSupportedVersion,
  withReadOnlySnapshot,
} from "./database.ts";
import { CliError, errorMessage } from "./errors.ts";
import { assertDatabaseExists, resolveDatabaseTarget } from "./paths.ts";

export interface ReadOptions {
  /** Home directory used for `~` and the install path. Defaults to the OS home. */
  homedir?: string;
  /** Platform deciding whether live-install mode is supported. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Directory for the temporary copy. Defaults to the OS temp directory. */
  tmpdir?: string;
}

export interface ReadResult<T> {
  /** The resolved database path. */
  database: string;
  value: T;
}

/** Runs `reader` on a checked read-only snapshot of the target database. */
export function readDatabase<T>(
  requestedPath: string | undefined,
  options: ReadOptions,
  reader: (db: DatabaseSync) => T,
): ReadResult<T> {
  const { dbPath } = resolveDatabaseTarget(
    requestedPath,
    options.homedir ?? osHomedir(),
    options.platform ?? process.platform,
  );
  assertDatabaseExists(dbPath);
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
    return { database: dbPath, value };
  } catch (error) {
    if (error instanceof CliError) throw error;
    // Copying the files failed (permissions, a missing temp directory).
    throw new CliError(
      `cannot read database ${dbPath}: ${errorMessage(error)}`,
      { code: "database_unreadable", cause: error },
    );
  }
}
