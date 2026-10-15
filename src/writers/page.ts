import type { DatabaseSync } from "node:sqlite";
import { CheckError, ValidationError } from "../core/errors.ts";
import {
  expectList,
  expectMapping,
  expectNonEmptyString,
  expectPositiveInteger,
  fieldPath,
  type Fields,
  isJsonObject,
  rejectUnknownFields,
  requireField,
} from "../core/validate.ts";
import type { Writer } from "../core/writer.ts";
import {
  type ButtonDescription,
  buttonVariableReferences,
  type Cell,
  checkCellInGrid,
  insertButtonControl,
  isButtonControlId,
  parseButtonDescription,
  parseCell,
  readGridSize,
} from "./button-control.ts";
import { freshId } from "./ids.ts";
import {
  checkVariablesExist,
  loadedPageCount,
  plural,
  readPageRows,
} from "./shared.ts";

/**
 * Page writer: replaces one page's name and all of its buttons, creating the
 * page when it does not exist.
 *
 *   kind: page
 *   page: 20                                 # >= 1
 *   name: SKAARHOJ TEST                      # non-empty
 *   buttons:                                 # may be empty (clears the page)
 *     - location: { row: 0, column: 0 }      # row and column only
 *       text: S1                             # every other kind: button field
 *       background: "#FF0000"
 *
 * Every `bank:` control the page held is deleted, Companion's navigation
 * buttons included, and one new control per entry is written. An existing
 * page row keeps its internal `id` and any other keys.
 *
 * Companion 5.1 loads `pages` rows "1", "2", … up to the first missing
 * number, so a page beyond the last page plus one needs the pages in between:
 * they are created empty, as Companion creates them (`{id, name: "PAGE",
 * controls: {}}`). Companion creates each page's `page:` control at startup;
 * this writer does not write it. See docs/companion-internals.md, "Tables".
 */

export interface PagePlan {
  page: number;
  name: string;
  buttons: Array<ButtonDescription<Cell>>;
}

export const FIELDS = ["page", "name", "buttons"];

/** Companion's name for a page it creates without one. */
const DEFAULT_PAGE_NAME = "PAGE";

const buttonPath = (index: number) => fieldPath("buttons", index);

function parsePage(fields: Fields): PagePlan {
  rejectUnknownFields(fields, FIELDS, "");
  const page = expectPositiveInteger(requireField(fields, "page", ""), "page");
  const name = expectNonEmptyString(requireField(fields, "name", ""), "name");
  const list = expectList(requireField(fields, "buttons", ""), "buttons");
  const buttons = list.map((item, index) =>
    parseButtonDescription(
      expectMapping(item, buttonPath(index)),
      buttonPath(index),
      parseCell,
    ),
  );
  const seen = new Map<string, number>();
  buttons.forEach(({ location: { row, column } }, index) => {
    const key = `${row}/${column}`;
    const first = seen.get(key);
    if (first !== undefined) {
      throw new ValidationError(
        fieldPath(buttonPath(index), "location"),
        `duplicates ${buttonPath(first)} (row ${row}, column ${column})`,
      );
    }
    seen.set(key, index);
  });
  return { page, name, buttons };
}

type CellMap = Record<string, Record<string, unknown>>;

/** The `bank:` ids in a page row's `controls` map; anything malformed is skipped. */
function referencedIds(value: unknown): string[] {
  if (!isJsonObject(value) || !isJsonObject(value["controls"])) return [];
  return Object.values(value["controls"]).flatMap((cells) =>
    isJsonObject(cells) ? Object.values(cells).filter(isButtonControlId) : [],
  );
}

/** What the write does: the existing page row, or the pages to create. */
interface Target {
  /** The described page's stored row, when it exists. */
  existing: Fields | undefined;
  /** Its distinct `bank:` control ids, to delete. */
  previous: string[];
  /** Empty pages to create before the described page. */
  gaps: number[];
  /** Every page id in use, so new ones are distinct. */
  pageIds: Set<unknown>;
}

/**
 * Reads the page store as Companion loads it and refuses anything the write
 * could not replace safely: a stray row Companion does not load in the way of
 * a page to create, a cell holding anything but a button control id, or a
 * control another page also uses.
 */
