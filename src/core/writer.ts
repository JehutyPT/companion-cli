import type { DatabaseSync } from "node:sqlite";
import type { Fields } from "./validate.ts";

/**
 * Every kind a description file may declare. Only kinds with a registered
 * writer can be applied; the others are reserved for later writers.
 */
export const DESCRIPTION_KINDS = [
  "variables",
  "button",
  "page",
  "trigger",
] as const;
export type DescriptionKind = (typeof DESCRIPTION_KINDS)[number];

/**
 * A writer turns one kind of description into database rows. It plugs into
 * the shared apply pipeline (src/core/apply.ts), which owns validation order,
 * the version guard, the backup, the transaction, the integrity check and the
 * rollback. A writer never opens, commits or rolls back the database itself.
 */
export interface Writer<Plan = unknown> {
  readonly kind: DescriptionKind;

  /**
   * Validates the description's fields other than `kind` and returns a plan.
   * Must reject unknown fields. Throws ValidationError naming the field.
   * Runs before the database is touched.
   */
  parse(fields: Fields): Plan;

  /**
   * Optional checks against the database, for example locations against the
   * grid size. `db` is a read-only snapshot. Throws CliError to refuse.
   */
  check?(db: DatabaseSync, plan: Plan): void;

  /**
   * Writes the plan inside the pipeline's open transaction. Must replace only
   * the rows the description names. Returns a one-line summary.
   */
  write(db: DatabaseSync, plan: Plan): string;
}
