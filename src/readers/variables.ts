/**
 * `list variables`: the `custom_variables` rows, ordered by `sortOrder`, then
 * name. A row whose value is not a JSON object is not a variable Companion
 * can load and is skipped. `defaultValue` is shown as stored: for a persisted
 * variable it is Companion's current value (docs/companion-internals.md).
 * `currentValue` comes from the running Companion (./current-values.ts).
 */
import type { DatabaseSync } from "node:sqlite";
import { parseStoredJson } from "../core/database.ts";
import { isJsonObject } from "../core/validate.ts";
import { bySortOrderThen, type Lister, yesNo } from "./list.ts";

export interface ListedVariable {
  name: string;
  /** The stored `defaultValue`; `null` when the row has none. */
  defaultValue: unknown;
  /** The value Companion holds now, as REST returns it; `null` when not read. */
  currentValue: string | null;
  persistCurrentValue: boolean;
  description: string;
  sortOrder: number | null;
}

function readVariables(db: DatabaseSync): ListedVariable[] {
  const variables: ListedVariable[] = [];
  for (const row of db
    .prepare("SELECT id, value FROM custom_variables")
    .all()) {
    const value = parseStoredJson(row["value"]);
    if (!isJsonObject(value)) continue;
    const { defaultValue, persistCurrentValue, description, sortOrder } = value;
    variables.push({
      name: String(row["id"]),
      defaultValue: defaultValue ?? null,
      currentValue: null,
      persistCurrentValue: persistCurrentValue === true,
      description: typeof description === "string" ? description : "",
      sortOrder: typeof sortOrder === "number" ? sortOrder : null,
    });
  }
  return variables.sort(
    bySortOrderThen(
      (variable) => variable.sortOrder ?? undefined,
      (variable) => variable.name,
    ),
  );
}

export const variablesLister: Lister<ListedVariable> = {
  kind: "variables",
  read: readVariables,
  name: (variable) => variable.name,
  columns: [
    { header: "NAME", cell: (variable) => variable.name },
    {
      header: "DEFAULT",
      cell: (variable) => JSON.stringify(variable.defaultValue),
    },
    {
      header: "CURRENT",
      cell: (variable) =>
        variable.currentValue === null
          ? "-"
          : JSON.stringify(variable.currentValue),
    },
    {
      header: "PERSIST",
      cell: (variable) => yesNo(variable.persistCurrentValue),
    },
    { header: "DESCRIPTION", cell: (variable) => variable.description },
  ],
  json: (variable) => ({
    name: variable.name,
    defaultValue: variable.defaultValue,
    currentValue: variable.currentValue,
    persistCurrentValue: variable.persistCurrentValue,
    description: variable.description,
    sortOrder: variable.sortOrder,
  }),
};
