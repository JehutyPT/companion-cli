/**
 * `export page <n>` (one `kind: page` file: the page's name and every button,
 * in row, then column order) and `export page <n> --button <row>/<column>`
 * (one `kind: button` file for the control at that cell). Pages are read as
 * the page writer reads them (`readPageRows`, `loadedPageCount`); each button
 * is mapped by src/export/buttons.ts and self-checked with the writer's build.
 *
 * A page export refuses when any cell refuses, and names every refused cell
 * in one error.
 */
import type { DatabaseSync } from "node:sqlite";
import { parseStoredJson } from "../core/database.ts";
import { CliError } from "../core/errors.ts";
import { type Fields, isJsonObject } from "../core/validate.ts";
import {
  type Cell,
  isButtonControlId,
  readGridSize,
} from "../writers/button-control.ts";
import {
  buildPageControls,
  buildPageRow,
  type PagePlan,
  pageWriter,
} from "../writers/page.ts";
import { loadedPageCount, readPageRows } from "../writers/shared.ts";
import { cellButton, locatedButton } from "./buttons.ts";
import {
  describeStored,
  ExportRefusal,
  ExportRefusals,
  type Exporter,
  type PartRefusal,
  refuse,
  selfCheck,
} from "./export.ts";

interface PageItem {
  page: number;
  /** The page row, a JSON object. */
  row: Fields;
  /** With `--button`, the cell to export. */
  cell?: Cell;
}

const PAGE_NUMBER = /^[1-9]\d*$/;
const CELL = /^(-?\d+)\/(-?\d+)$/;

function parseCellOption(value: string): Cell | undefined {
  const match = CELL.exec(value);
  if (!match) return undefined;
  const row = Number(match[1]);
  const column = Number(match[2]);
  return Number.isSafeInteger(row) && Number.isSafeInteger(column)
    ? { row, column }
    : undefined;
}

const where = (page: number, { row, column }: Cell) =>
  `page ${page}, row ${row}, column ${column}`;

/** The page's cells in row, then column order: every stored value, nulls included. */
function storedCells(
  row: Fields,
): Array<{ cell: Cell; path: string; value: unknown }> {
  const controls = row["controls"] ?? {};
  if (!isJsonObject(controls))
    refuse(
      "controls",
      `is ${describeStored(controls)}, not a map of rows`,
      "page",
    );
  const byNumber = (keys: string[]) =>
    keys
      .map((key) => ({ key, number: Number(key) }))
      .sort((a, b) => a.number - b.number);
  return byNumber(Object.keys(controls)).flatMap(({ key: rowKey, number }) => {
    const columns = controls[rowKey];
    if (!isJsonObject(columns) || Object.keys(columns).length === 0)
      return [
        {
          cell: { row: number, column: Number.NaN },
          path: `controls.${rowKey}`,
          value: columns,
        },
      ];
    return byNumber(Object.keys(columns)).map(({ key, number: column }) => ({
      cell: { row: number, column },
      path: `controls.${rowKey}.${key}`,
      value: columns[key],
    }));
  });
}

/** The control ids each other page holds, by id. */
function otherPages(db: DatabaseSync, page: number): Map<string, number> {
  const holders = new Map<string, number>();
  for (const [number, value] of readPageRows(db)) {
    if (number === page || !isJsonObject(value)) continue;
    const controls = value["controls"];
    if (!isJsonObject(controls)) continue;
    for (const columns of Object.values(controls)) {
      if (!isJsonObject(columns)) continue;
      for (const id of Object.values(columns))
        if (isButtonControlId(id) && !holders.has(id)) holders.set(id, number);
    }
  }
  return holders;
}

function readControl(db: DatabaseSync, id: string): unknown {
  const row = db.prepare("SELECT value FROM controls WHERE id = ?").get(id);
  return row === undefined ? undefined : parseStoredJson(row["value"]);
}

/**
 * The control id at a stored cell, refused unless it is a button control
 * that exists and that no other cell, on this page or another, also holds.
 */
function cellControl(
  db: DatabaseSync,
  stored: { path: string; value: unknown },
  seen: Map<string, string>,
  holders: Map<string, number>,
): { id: string; control: unknown } {
  const { path, value } = stored;
  if (value === null || isJsonObject(value) || value === undefined)
    refuse(
      path,
      `is ${describeStored(value)}${isJsonObject(value) ? " (an empty row)" : ""}, which apply would not store`,
      "page",
    );
  if (!isButtonControlId(value))
    refuse(
      path,
      `is ${JSON.stringify(value)}, which is not a button control id`,
      "page",
    );
  const twin = seen.get(value);
  if (twin !== undefined)
    refuse(
      path,
      `is ${value}, which ${twin} also holds; apply would write two controls`,
      "page",
    );
  seen.set(value, path);
  const other = holders.get(value);
  if (other !== undefined)
    refuse(
      path,
      `is ${value}, which page ${other} also holds; apply refuses to delete a shared control`,
      "page",
    );
  const control = readControl(db, value);
  if (control === undefined)
    refuse(path, `is ${value}, which has no controls row`, "page");
  return { id: value, control };
}

