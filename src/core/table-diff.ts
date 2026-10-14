import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { parseStoredJson } from "./database.ts";
import {
  equalButGeneratedIds,
  pageCells,
  pairRenamedControls,
  renameCells,
} from "./generated-ids.ts";

/**
 * Reads every table of a database and compares two such reads: the dry run's
 * report. The diff is generic (every table, every row) except for two
 * Companion shapes the core owns: generated ids are not changes (ADR 0005,
 * src/core/generated-ids.ts), and `pages` rows render as the cells they
 * change.
 */

/**
 * One stored row: `raw` is its exact stored content, `value` its readable
 * form. `json` marks a key/value table's row, whose `value` is the stored
 * JSON parsed.
 */
interface StoredRow {
  raw: string;
  value: unknown;
  json: boolean;
}

/** A table's rows by key: the `id` column, or the `rowid` for other tables. */
type TableRows = Map<string, StoredRow>;

/** Every table's rows, by table name. */
export type DatabaseRows = Map<string, TableRows>;

export interface RowChange {
  key: string;
  before?: unknown;
  after?: unknown;
}

export interface TableChanges {
  added: RowChange[];
  changed: RowChange[];
  removed: RowChange[];
}

export interface DatabaseDiff {
  /** Tables with at least one change, in name order. */
  tables: Record<string, TableChanges>;
}

/** A diff and its text sections (or `no changes`). */
export interface DiffReport {
  diff: DatabaseDiff;
  lines: string[];
}

/** Exact stored content, with its SQLite type, so `"1"` and `1` differ. */
function rawCell(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Uint8Array)
    return `blob:${Buffer.from(value).toString("hex")}`;
  return `${typeof value}:${String(value)}`;
}

function readableCell(value: unknown): unknown {
  return value instanceof Uint8Array
    ? Buffer.from(value).toString("hex")
    : value;
}

function quoteName(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Every table's rows, `sqlite_%` tables excluded. A table with `id` and
 * `value` columns (Companion's key/value tables) is keyed by `id` as a string,
 * and its value is the stored `value` parsed as JSON as the pipeline reads it.
 * Any other table is keyed by `rowid`, and a value maps each column to its
 * stored value.
 */
export function readTables(db: DatabaseSync): DatabaseRows {
  const tables: DatabaseRows = new Map();
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all()
    .map((row) => String(row["name"]));
  for (const name of names) {
    const table = quoteName(name);
    const columns = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row["name"]));
    const rows: TableRows = new Map();
    if (columns.includes("id") && columns.includes("value")) {
      for (const row of db.prepare(`SELECT id, value FROM ${table}`).all()) {
        rows.set(String(row["id"]), {
          raw: rawCell(row["value"]),
          value: parseStoredJson(row["value"]),
          json: true,
        });
      }
    } else {
      const list = columns.map(quoteName).join(", ");
      for (const row of db
        .prepare(`SELECT rowid AS "rowid", ${list} FROM ${table}`)
        .all()) {
        const value = Object.fromEntries(
          columns.map((column) => [column, readableCell(row[column])]),
        );
        rows.set(String(row["rowid"]), {
          raw: JSON.stringify(columns.map((column) => rawCell(row[column]))),
          value,
          json: false,
        });
      }
    }
    tables.set(name, rows);
  }
  return tables;
}

