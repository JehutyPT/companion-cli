import type { DatabaseSync } from "node:sqlite";
import { readJsonValue } from "../core/database.ts";
import { CliError, ValidationError } from "../core/errors.ts";
import {
  expectInteger,
  expectList,
  expectMapping,
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
  parseActionList,
} from "./actions.ts";
import {
  buildFeedback,
  feedbackVariableReferences,
  type FeedbackSpec,
  parseFeedbackList,
} from "./feedbacks.ts";
import { newId } from "./ids.ts";
import {
  checkVariablesExist,
  customReferences,
  parseColor,
  parseText,
  prop,
  type VariableReference,
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
 * The page row must already exist. The control previously at the location, if
 * any, is deleted; the page's `controls` map changes only at that cell.
 * Shapes: docs/companion-internals.md and reference/python-prototype/fill_page20.py.
 */

export interface Location {
  page: number;
  row: number;
  column: number;
}

/** One step: its action sets, keyed as Companion stores them. */
export interface StepPlan {
  /**
   * The step's path relative to the button: `""` for a button without
   * `steps` (its lists are top-level fields), otherwise `steps[i]`.
   */
  path: string;
  sets: Record<ActionSetName, ActionSpec[]>;
}

export interface ButtonPlan {
  location: Location;
  /** As stored: line breaks already written as a literal backslash-n. */
  text: string;
  background: number;
  textColor: number;
  /** At least one; stored keyed "0", "1", … in this order. */
  steps: StepPlan[];
  /** Whether any rotate key was given, at top level or in a step. */
  rotaryActions: boolean;
  feedbacks: FeedbackSpec[];
}

const ACTION_SETS = ["down", "up", "rotate_left", "rotate_right"] as const;
type ActionSetName = (typeof ACTION_SETS)[number];
const ROTATE_SETS: readonly ActionSetName[] = ["rotate_left", "rotate_right"];

const TOP_LEVEL_FIELDS = [
  "location",
  "text",
  "background",
  "textColor",
  ...ACTION_SETS,
  "steps",
  "feedbacks",
] as const;
const LOCATION_FIELDS = ["page", "row", "column"] as const;

/** `relative` (a path inside a button, possibly empty) under `prefix`. */
function under(prefix: string, relative: string): string {
  return relative ? fieldPath(prefix, relative) : prefix;
}

function parseLocation(value: unknown, path: string): Location {
  const fields = expectMapping(value, path);
  rejectUnknownFields(fields, LOCATION_FIELDS, path);
  const [page, row, column] = LOCATION_FIELDS.map((key) =>
    expectInteger(requireField(fields, key, path), fieldPath(path, key)),
  ) as [number, number, number];
  if (page < 1)
    throw new ValidationError(
      fieldPath(path, "page"),
      `must be at least 1, got ${page}`,
    );
  return { page, row, column };
}

/** The prototype's `fg_for`: black text on a bright background, white otherwise. */
export function defaultTextColor(background: number): number {
  const r = (background >> 16) & 255;
  const g = (background >> 8) & 255;
  const b = background & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? 0x000000 : 0xffffff;
}

/** One step's action sets from `fields` (the description, or one `steps` entry). */
function parseStep(fields: Fields, path: string, prefix: string): StepPlan {
  return {
    path,
    sets: Object.fromEntries(
      ACTION_SETS.map((set) => [
        set,
        parseActionList(fields, set, under(prefix, path)),
      ]),
    ) as StepPlan["sets"],
  };
}

const hasRotateKey = (fields: Fields) =>
  ROTATE_SETS.some((set) => Object.hasOwn(fields, set));

/**
 * The button's steps: the `steps` list, or one step from the top-level action
 * lists. Also whether any rotate key was given (an empty list counts).
 */
function parseSteps(
  fields: Fields,
  prefix: string,
): { steps: StepPlan[]; rotaryActions: boolean } {
  if (!Object.hasOwn(fields, "steps")) {
    return {
      steps: [parseStep(fields, "", prefix)],
      rotaryActions: hasRotateKey(fields),
    };
  }
  for (const set of ACTION_SETS) {
    if (Object.hasOwn(fields, set))
      throw new ValidationError(
        fieldPath(prefix, set),
        "cannot be combined with steps",
      );
  }
  const stepsPath = fieldPath(prefix, "steps");
  const list = expectList(fields["steps"], stepsPath);
  if (list.length === 0)
    throw new ValidationError(stepsPath, "must not be empty");
  const entries = list.map((item, index) => {
    const path = fieldPath(stepsPath, index);
    const entry = expectMapping(item, path);
    rejectUnknownFields(entry, ACTION_SETS, path);
    return entry;
  });
  return {
    steps: entries.map((entry, index) =>
      parseStep(entry, fieldPath("steps", index), prefix),
    ),
    rotaryActions: entries.some(hasRotateKey),
  };
}

/**
 * Parses a button description. `prefix` is the path of `fields` when the
 * button is embedded in another description (for example `buttons[3]`).
 */
export function parseButton(fields: Fields, prefix = ""): ButtonPlan {
  const path = (key: string) => fieldPath(prefix, key);
  rejectUnknownFields(fields, TOP_LEVEL_FIELDS, prefix);
  const location = parseLocation(
    requireField(fields, "location", prefix),
    path("location"),
  );
  const text = parseText(requireField(fields, "text", prefix), path("text"));
  const background = parseColor(
    requireField(fields, "background", prefix),
    path("background"),
  );
  const textColor = Object.hasOwn(fields, "textColor")
    ? parseColor(fields["textColor"], path("textColor"))
    : defaultTextColor(background);
  const { steps, rotaryActions } = parseSteps(fields, prefix);
  return {
    location,
    text,
    background,
    textColor,
    steps,
    rotaryActions,
    feedbacks: parseFeedbackList(
      fields,
      "feedbacks",
      { stepCount: steps.length },
      prefix,
    ),
  };
}

/**
 * Every custom variable the button uses, in file order: references in its
 * text, its actions' targets and references, and its feedbacks' expressions
 * and style text. `prefix` is the one given to `parseButton`.
 */
export function buttonVariableReferences(
  plan: ButtonPlan,
  prefix = "",
): VariableReference[] {
  return [
    ...customReferences(plan.text, fieldPath(prefix, "text")),
    ...plan.steps.flatMap((step) =>
      ACTION_SETS.flatMap((set) =>
        actionVariableReferences(
          step.sets[set],
          fieldPath(under(prefix, step.path), set),
        ),
      ),
    ),
    ...feedbackVariableReferences(
      plan.feedbacks,
      fieldPath(prefix, "feedbacks"),
    ),
  ];
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

  checkVariablesExist(db, buttonVariableReferences(plan));
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
      rotaryActions: plan.rotaryActions,
      canModifyStyleInApis: true,
      notes: "",
    },
    localVariables: [],
    steps: Object.fromEntries(
      plan.steps.map((step, index) => [
        String(index),
        {
          action_sets: Object.fromEntries(
            ACTION_SETS.map((set) => [set, step.sets[set].map(buildAction)]),
          ),
          options: { runWhileHeld: [] },
        },
      ]),
    ),
    feedbacks: plan.feedbacks.map(buildFeedback),
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
  parse: (fields) => parseButton(fields),
  check: checkButton,
  write: writeButton,
};
