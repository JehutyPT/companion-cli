import type { DatabaseSync } from "node:sqlite";
import { CliError } from "../core/errors.ts";
import type { Fields } from "../core/validate.ts";
import type { Writer } from "../core/writer.ts";
import {
  type ButtonPlan,
  buttonVariableReferences,
  checkCellInGrid,
  insertButtonControl,
  isButtonControlId,
  type Location,
  parseButton,
  readGridSize,
} from "./button-control.ts";
import {
  checkVariablesExist,
  loadedPageCount,
  readPageRows,
} from "./shared.ts";

/**
 * Button writer: replaces the control at one location with a Companion 5.1
 * `button-layered` control.
 *
 *   kind: button
 *   location: { page: 1, row: 0, column: 2 }   # page >= 1; row/column may be negative
 *   text: "Count\n$(custom:fx_counter)"        # may be empty
 *   background: "#000080"                      # quoted: an unquoted # starts a YAML comment
 *   textColor: "#FFFFFF"                       # optional; black or white by background brightness
 *   down: [ ...actions ]                       # optional, see actions.ts
 *   up: [ ...actions ]                         # optional
 *   rotate_left: [ ...actions ]                # optional; any rotate key turns on rotaryActions
 *   rotate_right: [ ...actions ]               # optional
 *   steps:                                     # optional; replaces the four lists above
 *     - { down: [ ...actions ], up: [], rotate_left: [], rotate_right: [] }
 *   feedbacks: [ ...feedbacks ]                # optional, see feedbacks.ts
 *
 * The page must already exist and be one Companion loads (pages 1, 2, … up
 * to the first missing one); only the page writer creates pages. The control previously at the location, if
 * any, is deleted; the page's `controls` map changes only at that cell.
 * Parsing and the control JSON live in button-control.ts, shared with the
 * page writer. Shapes: docs/companion-internals.md and
 * reference/python-prototype/fill_page20.py.
 */

interface StoredPage extends Fields {
  controls?: Record<string, Record<string, unknown>>;
}

/** The page row holding the location, and the button control id at the location, if any. */
interface Target {
  page: StoredPage;
  cells: Record<string, unknown>;
  previous: string | undefined;
}

/**
 * Reads the location's page and cell. Refuses a missing page and a cell that
 * holds anything but a `bank:` control id, so the write can only delete the
 * button at the location.
 */
function readTarget(db: DatabaseSync, location: Location): Target {
  const { page, row, column } = location;
  const pages = readPageRows(db);
  if (!pages.has(page)) {
    throw new CliError(
      `location.page: page ${page} does not exist; this writer does not create pages`,
    );
  }
  const count = loadedPageCount(pages);
  if (page > count) {
    throw new CliError(
      `location.page: page ${page} is not loaded by Companion (pages 1 to ${count} load); this writer does not create pages`,
    );
  }
  const stored = pages.get(page) as StoredPage;
  const controls = (stored.controls ??= {});
  const cells = (controls[String(row)] ??= {});
  const previous = cells[String(column)];
  if (previous === undefined || previous === null) {
    return { page: stored, cells, previous: undefined };
  }
  if (!isButtonControlId(previous)) {
    throw new CliError(
      `location: page ${page}, row ${row}, column ${column} holds ${JSON.stringify(previous)}, which is not a button control id; refusing to replace it`,
    );
  }
  return { page: stored, cells, previous };
}

function checkButton(db: DatabaseSync, plan: ButtonPlan): void {
  checkCellInGrid(readGridSize(db), plan.location);
  readTarget(db, plan.location);

  checkVariablesExist(db, buttonVariableReferences(plan));
}

function writeButton(db: DatabaseSync, plan: ButtonPlan): string {
  const { page, row, column } = plan.location;
  const target = readTarget(db, plan.location);
  if (target.previous !== undefined) {
    db.prepare("DELETE FROM controls WHERE id = ?").run(target.previous);
  }

  const id = insertButtonControl(db, plan);
  target.cells[String(column)] = id;
  db.prepare("UPDATE pages SET value = ? WHERE id = ?").run(
    JSON.stringify(target.page),
    String(page),
  );

  const where = `page ${page}, row ${row}, column ${column}`;
  return target.previous !== undefined
    ? `button at ${where}: replaced ${target.previous} with ${id}`
    : `button at ${where}: created ${id}`;
}

export const buttonWriter: Writer<ButtonPlan> = {
  kind: "button",
  parse: (fields) => parseButton(fields),
  check: checkButton,
  describe: ({ location: { page, row, column } }) =>
    `button at page ${page}, row ${row}, column ${column}`,
  write: writeButton,
};