/** Keys in id order: whole numbers numerically (pages), anything else by code unit. */
export function compareKeys(a: string, b: string): number {
  const integer = /^-?\d+$/;
  if (integer.test(a) && integer.test(b)) {
    const difference = Number(a) - Number(b);
    if (difference !== 0) return difference;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Whether a row present before and after is unchanged: its stored content is
 * identical; or, in a key/value table, the stored JSON parses to the same
 * value (whitespace and key order are not changes). `controls` are compared
 * with generated ids masked, and `pages` with renamed controls' cells under
 * their new ids.
 */
function unchanged(
  table: string,
  before: StoredRow,
  after: StoredRow,
  renamed: ReadonlyMap<string, string>,
): boolean {
  if (before.raw === after.raw) return true;
  if (!before.json || !after.json) return false;
  if (table === "controls") {
    return equalButGeneratedIds(before.value, after.value);
  }
  if (table === "pages") {
    return isDeepStrictEqual(renameCells(before.value, renamed), after.value);
  }
  return isDeepStrictEqual(before.value, after.value);
}

/** The rows a write added, changed and removed, per table, and the text report. */
export function diffTables(
  before: DatabaseRows,
  after: DatabaseRows,
): DiffReport {
  const renamed = pairRenamedControls(before, after);
  const tables: Record<string, TableChanges> = {};
  const names = [...new Set([...before.keys(), ...after.keys()])].sort(
    compareKeys,
  );
  for (const name of names) {
    const rowsBefore = new Map(before.get(name) ?? []);
    if (name === "controls") {
      // Compare a renamed control under its new id.
      for (const [oldId, newId] of renamed) {
        const row = rowsBefore.get(oldId);
        rowsBefore.delete(oldId);
        if (row) rowsBefore.set(newId, row);
      }
    }
    const rowsAfter = after.get(name) ?? new Map<string, StoredRow>();
    const changes: TableChanges = { added: [], changed: [], removed: [] };
    const keys = [...new Set([...rowsBefore.keys(), ...rowsAfter.keys()])].sort(
      compareKeys,
    );
    for (const key of keys) {
      const was = rowsBefore.get(key);
      const is = rowsAfter.get(key);
      if (was === undefined && is !== undefined) {
        changes.added.push({ key, after: is.value });
      } else if (was !== undefined && is === undefined) {
        changes.removed.push({ key, before: was.value });
      } else if (
        was !== undefined &&
        is !== undefined &&
        !unchanged(name, was, is, renamed)
      ) {
        changes.changed.push({ key, before: was.value, after: is.value });
      }
    }
    if (
      changes.added.length + changes.changed.length + changes.removed.length >
      0
    ) {
      tables[name] = changes;
    }
  }
  return { diff: { tables }, lines: renderTables(tables, renamed) };
}

function cellText(value: unknown): string {
  if (value === undefined || value === null) return "-";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function nameText(value: unknown): string {
  return isObject(value) && value["name"] !== undefined
    ? JSON.stringify(value["name"])
    : "-";
}

function compareCells(a: string, b: string): number {
  const [rowA = "", columnA = ""] = a.split("/");
  const [rowB = "", columnB = ""] = b.split("/");
  return compareKeys(rowA, rowB) || compareKeys(columnA, columnB);
}

/** `name "…"` and every filled cell of an added page. */
function addedPageDetail(value: unknown): string[] {
  const parts = [`name ${nameText(value)}`];
  const cells = pageCells(value);
  for (const cell of [...cells.keys()].sort(compareCells)) {
    parts.push(`cell ${cell} ${cellText(cells.get(cell))}`);
  }
  return parts;
}

/** The name change and every changed cell of a replaced page. */
function changedPageDetail(
  before: unknown,
  after: unknown,
  renamed: ReadonlyMap<string, string>,
): string[] {
  const parts: string[] = [];
  const nameBefore = nameText(before);
  const nameAfter = nameText(after);
  if (nameBefore !== nameAfter)
    parts.push(`name ${nameBefore} -> ${nameAfter}`);
  const cellsBefore = pageCells(before);
  const comparable = pageCells(renameCells(before, renamed));
  const cellsAfter = pageCells(after);
  const cells = [
    ...new Set([...cellsBefore.keys(), ...cellsAfter.keys()]),
  ].sort(compareCells);
  for (const cell of cells) {
    if (isDeepStrictEqual(comparable.get(cell), cellsAfter.get(cell))) continue;
    parts.push(
      `cell ${cell} ${cellText(cellsBefore.get(cell))} -> ${cellText(cellsAfter.get(cell))}`,
    );
  }
  return parts;
}

function line(mark: string, key: string, detail: string[]): string {
  return detail.length > 0
    ? `  ${mark} ${key}: ${detail.join(", ")}`
    : `  ${mark} ${key}`;
}

/** The report's table sections, or `no changes`. */
function renderTables(
  tables: Record<string, TableChanges>,
  renamed: ReadonlyMap<string, string>,
): string[] {
  const lines: string[] = [];
  for (const [name, changes] of Object.entries(tables)) {
    const pages = name === "pages";
    lines.push(
      `${name}: ${changes.added.length} added, ${changes.changed.length} replaced, ${changes.removed.length} removed`,
    );
    for (const row of changes.added) {
      lines.push(line("+", row.key, pages ? addedPageDetail(row.after) : []));
    }
    for (const row of changes.changed) {
      lines.push(
        line(
          "~",
          row.key,
          pages ? changedPageDetail(row.before, row.after, renamed) : [],
        ),
      );
    }
    for (const row of changes.removed) lines.push(line("-", row.key, []));
  }
  return lines.length > 0 ? lines : ["no changes"];
}
