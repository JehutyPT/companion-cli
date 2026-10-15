import { type ApplyOptions, type ApplyRequest, prepareApply } from "./apply.ts";
import {
  assertSnapshotConsistent,
  checkWriteVerify,
  withDatabaseCopy,
  WriteFailure,
} from "./database.ts";
import { CliError } from "./errors.ts";
import {
  type DatabaseDiff,
  type DatabaseRows,
  diffTables,
  readTables,
} from "./table-diff.ts";

/**
 * The dry run: what `apply` would change, without writing.
 *
 *  1. the same checks as `apply` steps 1 to 3 (`prepareApply`), so every
 *     refusal has the same message. Process-state checks are not repeated;
 *  2. copy the database and its `-wal` if present (never `-shm`) into a new
 *     temporary directory (the target files are copied, never opened);
 *  3. open the copy for writing and run `pragma integrity_check` on it;
 *  4. in one transaction: the version guard and the writer's checks, read
 *     every table, let the writer write, run `pragma integrity_check`, read
 *     every table again, roll back;
 *  5. close the copy and delete the temporary directory, on every path.
 *
 * It never opens the target for writing, never takes a backup and never
 * calls the process-control seam, so Companion is never quit, waited on or
 * started. The report comes from comparing the two reads, so writers need no
 * dry-run code of their own.
 */

export interface DryRunResult {
  /** The resolved database path. */
  database: string;
  diff: DatabaseDiff;
  /** The report's table sections, or `no changes`. */
  lines: string[];
  /** The writer's one-line summary: what `apply` would print. */
  summary: string;
  /** The writer's warnings (settings `--unchecked` let through unchecked). */
  warnings: string[];
}

export async function dryRun(
  request: ApplyRequest,
  options: ApplyOptions = {},
): Promise<DryRunResult> {
  const { dbPath, writer, plan, warnings } = await prepareApply(
    request,
    options,
  );
  const copy = { readOnly: false, tmpdir: options.tmpdir };
  return withDatabaseCopy(dbPath, copy, (db) => {
    assertSnapshotConsistent(db, "dry run");
    db.exec("BEGIN IMMEDIATE");
    try {
      let before: DatabaseRows | undefined;
      const summary = checkWriteVerify(db, writer, plan, options.hooks, () => {
        before = readTables(db);
      });
      const after = readTables(db);
      return {
        database: dbPath,
        ...diffTables(before ?? after, after),
        summary,
        warnings,
      };
    } catch (error) {
      if (error instanceof WriteFailure) {
        throw new CliError(
          `dry run: apply would fail: ${error.message}; nothing written`,
          { code: "write_failed", cause: error.cause },
        );
      }
      throw error;
    } finally {
      // Nothing is committed: the copy is discarded either way.
      if (db.isTransaction) db.exec("ROLLBACK");
    }
  });
}

/** The text report: header, table sections or `no changes`, and the summary. */
export function renderDryRun(result: DryRunResult): string[] {
  return [
    `dry run: nothing written to ${result.database}`,
    ...result.lines,
    `apply would report: ${result.summary}`,
  ];
}

/** The `--json` document. */
export function dryRunJson(result: DryRunResult): string {
  const tables = result.diff.tables;
  return JSON.stringify({
    dryRun: true,
    database: result.database,
    changed: Object.keys(tables).length > 0,
    tables,
    summary: result.summary,
    warnings: result.warnings,
  });
}
