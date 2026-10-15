import type { DatabaseSync } from "node:sqlite";
import type { Env } from "../rest/endpoint.ts";
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
  "triggers",
  "connection",
] as const;
export type DescriptionKind = (typeof DESCRIPTION_KINDS)[number];

/** A field definition of a connection's module, as REST API v2 returns it. */
export type ConfigField = Readonly<Record<string, unknown>> & {
  readonly id: string;
  readonly type: string;
};

/**
 * What asking the running Companion for a connection's config fields gave:
 * the fields, or why there are none (not configured, not reachable, the
 * connection not running, refused).
 */
export type ConfigFieldsOutcome =
  | { available: true; fields: readonly ConfigField[] }
  | { available: false; reason: string };

/**
 * What a writer's `resolve` may use, once per apply, dry run or validate,
 * before the database checks.
 */
export interface WriterContext {
  /** Live-install mode: the install's database, no `--db`. */
  readonly live: boolean;
  /** `--unchecked`: accept settings no definition can check, with a warning. */
  readonly unchecked: boolean;
  /** The environment, for values a description takes from it. */
  readonly env: Env;
  /** Runs `reader` on a read-only snapshot, after the version guard. */
  read<T>(reader: (db: DatabaseSync) => T): T;
  /**
   * The connection's config fields from the running Companion (REST API v2).
   * Outside live-install mode, unavailable without a request. Never throws.
   */
  configFields(connectionId: string): Promise<ConfigFieldsOutcome>;
  /** A warning for stderr and the JSON documents' `warnings`. */
  warn(line: string): void;
}

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
   * Optional: completes the plan with what the description takes from
   * outside the file (environment variables, the running Companion). Runs
   * once, after `parse` and before `check`, which then stays pure because
   * `check` runs twice (on the snapshot and under the write lock, after
   * Companion is quit). Throws CliError to refuse; never prints secrets.
   */
  resolve?(plan: Plan, context: WriterContext): Promise<Plan>;

  /**
   * Optional checks against the database, for example locations against the
   * grid size. `db` is a read-only snapshot. Throws CliError to refuse.
   */
  check?(db: DatabaseSync, plan: Plan): void;

  /**
   * What the description describes, for `validate`'s success line, for
   * example `page 99 "SKAARHOJ TEST" (47 buttons)`. Defaults to the kind.
   */
  describe?(plan: Plan): string;

  /**
   * Writes the plan inside the pipeline's open transaction. Must replace only
   * the rows the description names. Returns a one-line summary.
   */
  write(db: DatabaseSync, plan: Plan): string;
}
