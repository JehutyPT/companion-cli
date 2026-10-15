import type { DatabaseSync } from "node:sqlite";
import { CheckError } from "../core/errors.ts";
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
 *   hold:                                      # optional; action sets keyed by a hold duration
 *     - { after: 1000, whileHeld: true, actions: [ ...actions ] }   # after: ms, distinct per step
 *   steps:                                     # optional; replaces the five lists above
 *     - { down: [ ...actions ], up: [], rotate_left: [], rotate_right: [], hold: [] }
 *   progression: auto                          # optional: auto (default), manual, expression
 *   stepExpression: "$(custom:fx_counter)"     # only with, and required by, progression: expression
 *   notes: ""                                  # optional
 *   apiStyle: false                            # optional; stored as options.canModifyStyleInApis
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
    throw new CheckError(
      "location.page",
      `page ${page} does not exist; this writer does not create pages`,
    );
  }
  const count = loadedPageCount(pages);
  if (page > count) {
    throw new CheckError(
      "location.page",
      `page ${page} is not loaded by Companion (pages 1 to ${count} load); this writer does not create pages`,
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
    throw new CheckError(
      "location",
      `page ${page}, row ${row}, column ${column} holds ${JSON.stringify(previous)}, which is not a button control id; refusing to replace it`,
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
/** What a button file does: the kind's `description` in the schema. */
export const DOC =
  "Replaces the button at one location of an existing page with a `button-layered` control.";

/** YAML examples of a button file, as the schema shows them. */
export const EXAMPLES = [
  `kind: button
location: { page: 1, row: 0, column: 2 }
text: |
  Count
  $(custom:fx_counter)
background: "#000080"
down:
  - { action: increment, variable: fx_counter }
feedbacks:
  - feedback: expression
    expression: "$(custom:fx_counter) > 10"
    style: { background: "#FF0000", text: "MANY" }
`,
  `kind: button
location: { page: 1, row: 1, column: 0 }
text: FX
background: "#202020"
steps:
  - down: [{ action: set, variable: fx_label, value: "on" }]
  - down: [{ action: set, variable: fx_label, value: "off" }]
feedbacks:
  - { feedback: step, step: 2, style: { background: "#00FF00" } }
  - feedback: passthrough
    connection: FixtureConnectionAAAA
    definition: some_feedback_id
    options: { input: 1 }
    style: { text: LIVE }
    invert: true
`,
];
