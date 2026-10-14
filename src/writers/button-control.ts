import type { DatabaseSync } from "node:sqlite";
import { readJsonValue } from "../core/database.ts";
import { CliError, ValidationError } from "../core/errors.ts";
import {
  expectInteger,
  expectList,
  expectMapping,
  fieldPath,
  type Fields,
  isJsonObject,
  rejectUnknownFields,
  requireField,
} from "../core/validate.ts";
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
import { controlExists, freshId } from "./ids.ts";
import {
  customReferences,
  parseColor,
  parseText,
  prop,
  type VariableReference,
} from "./shared.ts";

/**
 * A button's description and its `button-layered` control, shared by the
 * button writer (one location) and the page writer (a page's cells). Like
 * actions.ts and feedbacks.ts this is not a writer: writers import it, never
 * each other.
 *
 * A button description holds a `location` plus the fields below; the caller
 * decides the location's fields (`page`, `row`, `column` for `kind: button`,
 * `row` and `column` for a page's cell). See src/writers/button.ts for the
 * format.
 */

/** A cell on a page. Rows and columns may be negative. */
export interface Cell {
  row: number;
  column: number;
}

export interface Location extends Cell {
  page: number;
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

/** Everything about a button except where it goes. */
export interface ButtonContent {
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

/** A parsed button description whose location has the shape `L`. */
export type ButtonDescription<L> = ButtonContent & { location: L };

export type ButtonPlan = ButtonDescription<Location>;

export const ACTION_SETS = [
  "down",
  "up",
  "rotate_left",
  "rotate_right",
] as const;
type ActionSetName = (typeof ACTION_SETS)[number];
const ROTATE_SETS: readonly ActionSetName[] = ["rotate_left", "rotate_right"];

export const TOP_LEVEL_FIELDS = [
  "location",
  "text",
  "background",
  "textColor",
  ...ACTION_SETS,
  "steps",
  "feedbacks",
] as const;

/** `relative` (a path inside a button, possibly empty) under `prefix`. */
function under(prefix: string, relative: string): string {
  return relative ? fieldPath(prefix, relative) : prefix;
}

/** Validates a location mapping with exactly the integer fields `keys`. */
function parseIntegerFields<K extends string>(
  value: unknown,
  path: string,
  keys: readonly K[],
): Record<K, number> {
  const fields = expectMapping(value, path);
  rejectUnknownFields(fields, keys, path);
  return Object.fromEntries(
    keys.map((key) => [
      key,
      expectInteger(requireField(fields, key, path), fieldPath(path, key)),
    ]),
  ) as Record<K, number>;
}

/** A page's cell: `{ row, column }`. */
export function parseCell(value: unknown, path: string): Cell {
  const { row, column } = parseIntegerFields(value, path, ["row", "column"]);
  return { row, column };
}

/** A full location: `{ page, row, column }`, page at least 1. */
function parseLocation(value: unknown, path: string): Location {
  const { page, row, column } = parseIntegerFields(value, path, [
    "page",
    "row",
    "column",
  ]);
  if (page < 1)
    throw new ValidationError(
      fieldPath(path, "page"),
      `must be at least 1, got ${page}`,
    );
  return { page, row, column };
}

/** The prototype's `fg_for`: black text on a bright background, white otherwise. */
function defaultTextColor(background: number): number {
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
 * Parses a button description whose `location` is read by `parseLocationField`.
 * `prefix` is the path of `fields` when the button is embedded in another
 * description (for example `buttons[3]`).
 */
export function parseButtonDescription<L>(
  fields: Fields,
  prefix: string,
  parseLocationField: (value: unknown, path: string) => L,
): ButtonDescription<L> {
  const path = (key: string) => fieldPath(prefix, key);
  rejectUnknownFields(fields, TOP_LEVEL_FIELDS, prefix);
  const location = parseLocationField(
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

/** Parses a `kind: button` description (location with `page`, `row`, `column`). */
export function parseButton(fields: Fields, prefix = ""): ButtonPlan {
  return parseButtonDescription(fields, prefix, parseLocation);
}

/**
 * Every custom variable the button uses, in file order: references in its
 * text, its actions' targets and references, and its feedbacks' expressions
 * and style text. `prefix` is the one given to the parser.
 */
export function buttonVariableReferences(
  plan: ButtonContent,
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

export function readGridSize(db: DatabaseSync): GridSize {
  const userconfig = readJsonValue(db, "main", "userconfig");
  const grid = isJsonObject(userconfig) ? userconfig["gridSize"] : undefined;
  if (isJsonObject(grid)) {
    const size = grid;
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

/**
 * Refuses a cell outside the grid, naming `<prefix>.location.row` or
 * `.column` (`location.row` without a prefix).
 */
export function checkCellInGrid(grid: GridSize, cell: Cell, prefix = ""): void {
  const location = fieldPath(prefix, "location");
  checkInRange(fieldPath(location, "row"), cell.row, grid.minRow, grid.maxRow);
  checkInRange(
    fieldPath(location, "column"),
    cell.column,
    grid.minColumn,
    grid.maxColumn,
  );
}

/** Whether a page cell's value is a button control id, which a writer may delete. */
export function isButtonControlId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("bank:");
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

function buildButtonControl(plan: ButtonContent): Record<string, unknown> {
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

/** Inserts the button's control under a fresh id and returns the id. */
export function insertButtonControl(
  db: DatabaseSync,
  plan: ButtonContent,
): string {
  const id = freshId((candidate) => controlExists(db, candidate), "bank:");
  db.prepare("INSERT INTO controls (id, value) VALUES (?, ?)").run(
    id,
    JSON.stringify(buildButtonControl(plan)),
  );
  return id;
}
