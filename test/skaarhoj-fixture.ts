/**
 * Shared by the SKAARHOJ test page's prototype capture and its reproduction
 * tests (#10): the fixture changes they need and the id-free form of a page's
 * content that they compare.
 */
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { FIXTURE_GRID_SIZE } from "./fixtures/companion-db.ts";
import { type Json, page, rows, stripIds, type TableDump } from "./helpers.ts";

/** The prototype's 12 custom variables, in its order. */
export const SKAARHOJ_VARIABLES = [
  "sk_presses",
  "sk_last",
  ...Array.from({ length: 8 }, (_, i) => `sk_enc${i + 1}`),
  "sk_iris",
  "sk_focus",
] as const;

/** The fixed id of a seeded empty page: 21 characters, like Companion's. */
export function seededPageId(pageNumber: number): string {
  return `SeedPage${String(pageNumber).padStart(13, "0")}`;
}

/** Seeds `pages` rows "2" to `last` as empty `PAGE` pages with fixed ids. */
export function seedEmptyPages(db: DatabaseSync, last: number): void {
  const insert = db.prepare("INSERT INTO pages (id, value) VALUES (?, ?)");
  for (let n = 2; n <= last; n++) {
    insert.run(
      String(n),
      JSON.stringify({ id: seededPageId(n), name: "PAGE", controls: {} }),
    );
  }
}

/** Widens the fixture's grid to columns 0–16, keeping the rest of `userconfig`. */
export function widenGrid(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT value FROM main WHERE id = 'userconfig'")
    .get();
  const userconfig = JSON.parse(String(row?.["value"])) as Json;
  userconfig["gridSize"] = { ...FIXTURE_GRID_SIZE, maxColumn: 16 };
  db.prepare("UPDATE main SET value = ? WHERE id = 'userconfig'").run(
    JSON.stringify(userconfig),
  );
}

export type Cells = Record<string, Record<string, string>>;

/** A page's content without generated ids: its row, its controls by "row/column", and the named variables. */
export interface PageContent {
  page: Json;
  controls: Record<string, unknown>;
  variables: Record<string, unknown>;
}

/**
 * The content of page `pageId` in `dump`: the parsed `pages` row with every
 * cell's control id replaced by "<id>", each control's parsed JSON keyed by
 * "row/column" with `id` and `overrideId` replaced by "<id>", and the parsed
 * `custom_variables` rows named in `variableNames`, in that order.
 */
export function pageContent(
  dump: TableDump,
  pageId: string,
  variableNames: readonly string[],
): PageContent {
  const stored = page(dump, pageId);
  const cells = stored["controls"] as Cells;
  const controlRows = rows(dump, "controls");
  const strippedCells: Cells = {};
  const controls: Record<string, unknown> = {};
  for (const [row, columns] of Object.entries(cells)) {
    strippedCells[row] = {};
    for (const [column, id] of Object.entries(columns)) {
      assert.match(id, /^bank:[A-Za-z0-9_-]{21}$/, `cell ${row}/${column}`);
      strippedCells[row][column] = "<id>";
      const control = controlRows.get(id);
      assert.ok(control, `controls row ${id}`);
      controls[`${row}/${column}`] = stripIds(control);
    }
  }
  const variableRows = rows(dump, "custom_variables");
  const variables = Object.fromEntries(
    variableNames.map((name) => {
      const value = variableRows.get(name);
      assert.ok(value, `custom_variables row ${name}`);
      return [name, value];
    }),
  );
  return { page: { ...stored, controls: strippedCells }, controls, variables };
}

/**
 * `value` with `children: {}` on every internal action or feedback that
 * lacks it, as Companion stores entities (`asEntityModel`) and the writers
 * do since #23. The prototype wrote internal actions without `children`, so
 * the reproduction tests compare against the capture in this form; the
 * committed capture stays exactly what the prototype wrote.
 */
export function withInternalChildren<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withInternalChildren) as T;
  if (value === null || typeof value !== "object") return value;
  const object = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      withInternalChildren(child as unknown),
    ]),
  );
  const isEntity = object["type"] === "action" || object["type"] === "feedback";
  if (
    isEntity &&
    object["connectionId"] === "internal" &&
    !("children" in object)
  )
    object["children"] = {};
  return object as T;
}