/** The `kind: page` body, refusing with every cell that blocks it. */
function pageEntry(db: DatabaseSync, { page, row }: PageItem): Fields {
  const refused: PartRefusal[] = [];
  const attempt = <T>(
    label: string,
    name: string,
    run: () => T,
  ): T | undefined => {
    try {
      return run();
    } catch (error) {
      if (!(error instanceof ExportRefusal)) throw error;
      refused.push({ label, name, refusal: error.refusal });
      return undefined;
    }
  };

  const name = row["name"];
  attempt(`page ${page}`, "name", () => {
    if (typeof name !== "string" || name === "")
      refuse(
        "name",
        `is ${name === "" ? "empty" : describeStored(name)}; a page description needs a non-empty name`,
        "page",
      );
  });

  const seen = new Map<string, string>();
  const holders = otherPages(db, page);
  const ids = new Map<string, string>();
  const buttons: Fields[] = [];
  for (const stored of attempt(`page ${page}`, "controls", () =>
    storedCells(row),
  ) ?? []) {
    const { cell } = stored;
    const located = Number.isNaN(cell.column)
      ? `page ${page}, row ${cell.row}`
      : where(page, cell);
    const found = attempt(located, located.slice(`page ${page}, `.length), () =>
      cellControl(db, stored, seen, holders),
    );
    if (!found) continue;
    const button = attempt(
      `${located} (${found.id})`,
      located.slice(`page ${page}, `.length),
      () => cellButton(found.control, cell),
    );
    if (!button) continue;
    ids.set(`${cell.row}/${cell.column}`, found.id);
    buttons.push(button);
  }
  if (refused.length > 0) throw new ExportRefusals(`page ${page}`, refused);

  const body: Fields = { page, name, buttons };
  selfCheck<PagePlan>({
    stored: row,
    parse: () => pageWriter.parse(body),
    check: (plan) => pageWriter.check?.(db, plan),
    build: (plan) =>
      buildPageRow(
        row,
        plan.name,
        buildPageControls(
          plan.buttons,
          ({ location }) => ids.get(`${location.row}/${location.column}`) ?? "",
        ),
      ),
    storedPath: (field) => {
      const match = /^buttons\[(\d+)\]/.exec(field);
      const location = match
        ? (buttons[Number(match[1])]?.["location"] as Cell | undefined)
        : undefined;
      return location ? `controls.${location.row}.${location.column}` : field;
    },
    area: () => "page",
  });
  return body;
}

/** The value stored at one cell of a page row, if any. */
function cellValue(row: Fields, { row: r, column: c }: Cell): unknown {
  const controls = isJsonObject(row["controls"]) ? row["controls"] : {};
  const columns = controls[String(r)];
  return isJsonObject(columns) ? columns[String(c)] : undefined;
}

/** The `kind: button` body for the item's cell. */
function buttonEntry(db: DatabaseSync, { page, row, cell }: PageItem): Fields {
  const at = cell as Cell;
  const { id, control } = cellControl(
    db,
    { path: `controls.${at.row}.${at.column}`, value: cellValue(row, at) },
    new Map(),
    otherPages(db, page),
  );
  try {
    return locatedButton(db, control, { page, ...at });
  } catch (error) {
    if (!(error instanceof ExportRefusal)) throw error;
    throw new ExportRefusals(`${where(page, at)} (${id})`, [
      {
        label: `${where(page, at)} (${id})`,
        name: `row ${at.row}, column ${at.column}`,
        refusal: error.refusal,
      },
    ]);
  }
}

/** Page `page`, refused unless Companion loads it. */
function selectPage(db: DatabaseSync, page: number): Fields {
  const pages = readPageRows(db);
  if (!pages.has(page))
    throw new CliError(`page ${page} does not exist`, { code: "not_found" });
  const count = loadedPageCount(pages);
  if (page > count)
    throw new CliError(
      `page ${page} is not loaded by Companion (pages 1 to ${count} load)`,
      { code: "not_found" },
    );
  return pages.get(page) as Fields;
}

/** Refuses a cell outside the grid, or one without a control. */
function checkCell(db: DatabaseSync, page: number, row: Fields, cell: Cell) {
  const grid = readGridSize(db);
  const bound = (axis: string, value: number, min: number, max: number) => {
    if (value < min || value > max)
      throw new CliError(
        `${axis} ${value} is outside the grid (${axis}s ${min} to ${max})`,
        { code: "not_found" },
      );
  };
  bound("row", cell.row, grid.minRow, grid.maxRow);
  bound("column", cell.column, grid.minColumn, grid.maxColumn);
  const value = cellValue(row, cell);
  if (value === undefined || value === null)
    throw new CliError(`no control at ${where(page, cell)}`, {
      code: "not_found",
    });
}

export const pageExporter: Exporter<PageItem> = {
  kind: "page",
  arguments: "<n> [--button <row>/<column>]",
  valueOptions: ["button"],
  noun: "pages",
  checkArgs: (args, values) => {
    if (args.length !== 1 || !PAGE_NUMBER.test(args[0] as string))
      return "export page takes one page number, at least 1";
    const button = values["button"];
    if (button !== undefined && parseCellOption(button) === undefined)
      return `--button takes <row>/<column>, for example 0/3 or -1/0; got ${JSON.stringify(button)}`;
    return undefined;
  },
  select: (db, [number], values) => {
    const page = Number(number);
    const row = selectPage(db, page);
    const button = values["button"];
    if (button === undefined) return [{ page, row }];
    const cell = parseCellOption(button) as Cell;
    checkCell(db, page, row, cell);
    return [{ page, row, cell }];
  },
  name: ({ page }) => `page ${page}`,
  label: ({ page, cell }) => (cell ? where(page, cell) : `page ${page}`),
  entry: (db, item) =>
    item.cell ? buttonEntry(db, item) : pageEntry(db, item),
  file: ([body], values) => ({
    kind: values["button"] === undefined ? "page" : "button",
    ...body,
  }),
};
