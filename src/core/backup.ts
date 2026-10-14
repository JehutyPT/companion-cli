import { constants, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CliError, errorMessage } from "./errors.ts";
import { copyDatabaseFiles } from "./database.ts";

/** Default backup root: a `companion-cli-backups` directory next to the database. */
export function defaultBackupRoot(dbPath: string): string {
  return join(dirname(dbPath), "companion-cli-backups");
}

/** `2026-10-14T12:34:56.789Z` -> `20261014T123456789Z`: sortable and safe in file names. */
function timestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

/**
 * Copies the database and any `-wal` / `-shm` files into a new timestamped
 * directory under `root` and returns that directory. Nothing may have the
 * database open while this runs.
 */
export function backupDatabase(
  dbPath: string,
  root: string,
  now: Date,
): string {
  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    throw new CliError(
      `cannot create backup directory ${root}: ${errorMessage(error)}`,
    );
  }
  const stem = join(root, timestamp(now));
  let dir = stem;
  for (let n = 2; ; n++) {
    try {
      mkdirSync(dir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new CliError(
          `cannot create backup directory ${dir}: ${errorMessage(error)}`,
        );
      }
      dir = `${stem}-${n}`;
    }
  }
  try {
    copyDatabaseFiles(
      dbPath,
      join(dir, basename(dbPath)),
      constants.COPYFILE_EXCL,
    );
  } catch (error) {
    throw new CliError(
      `cannot back up ${dbPath} to ${dir}: ${errorMessage(error)}`,
    );
  }
  return dir;
}
