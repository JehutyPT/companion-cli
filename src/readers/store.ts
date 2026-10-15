/**
 * Stored pages and controls as Companion 5.1 loads them, for the readers.
 * Pages load contiguously ("1", "2", … up to the first missing or non-object
 * row, `loadedPageCount`); a page's cells are `controls[row][column]` with
 * string keys, each holding a control id of any type (`bank:` ids, including
 * Companion's navigation buttons).
 */
import type { DatabaseSync } from "node:sqlite";
import { parseStoredJson } from "../core/database.ts";
import { type Fields, isJsonObject } from "../core/validate.ts";
import { loadedPageCount, readPageRows } from "../writers/shared.ts";

export interface StoredCell {
  row: number;
  column: number;
  controlId: string;
}

export interface LoadedPage {
  /** The page number. */
  page: number;
  /** The stored page row. */
  value: Fields;
  /** Cells holding a control id, in row, then column order. */
  cells: StoredCell[];
}

export interface PageStore {
  pages: LoadedPage[];
  /** Keys of numeric `pages` rows Companion does not load, in number order. */
  unloadedRows: string[];
}

const byNumber = (a: string, b: string) => Number(a) - Number(b);

/** A page row's cells holding a string control id; anything else is skipped. */
export function pageCells(value: Fields): StoredCell[] {
  const controls = value["controls"];
  if (!isJsonObject(controls)) return [];
  const cells: StoredCell[] = [];
  for (const row of Object.keys(controls)
    .filter((key) => /^-?\d+$/.test(key))
    .sort(byNumber)) {
    const columns = controls[row];
    if (!isJsonObject(columns)) continue;
    for (const column of Object.keys(columns)
      .filter((key) => /^-?\d+$/.test(key))
      .sort(byNumber)) {
      const controlId = columns[column];
      if (typeof controlId === "string" && controlId !== "") {
        cells.push({ row: Number(row), column: Number(column), controlId });
      }
    }
  }
  return cells;
}

/** The pages Companion loads, and the numeric rows it does not. */
export function readPageStore(db: DatabaseSync): PageStore {
  const rows = readPageRows(db);
  const count = loadedPageCount(rows);
  const pages: LoadedPage[] = [];
  for (let page = 1; page <= count; page += 1) {
    const value = rows.get(page) as Fields;
    pages.push({ page, value, cells: pageCells(value) });
  }
  const unloadedRows = [...rows.keys()]
    .filter((page) => page > count)
    .sort((a, b) => a - b)
    .map(String);
  return { pages, unloadedRows };
}

/** Every `controls` row, parsed, by control id. */
export function readControls(db: DatabaseSync): Map<string, unknown> {
  const controls = new Map<string, unknown>();
  for (const row of db.prepare("SELECT id, value FROM controls").all()) {
    controls.set(String(row["id"]), parseStoredJson(row["value"]));
  }
  return controls;
}
