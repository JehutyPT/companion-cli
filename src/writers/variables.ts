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

/**
 * Companion 5.1's own name rule, from `createVariable` in its bundled main.js:
 * a name is valid when replacing `[^\w]` with `_` leaves it unchanged (that is,
 * non-empty and only ASCII letters, digits and `_`), and it is not one of these
 * reserved object keys.
 */
const VALID_NAME = /^\w+$/;
const RESERVED_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/**
 * Stricter than Companion: the `id` column is declared `STRING`, which SQLite
 * gives NUMERIC affinity, so a name such as `007` or `1e5` is stored as the
 * number 7 or 100000. Those names pass Companion's rule but cannot round-trip.
 */
const NUMERIC_NAME = /^\d+(?:[eE]\d+)?$/;

const TOP_LEVEL_FIELDS = ["variables"] as const;
const VARIABLE_FIELDS = ["name", "default", "description", "persist"] as const;

function parseName(value: unknown, field: string): string {
  const name = expectString(value, field);
  if (!VALID_NAME.test(name)) {
    throw new ValidationError(
      field,
      `invalid variable name "${name}": use only letters A-Z/a-z, digits and _ (Companion's rule for $(custom:<name>))`,
    );
  }
  if (RESERVED_NAMES.has(name)) {
    throw new ValidationError(
      field,
      `variable name "${name}" is reserved by Companion`,
    );
  }
  if (NUMERIC_NAME.test(name)) {
    throw new ValidationError(
      field,
      `variable name "${name}" looks like a number; Companion's database would store it as ${Number(name)} and lose the name`,
    );
  }
  return name;
}

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
    const name = parseName(
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

/** Parses a stored row's JSON, tolerating Companion's NUMERIC-affinity `value` column. */
function storedSortOrder(value: unknown): number | undefined {
  const parsed = parseStoredJson(value);
  if (
    parsed &&
    typeof parsed === "object" &&
    "sortOrder" in parsed &&
    typeof parsed.sortOrder === "number"
  ) {
    return parsed.sortOrder;
  }
  return undefined;
}

export function writeVariables(
  db: DatabaseSync,
  variables: CustomVariable[],
): string {
  const existing = new Map<string, number | undefined>();
  for (const row of db
    .prepare("SELECT id, value FROM custom_variables")
    .all()) {
    existing.set(String(row["id"]), storedSortOrder(row["value"]));
  }
  const orders = [...existing.values()].filter(
    (order): order is number => order !== undefined,
  );
  let next = Math.max(-1, ...orders) + 1;

  const update = db.prepare(
    "UPDATE custom_variables SET value = ? WHERE id = ?",
  );
  const insert = db.prepare(
    "INSERT INTO custom_variables (id, value) VALUES (?, ?)",
  );
  let created = 0;
  let replaced = 0;
  for (const variable of variables) {
    const kept = existing.get(variable.name);
    const value = JSON.stringify({
      description: variable.description,
      defaultValue: variable.defaultValue,
      persistCurrentValue: variable.persistCurrentValue,
      sortOrder: kept ?? next++,
    });
    if (existing.has(variable.name)) {
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
  write: writeVariables,
};
