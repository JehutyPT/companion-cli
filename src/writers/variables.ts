import type { DatabaseSync } from "node:sqlite";
import { parseStoredJson } from "../core/database.ts";
import { ValidationError } from "../core/errors.ts";
import {
  describeType,
  expectBoolean,
  expectList,
  expectMapping,
  expectString,
  fieldPath,
  type Fields,
  rejectUnknownFields,
  requireField,
} from "../core/validate.ts";
import type { Writer } from "../core/writer.ts";
import { nextSortOrder, parseVariableName, plural } from "./shared.ts";

/**
 * Variable writer: creates or replaces custom variables.
 *
 *   kind: variables
 *   variables:
 *     - name: sk_presses        # required
 *       default: 0              # required: string, number or boolean
 *       description: Presses    # optional, defaults to Companion's "A custom variable"
 *       persist: false          # optional persist-on-restart flag, defaults to false
 *
 * Each named variable's `custom_variables` row becomes
 * `{description, defaultValue, persistCurrentValue, sortOrder}`. An existing
 * variable keeps its sortOrder; new ones are appended after the current
 * maximum in file order. Other variables are never touched.
 *
 * With `persistCurrentValue: true`, Companion stores the variable's current
 * value in `defaultValue`. So when an existing row is already persisted and
 * the file keeps `persist: true`, its stored `defaultValue` is kept; every
 * other case (new variable, `persist: false`, or switching persist on) takes
 * `default` from the file.
 */

export type VariableValue = string | number | boolean;

export interface CustomVariable {
  name: string;
  defaultValue: VariableValue;
  description: string;
  persistCurrentValue: boolean;
}

/** What Companion 5.1 itself writes as the description of a new variable. */
export const DEFAULT_DESCRIPTION = "A custom variable";

export const TOP_LEVEL_FIELDS = ["variables"] as const;
export const VARIABLE_FIELDS = [
  "name",
  "default",
  "description",
  "persist",
] as const;

function parseDefault(value: unknown, field: string): VariableValue {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new ValidationError(
    field,
    `must be a string, number or boolean, got ${describeType(value)}`,
  );
}

export function parseVariables(fields: Fields): CustomVariable[] {
  rejectUnknownFields(fields, TOP_LEVEL_FIELDS, "");
  const list = expectList(requireField(fields, "variables", ""), "variables");
  if (list.length === 0)
    throw new ValidationError("variables", "must list at least one variable");

  const seen = new Map<string, string>();
  return list.map((item, index) => {
    const path = fieldPath("variables", index);
    const entry = expectMapping(item, path);
    rejectUnknownFields(entry, VARIABLE_FIELDS, path);
    const name = parseVariableName(
      requireField(entry, "name", path),
      fieldPath(path, "name"),
    );
    const first = seen.get(name);
    if (first)
      throw new ValidationError(
        fieldPath(path, "name"),
        `duplicate variable name "${name}" (also at ${first})`,
      );
    seen.set(name, path);
    return {
      name,
      defaultValue: parseDefault(
        requireField(entry, "default", path),
        fieldPath(path, "default"),
      ),
      description: Object.hasOwn(entry, "description")
        ? expectString(entry["description"], fieldPath(path, "description"))
        : DEFAULT_DESCRIPTION,
      persistCurrentValue: Object.hasOwn(entry, "persist")
        ? expectBoolean(entry["persist"], fieldPath(path, "persist"))
        : false,
    };
  });
}

/** What the writer needs from an existing `custom_variables` row. */
interface StoredVariable {
  sortOrder: number | undefined;
  /** The stored `defaultValue`, when the row is persisted and has one. */
  persistedValue: { value: unknown } | undefined;
}

/** Reads a stored row's JSON, tolerating Companion's NUMERIC-affinity `value` column. */
function readStored(value: unknown): StoredVariable {
  const parsed = parseStoredJson(value);
  if (!parsed || typeof parsed !== "object") {
    return { sortOrder: undefined, persistedValue: undefined };
  }
  const row = parsed as Record<string, unknown>;
  const sortOrder = row["sortOrder"];
  return {
    sortOrder: typeof sortOrder === "number" ? sortOrder : undefined,
    persistedValue:
      row["persistCurrentValue"] === true && Object.hasOwn(row, "defaultValue")
        ? { value: row["defaultValue"] }
        : undefined,
  };
}

export function writeVariables(
  db: DatabaseSync,
  variables: CustomVariable[],
): string {
  const existing = new Map<string, StoredVariable>();
  for (const row of db
    .prepare("SELECT id, value FROM custom_variables")
    .all()) {
    existing.set(String(row["id"]), readStored(row["value"]));
  }
  const orders = [...existing.values()]
    .map((stored) => stored.sortOrder)
    .filter((order): order is number => order !== undefined);
  let next = nextSortOrder(orders);

  const update = db.prepare(
    "UPDATE custom_variables SET value = ? WHERE id = ?",
  );
  const insert = db.prepare(
    "INSERT INTO custom_variables (id, value) VALUES (?, ?)",
  );
  let created = 0;
  let replaced = 0;
  for (const variable of variables) {
    const stored = existing.get(variable.name);
    // Already persisted and staying persisted: keep Companion's current value.
    const kept = variable.persistCurrentValue
      ? stored?.persistedValue
      : undefined;
    const value = JSON.stringify({
      description: variable.description,
      defaultValue: kept ? kept.value : variable.defaultValue,
      persistCurrentValue: variable.persistCurrentValue,
      sortOrder: stored?.sortOrder ?? next++,
    });
    if (stored) {
      update.run(value, variable.name);
      replaced++;
    } else {
      insert.run(variable.name, value);
      created++;
    }
  }
  return `custom variables: ${created} created, ${replaced} replaced`;
}

export const variablesWriter: Writer<CustomVariable[]> = {
  kind: "variables",
  parse: parseVariables,
  describe: (plan) => plural(plan.length, "custom variable"),
  write: writeVariables,
};
