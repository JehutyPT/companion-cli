import type { DatabaseSync } from "node:sqlite";
import { readJsonValue } from "../core/database.ts";
import { CliError, ValidationError } from "../core/errors.ts";
import {
  expectInteger,
  expectMapping,
  expectString,
  fieldPath,
  type Fields,
  rejectUnknownFields,
  requireField,
} from "../core/validate.ts";
import type { Writer } from "../core/writer.ts";
import {
  type ActionSpec,
  actionVariableReferences,
  buildAction,
  customReferences,
  parseActionList,
} from "./actions.ts";
import { newId } from "./ids.ts";
import { prop } from "./shared.ts";

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
 *
 * The page row must already exist. The control previously at the location, if
 * any, is deleted; the page's `controls` map changes only at that cell.
 * Shapes: docs/companion-internals.md and reference/python-prototype/fill_page20.py.
 */

export interface Location {
  page: number;
  row: number;
  column: number;
}

export interface ButtonPlan {
  location: Location;
  /** As stored: line breaks already written as a literal backslash-n. */
  text: string;
  background: number;
  textColor: number;
  down: ActionSpec[];
  up: ActionSpec[];
}

const TOP_LEVEL_FIELDS = [
  "location",
  "text",
  "background",
  "textColor",
  "down",
  "up",
] as const;
const LOCATION_FIELDS = ["page", "row", "column"] as const;

function parseLocation(value: unknown): Location {
  const fields = expectMapping(value, "location");
  rejectUnknownFields(fields, LOCATION_FIELDS, "location");
  const [page, row, column] = LOCATION_FIELDS.map((key) =>
    expectInteger(
      requireField(fields, key, "location"),
      fieldPath("location", key),
    ),
  ) as [number, number, number];
  if (page < 1)
    throw new ValidationError(
      "location.page",
      `must be at least 1, got ${page}`,
    );
  return { page, row, column };
}

const COLOR = /^#([0-9a-f]{6})$/i;

function parseColor(value: unknown, field: string): number {
  if (value === null) {
    throw new ValidationError(
      field,
      'is empty; quote the color, for example "#000080" (an unquoted # starts a YAML comment)',
    );
  }
  const text = expectString(value, field);
  const match = COLOR.exec(text);
  if (!match) {
    throw new ValidationError(
      field,
      `must be a color "#RRGGBB", got "${text}"`,
    );
  }
  return parseInt(match[1] ?? "", 16);
}

/** The prototype's `fg_for`: black text on a bright background, white otherwise. */
export function defaultTextColor(background: number): number {
  const r = (background >> 16) & 255;
  const g = (background >> 8) & 255;
  const b = background & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? 0x000000 : 0xffffff;
}

/**
 * Companion stores line breaks in button text as a literal backslash-n. One
 * trailing newline (a `|` block scalar's) is dropped first.
 */
function parseText(value: unknown): string {
  const text = expectString(value, "text");
  return (text.endsWith("\n") ? text.slice(0, -1) : text).replaceAll(
    "\n",
    "\\n",
  );
}

export function parseButton(fields: Fields): ButtonPlan {
  rejectUnknownFields(fields, TOP_LEVEL_FIELDS, "");
  const location = parseLocation(requireField(fields, "location", ""));
  const text = parseText(requireField(fields, "text", ""));
  const background = parseColor(
    requireField(fields, "background", ""),
    "background",
  );
  const textColor = Object.hasOwn(fields, "textColor")
    ? parseColor(fields["textColor"], "textColor")
    : defaultTextColor(background);
  return {
    location,
    text,
    background,
    textColor,
    down: parseActionList(fields, "down"),
    up: parseActionList(fields, "up"),
  };
}

interface GridSize {
  minRow: number;
  maxRow: number;
  minColumn: number;
  maxColumn: number;
}

function readGridSize(db: DatabaseSync): GridSize {
  const userconfig = readJsonValue(db, "main", "userconfig");
  const grid =
    userconfig && typeof userconfig === "object"
      ? (userconfig as Fields)["gridSize"]
      : undefined;
  if (grid && typeof grid === "object") {
    const size = grid as Fields;
    const keys = ["minRow", "maxRow", "minColumn", "maxColumn"] as const;
    if (
      keys.every((key) => Number.isSafeInteger(size[key])) &&
      (size["minRow"] as number) <= (size["maxRow"] as number) &&
      (size["minColumn"] as number) <= (size["maxColumn"] as number)
    )
      return size as unknown as GridSize;
  }
  throw new CliError(
    "cannot read the grid size: main.userconfig.gridSize needs integer minRow <= maxRow and minColumn <= maxColumn",
  );
}

