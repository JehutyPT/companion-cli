import { homedir as osHomedir } from "node:os";
import { loadDescription, type WriterRegistry } from "./description.ts";
import { resolveDatabaseTarget } from "./paths.ts";
import { type ReadOptions, readDatabase } from "./read.ts";
import { resolvePlan, type WriterRuntime } from "./resolve.ts";

/**
 * `validate`: the checks `apply` runs before it writes, and nothing else.
 *
 * Without `noDb`, the order is `prepareApply`'s (src/core/apply.ts), so every
 * refusal is the same error the dry run throws: the platform guard, the
 * description, the writer's `resolve` (environment values and, without
 * `--db`, the running Companion's definitions), then the read path
 * (src/core/read.ts) with the writer's `check` as its reader. The read path adds the snapshot integrity check
 * before the version guard. With `noDb`, only the description is read: no
 * database is located or opened, and `resolve` does not run (it needs the
 * database), so neither environment values nor definitions are checked.
 *
 * It never runs a writer's `write`, never takes a backup and never calls the
 * process-control seam.
 */

export interface ValidateRequest {
  descriptionPath: string;
  /** `--db`. Omitted: the local install's database. */
  dbPath?: string | undefined;
  /** `--no-db`: the description file only. */
  noDb: boolean;
  writers: WriterRegistry;
  /** `--unchecked`: settings no definition can check are accepted with a warning. */
  unchecked?: boolean;
}

export interface ValidateOptions extends ReadOptions, WriterRuntime {}

export interface ValidateResult {
  kind: string;
  file: string;
  /** The resolved database path, or null with `noDb`. */
  database: string | null;
  /** What the file describes, for example `page 99 "MAIN" (2 buttons)`. */
  described: string;
  /** The writer's warnings (settings `--unchecked` let through unchecked). */
  warnings: string[];
}

export async function validate(
  request: ValidateRequest,
  options: ValidateOptions = {},
): Promise<ValidateResult> {
  let live = false;
  if (!request.noDb) {
    // The platform guard first, as in `prepareApply`.
    ({ live } = resolveDatabaseTarget(
      request.dbPath,
      options.homedir ?? osHomedir(),
      options.platform ?? process.platform,
    ));
  }
  const { writer, plan: parsed } = loadDescription(
    request.descriptionPath,
    request.writers,
  );
  const result: ValidateResult = {
    kind: writer.kind,
    file: request.descriptionPath,
    database: null,
    described: writer.describe?.(parsed) ?? writer.kind,
    warnings: [],
  };
  if (request.noDb) return result;
  const { plan, warnings } = await resolvePlan(writer, parsed, {
    live,
    unchecked: request.unchecked ?? false,
    runtime: options,
    read: (reader) => readDatabase(request.dbPath, options, reader).value,
  });
  // The read path reports any non-CliError as an unreadable database; a
  // writer check's own error is rethrown as it is, as the dry run would.
  let checkError: unknown;
  try {
    const { database } = readDatabase(request.dbPath, options, (db) => {
      try {
        writer.check?.(db, plan);
      } catch (error) {
        checkError = error;
        throw error;
      }
    });
    return { ...result, database, warnings };
  } catch (error) {
    throw checkError ?? error;
  }
}

/** The success line. */
export function renderValidation(result: ValidateResult): string {
  return result.database === null
    ? `valid: ${result.described} (structure only; not checked against a database)`
    : `valid: ${result.described} against ${result.database}`;
}

/** The `--json` document. */
export function validationJson(result: ValidateResult): string {
  return JSON.stringify({
    valid: true,
    kind: result.kind,
    file: result.file,
    database: result.database,
    checks: result.database === null ? "structure" : "database",
    warnings: result.warnings,
  });
}
