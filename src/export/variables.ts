/**
 * `export variables [<pattern>...]`: custom variables as one `kind: variables`
 * file, in `sortOrder`, then name order. Each entry emits all four fields;
 * `default` is the stored `defaultValue`, which for a persisted variable is
 * Companion's current value (the writer keeps it on apply).
 */
import type { DatabaseSync } from "node:sqlite";
import { parseStoredJson } from "../core/database.ts";
import { type Fields, isJsonObject } from "../core/validate.ts";
import { bySortOrderThen } from "../readers/list.ts";
import {
  buildVariableRow,
  parseVariables,
  readStored,
} from "../writers/variables.ts";
import {
  describeStored,
  type Exporter,
  refuse,
  selectByPatterns,
  selfCheck,
} from "./export.ts";

interface StoredRow {
  name: string;
  /** The raw `value` column. */
  raw: unknown;
  value: unknown;
}

function readRows(db: DatabaseSync): StoredRow[] {
  return db
    .prepare("SELECT id, value FROM custom_variables")
    .all()
    .map((row) => ({
      name: String(row["id"]),
      raw: row["value"],
      value: parseStoredJson(row["value"]),
    }))
    .sort(
      bySortOrderThen(
        (row) => {
          const order = isJsonObject(row.value)
            ? row.value["sortOrder"]
            : undefined;
          return typeof order === "number" ? order : undefined;
        },
        (row) => row.name,
      ),
    );
}

/** The `variables[0].<field>` path of a one-entry file, as a stored path. */
const STORED_FIELDS: Record<string, string> = {
  name: "id",
  default: "defaultValue",
  description: "description",
  persist: "persistCurrentValue",
};

function entry(_db: DatabaseSync, row: StoredRow): Fields {
  const stored = row.value;
  if (!isJsonObject(stored))
    refuse(
      "value",
      `is ${describeStored(stored)}, not a JSON object`,
      "custom variable",
    );
  const { defaultValue, description, persistCurrentValue, sortOrder } = stored;
  if (typeof sortOrder !== "number" || !Number.isSafeInteger(sortOrder))
    refuse(
      "sortOrder",
      `is ${typeof sortOrder === "number" ? sortOrder : describeStored(sortOrder)}, not an integer`,
      "custom variable",
    );
  const isValue =
    typeof defaultValue === "string" ||
    typeof defaultValue === "boolean" ||
    (typeof defaultValue === "number" && Number.isFinite(defaultValue));
  if (!isValue)
    refuse(
      "defaultValue",
      `is ${describeStored(defaultValue)}; only a string, number or boolean can be exported`,
      "custom variable",
    );
  const described: Fields = {
    name: row.name,
    default: defaultValue,
    description,
    persist: persistCurrentValue,
  };
  selfCheck({
    stored,
    parse: () => {
      const [variable] = parseVariables({ variables: [described] });
      if (!variable) throw new Error("no variable parsed");
      return variable;
    },
    build: (variable) =>
      buildVariableRow(variable, readStored(row.raw), () => sortOrder),
    storedPath: (field) =>
      STORED_FIELDS[field.replace(/^variables\[0\]\./, "")] ?? field,
    area: () => "custom variable",
  });
  return described;
}

export const variablesExporter: Exporter<StoredRow> = {
  kind: "variables",
  arguments: "[<pattern>...]",
  noun: "custom variables",
  select: (db, patterns) =>
    selectByPatterns(readRows(db), patterns, (row) => row.name, {
      one: "custom variable",
      many: "custom variables",
    }),
  name: (row) => row.name,
  label: (row) => `custom variable ${JSON.stringify(row.name)}`,
  entry,
  file: (entries) => ({ kind: "variables", variables: entries }),
};