function checkInRange(
  field: string,
  value: number,
  min: number,
  max: number,
): void {
  if (value < min || value > max) {
    throw new CliError(
      `${field}: ${value} is outside the grid (${min}..${max})`,
    );
  }
}

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
  const value = readJsonValue(db, "pages", String(page));
  if (value === undefined) {
    throw new CliError(
      `location.page: page ${page} does not exist; this writer does not create pages`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(`location.page: pages row ${page} is not a JSON object`);
  }
  const stored = value as StoredPage;
  const controls = (stored.controls ??= {});
  const cells = (controls[String(row)] ??= {});
  const previous = cells[String(column)];
  if (previous === undefined || previous === null) {
    return { page: stored, cells, previous: undefined };
  }
  if (typeof previous !== "string" || !previous.startsWith("bank:")) {
    throw new CliError(
      `location: page ${page}, row ${row}, column ${column} holds ${JSON.stringify(previous)}, which is not a button control id; refusing to replace it`,
    );
  }
  return { page: stored, cells, previous };
}

function checkButton(db: DatabaseSync, plan: ButtonPlan): void {
  const grid = readGridSize(db);
  checkInRange("location.row", plan.location.row, grid.minRow, grid.maxRow);
  checkInRange(
    "location.column",
    plan.location.column,
    grid.minColumn,
    grid.maxColumn,
  );
  readTarget(db, plan.location);

  const known = new Set(
    db
      .prepare("SELECT id FROM custom_variables")
      .all()
      .map((r) => String(r["id"])),
  );
  const references = [
    ...customReferences(plan.text, "text"),
    ...actionVariableReferences(plan.down, "down"),
    ...actionVariableReferences(plan.up, "up"),
  ];
  for (const { field, name } of references) {
    if (!known.has(name))
      throw new CliError(`${field}: unknown custom variable "${name}"`);
  }
}

/** The prototype's `layers()`: canvas, background box, image and text. */
function layers(text: string, background: number, textColor: number) {
  const geometry = () => ({
    enabled: prop(true),
    opacity: prop(100),
    x: prop(0),
    y: prop(0),
    width: prop(100),
    height: prop(100),
    rotation: prop(0),
  });
  return [
    {
      id: "canvas",
      name: "Canvas",
      usage: "auto",
      type: "canvas",
      decoration: prop("default"),
      showStatusIcons: prop("default"),
    },
    {
      id: "box0",
      name: "Background",
      usage: "auto",
      type: "box",
      ...geometry(),
      color: prop(background),
      borderWidth: prop(0),
      borderColor: prop(0),
      borderPosition: prop("inside"),
      pinnedProperties: ["color"],
    },
    {
      id: "image0",
      name: "Image",
      usage: "auto",
      type: "image",
      ...geometry(),
      base64Image: prop(null),
      halign: prop("center"),
      valign: prop("center"),
      fillMode: prop("fit"),
      pinnedProperties: ["base64Image", "halign", "valign"],
    },
    {
      id: "text0",
      name: "Text",
      usage: "auto",
      type: "text",
      ...geometry(),
      text: prop(text),
      color: prop(textColor),
      halign: prop("center"),
      valign: prop("center"),
      fontsize: prop(100),
      fontsizeAllowShrink: prop(true),
      font: prop("companion-sans"),
      outlineColor: prop(4278190080),
      pinnedProperties: [
        "text",
        "fontsize",
        "fontsizeAllowShrink",
        "color",
        "halign",
        "valign",
      ],
    },
  ];
}

export function buildButtonControl(plan: ButtonPlan): Record<string, unknown> {
  return {
    type: "button-layered",
    options: {
      stepProgression: "auto",
      stepExpression: "",
      rotaryActions: false,
      canModifyStyleInApis: true,
      notes: "",
    },
    localVariables: [],
    steps: {
      "0": {
        action_sets: {
          down: plan.down.map(buildAction),
          up: plan.up.map(buildAction),
          rotate_left: [],
          rotate_right: [],
        },
        options: { runWhileHeld: [] },
      },
    },
    feedbacks: [],
    style: { layers: layers(plan.text, plan.background, plan.textColor) },
  };
}

function controlExists(db: DatabaseSync, id: string): boolean {
  return (
    db.prepare("SELECT 1 FROM controls WHERE id = ?").get(id) !== undefined
  );
}

function newControlId(db: DatabaseSync): string {
  for (;;) {
    const id = `bank:${newId()}`;
    if (!controlExists(db, id)) return id;
  }
}

export function writeButton(db: DatabaseSync, plan: ButtonPlan): string {
  const { page, row, column } = plan.location;
  const target = readTarget(db, plan.location);
  if (target.previous !== undefined) {
    db.prepare("DELETE FROM controls WHERE id = ?").run(target.previous);
  }

  const id = newControlId(db);
  db.prepare("INSERT INTO controls (id, value) VALUES (?, ?)").run(
    id,
    JSON.stringify(buildButtonControl(plan)),
  );
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
  parse: parseButton,
  check: checkButton,
  write: writeButton,
};