function readTarget(db: DatabaseSync, page: number): Target {
  const pages = readPageRows(db);
  const count = loadedPageCount(pages);
  const pageIds = new Set(
    [...pages.values()].map((value) =>
      isJsonObject(value) ? value["id"] : undefined,
    ),
  );
  pageIds.delete(undefined);

  if (page > count) {
    for (let number = count + 1; number <= page; number += 1) {
      if (!pages.has(number)) continue;
      const value = pages.get(number);
      throw new CheckError(
        "page",
        isJsonObject(value)
          ? `pages row ${number} exists but Companion does not load it (pages 1 to ${count} load); refusing to create page ${page} around it`
          : `pages row ${number} holds ${JSON.stringify(value)}, which is not a page Companion loads (pages 1 to ${count} load); refusing to write page ${page} over it`,
      );
    }
    const gaps: number[] = [];
    for (let number = count + 1; number < page; number += 1) gaps.push(number);
    return { existing: undefined, previous: [], gaps, pageIds };
  }

  // A loaded page, so its row is a JSON object.
  const stored = pages.get(page) as Fields;
  const controls = stored["controls"] ?? {};
  if (!isJsonObject(controls)) {
    throw new CheckError(
      "page",
      `pages row ${page} has a controls value that is not a JSON object`,
    );
  }
  for (const [row, cells] of Object.entries(controls)) {
    if (cells === null) continue;
    if (!isJsonObject(cells)) {
      throw new CheckError(
        "page",
        `page ${page}, row ${row} holds ${JSON.stringify(cells)}, which is not a map of cells; refusing to delete it`,
      );
    }
    for (const [column, value] of Object.entries(cells)) {
      if (value === null || isButtonControlId(value)) continue;
      throw new CheckError(
        "page",
        `page ${page}, row ${row}, column ${column} holds ${JSON.stringify(value)}, which is not a button control id; refusing to delete it`,
      );
    }
  }
  const previous = [...new Set(referencedIds(stored))];
  const owned = new Set(previous);
  for (const [number, value] of pages) {
    if (number === page) continue;
    const shared = referencedIds(value).find((id) => owned.has(id));
    if (shared !== undefined) {
      throw new CheckError(
        "page",
        `control ${shared} on page ${page} is also on page ${number}; refusing to delete it`,
      );
    }
  }
  return { existing: stored, previous, gaps: [], pageIds };
}

function checkPage(db: DatabaseSync, plan: PagePlan): void {
  const grid = readGridSize(db);
  plan.buttons.forEach((button, index) =>
    checkCellInGrid(grid, button.location, buttonPath(index)),
  );
  checkVariablesExist(
    db,
    plan.buttons.flatMap((button, index) =>
      buttonVariableReferences(button, buttonPath(index)),
    ),
  );
  readTarget(db, plan.page);
}

/** A fresh page id, recorded in `used`. */
function newPageId(used: Set<unknown>): string {
  const id = freshId((candidate) => used.has(candidate));
  used.add(id);
  return id;
}

function insertPage(db: DatabaseSync, page: number, value: Fields): void {
  db.prepare("INSERT INTO pages (id, value) VALUES (?, ?)").run(
    String(page),
    JSON.stringify(value),
  );
}

function writePage(db: DatabaseSync, plan: PagePlan): string {
  const target = readTarget(db, plan.page);
  let deleted = 0;
  for (const id of target.previous) {
    deleted += Number(
      db.prepare("DELETE FROM controls WHERE id = ?").run(id).changes,
    );
  }

  // Cells in row then column order, so the stored map does not depend on the
  // order of the description's entries.
  const ordered = [...plan.buttons].sort(
    (a, b) =>
      a.location.row - b.location.row || a.location.column - b.location.column,
  );
  const controls: CellMap = {};
  for (const button of ordered) {
    const { row, column } = button.location;
    (controls[String(row)] ??= {})[String(column)] = insertButtonControl(
      db,
      button,
    );
  }

  for (const gap of target.gaps) {
    insertPage(db, gap, {
      id: newPageId(target.pageIds),
      name: DEFAULT_PAGE_NAME,
      controls: {},
    });
  }
  if (target.existing) {
    db.prepare("UPDATE pages SET value = ? WHERE id = ?").run(
      JSON.stringify({ ...target.existing, name: plan.name, controls }),
      String(plan.page),
    );
  } else {
    insertPage(db, plan.page, {
      id: newPageId(target.pageIds),
      name: plan.name,
      controls,
    });
  }

  const summary = `page ${plan.page} ${JSON.stringify(plan.name)}: ${target.existing ? "replaced" : "created"}; deleted ${plural(deleted, "control")}, wrote ${plural(plan.buttons.length, "control")}`;
  return target.gaps.length > 0
    ? `${summary}; created ${plural(target.gaps.length, "empty page")}: ${target.gaps.join(", ")}`
    : summary;
}

export const pageWriter: Writer<PagePlan> = {
  kind: "page",
  parse: parsePage,
  check: checkPage,
  describe: (plan) =>
    `page ${plan.page} ${JSON.stringify(plan.name)} (${plural(plan.buttons.length, "button")})`,
  write: writePage,
};
