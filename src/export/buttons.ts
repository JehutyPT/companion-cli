/**
 * The inverse of src/writers/button-control.ts: a stored `button-layered`
 * control to the fields of a button description (everything but `location`).
 * Shared by `export page` (each cell) and `export page --button`.
 *
 * Only the free parts of the writer's template are read: the control type,
 * the button options, `box0.color`, `text0.color` and `text0.text`, each
 * step's action sets (the four named ones and the hold sets) and
 * `runWhileHeld`, and the feedbacks. Everything else is left to the caller's
 * self-check, which rebuilds the control with the writer's
 * `buildButtonControl` and refuses any difference (a changed `fontsize`, a
 * fifth layer, an action's `disabled`).
 *
 * Emission: `text`, `background` and always `textColor`; `progression`,
 * `stepExpression`, `notes` and `apiStyle` only when they differ from the
 * description defaults. One step gives top-level `down`, `up`,
 * `rotate_left`, `rotate_right` and `hold`; several give `steps`. Empty lists
 * are left out, except `rotate_left: []` (top level, or on the first step)
 * when rotary actions are on and no rotate list has any. Hold entries come
 * in ascending `after`, except that the while-held ones keep the stored
 * `runWhileHeld` order among themselves, so the build reproduces it.
 */
import type { DatabaseSync } from "node:sqlite";
import { type Fields, isJsonObject } from "../core/validate.ts";
import type { Area } from "../support-matrix.ts";
import {
  ACTION_SETS,
  type ButtonPlan,
  buildButtonControl,
  type Cell,
  type Location,
  parseButtonDescription,
  parseCell,
  PROGRESSIONS,
} from "../writers/button-control.ts";
import { buttonWriter } from "../writers/button.ts";
import { STYLE_FIELDS } from "../writers/feedbacks.ts";
import { exportAction, isOption } from "./actions.ts";
import {
  describeStored,
  REASON_UNSUPPORTED,
  refuse,
  selfCheck,
} from "./export.ts";

/** The support-matrix area of a path inside a stored button control. */
export function buttonArea(path: string): Area {
  if (path === "" || path === "type") return "control type";
  if (path.startsWith("options")) return "button option";
  if (path.startsWith("localVariables")) return "local variable";
  if (
    /^steps\.\d+\.action_sets\.(down|up|rotate_left|rotate_right|\d+)\[/.test(
      path,
    )
  )
    return "action";
  if (path.startsWith("steps")) return "step";
  if (path.startsWith("style")) return "style";
  if (path.startsWith("feedbacks")) return "feedback";
  return "button";
}

/** An action's or feedback's description field as its stored field. */
function entityField(path: string): string {
  return path
    .replace(/\.variable$/, ".options.name")
    .replace(/\.(value|by)$/, ".options.value")
    .replace(/\.connection$/, ".connectionId")
    .replace(/\.definition$/, ".definitionId");
}

/**
 * Where the writer's four-layer template stores each style field, and where
 * each button option goes.
 */
const FIELD_PATHS: Readonly<Record<string, string>> = {
  text: "style.layers[3].text.value",
  background: "style.layers[1].color.value",
  textColor: "style.layers[3].color.value",
  progression: "options.stepProgression",
  stepExpression: "options.stepExpression",
  notes: "options.notes",
  apiStyle: "options.canModifyStyleInApis",
};

/**
 * A hold entry's field as a stored path: the entry names the action set of
 * its duration (`after`); without one, the step's action sets.
 */
function holdStoredPath(
  step: number,
  hold: Fields | undefined,
  rest: string,
): string {
  const after = hold?.["after"];
  const sets = `steps.${step}.action_sets`;
  if (typeof after !== "number") return sets;
  if (rest === ".whileHeld") return `steps.${step}.options.runWhileHeld`;
  const actions = /^\.actions(\[\d+\].*)?$/.exec(rest);
  if (actions?.[1])
    return entityField(`${sets}.${after}${actions[1]}`).replace(
      /(action_sets\.\d+\[\d+\])\.expression$/,
      "$1.options.value",
    );
  return `${sets}.${after}`;
}

/** The hold entry at `index` of a step's or the button's fields, if any. */
function holdEntry(fields: unknown, index: number): Fields | undefined {
  const list = isJsonObject(fields) ? fields["hold"] : undefined;
  const entry = Array.isArray(list) ? (list[index] as unknown) : undefined;
  return isJsonObject(entry) ? entry : undefined;
}

/**
 * A button description field path (no prefix) as a stored control path.
 * `fields`, the description, resolves a hold entry to its duration.
 */
export function buttonStoredPath(field: string, fields: Fields = {}): string {
  const style = FIELD_PATHS[field];
  if (style !== undefined) return style;
  const topHold = /^hold\[(\d+)\](.*)$/.exec(field);
  if (topHold)
    return holdStoredPath(
      0,
      holdEntry(fields, Number(topHold[1])),
      topHold[2] ?? "",
    );
  const stepHold = /^steps\[(\d+)\]\.hold\[(\d+)\](.*)$/.exec(field);
  if (stepHold) {
    const steps = fields["steps"];
    const step = Array.isArray(steps)
      ? (steps[Number(stepHold[1])] as unknown)
      : undefined;
    return holdStoredPath(
      Number(stepHold[1]),
      holdEntry(step, Number(stepHold[2])),
      stepHold[3] ?? "",
    );
  }
  if (field === "hold") return "steps.0.action_sets";
  const stepHoldList = /^steps\[(\d+)\]\.hold$/.exec(field);
  if (stepHoldList) return `steps.${stepHoldList[1]}.action_sets`;
  const top = /^(down|up|rotate_left|rotate_right)(.*)$/.exec(field);
  if (top) return entityField(`steps.0.action_sets.${top[1]}${top[2]}`);
  const step =
    /^steps\[(\d+)\]\.?(down|up|rotate_left|rotate_right)?(.*)$/.exec(field);
  if (step)
    return step[2]
      ? entityField(
          `steps.${step[1]}.action_sets.${step[2]}${step[3]}`.replace(
            /(action_sets\.\w+\[\d+\])\.expression$/,
            "$1.options.value",
          ),
        )
      : `steps.${step[1]}`;
  if (field.startsWith("feedbacks"))
    return entityField(
      field
        .replace(/^(feedbacks\[\d+\])\.(step|expression)$/, "$1.options.$2")
        .replace(/^(feedbacks\[\d+\])\.style.*$/, "$1.styleOverrides")
        .replace(/^(feedbacks\[\d+\])\.invert$/, "$1.isInverted"),
    );
  if (field === "steps") return "steps";
  return field.replace(/^(\w+)\[(\d+)\]\.expression$/, "$1[$2].options.value");
}

/** A wrapped, non-expression value at `path`, refused otherwise. */
function plainValue(stored: unknown, path: string, area: Area): unknown {
  if (!isOption(stored))
    refuse(path, "is not a {value, isExpression} property", area);
  if (stored.isExpression)
    refuse(
      path,
      "is an expression, which the description format does not support here",
      area,
    );
  return stored.value;
}

/** A stored color integer as `#RRGGBB`. */
function color(value: unknown, path: string, area: Area): string {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffffff
  )
    refuse(
      path,
      `is ${typeof value === "number" ? value : describeStored(value)}, not a 24-bit RGB color`,
      area,
    );
  return `#${value.toString(16).toUpperCase().padStart(6, "0")}`;
}

/**
 * A stored button text as description text: literal backslash-n becomes a
 * line break. Refuses what `parseText` cannot give back.
 */
function text(value: unknown, path: string, area: Area): string {
  if (typeof value !== "string")
    refuse(path, `is ${describeStored(value)}, not a string`, area);
  if (value.includes("\n"))
    refuse(
      path,
      "holds a line-feed character, which apply would store as a line break (\\n)",
      area,
    );
  if (value.endsWith("\\n"))
    refuse(
      path,
      "ends in a line break (\\n), which a description cannot keep: apply drops one trailing line break",
      area,
    );
  return value.replaceAll("\\n", "\n");
}

/** The index of the layer with `id`, refused when missing. */
function layerIndex(layers: unknown[], id: string): number {
  const index = layers.findIndex(
    (layer) => isJsonObject(layer) && layer["id"] === id,
  );
  if (index < 0) refuse("style.layers", `has no ${id} layer`, "style");
  return index;
}

/** A layer property's plain value, at its stored path. */
function layerValue(
  layers: unknown[],
  id: string,
  property: string,
): { value: unknown; path: string } {
  const index = layerIndex(layers, id);
  const path = `style.layers[${index}].${property}`;
  const layer = layers[index] as Fields;
  return { value: plainValue(layer[property], path, "style"), path };
}

/** The style field a feedback override's element and property stand for. */
function styleField(
  elementId: unknown,
  elementProperty: unknown,
): keyof typeof STYLE_FIELDS | undefined {
  return (Object.keys(STYLE_FIELDS) as (keyof typeof STYLE_FIELDS)[]).find(
    (name) =>
      STYLE_FIELDS[name][0] === elementId &&
      STYLE_FIELDS[name][1] === elementProperty,
  );
}

function exportStyle(overrides: unknown, path: string): Fields {
  if (!Array.isArray(overrides))
    refuse(
      path,
      `is ${describeStored(overrides)}; only boolean feedbacks, which override style, are supported`,
      "feedback",
    );
  if (overrides.length === 0)
    refuse(
      path,
      "is empty; a feedback that overrides no style is not supported",
      "feedback",
    );
  const style: Fields = {};
  overrides.forEach((override, index) => {
    const at = `${path}[${index}]`;
    if (!isJsonObject(override))
      refuse(
        at,
        `is ${describeStored(override)}, not a style override`,
        "feedback",
      );
    const name = styleField(override["elementId"], override["elementProperty"]);
    if (name === undefined)
      refuse(
        at,
        `overrides ${String(override["elementId"])}.${String(override["elementProperty"])}; only box0.color, text0.color and text0.text are supported`,
        "feedback",
      );
    if (Object.hasOwn(style, name))
      refuse(at, `overrides ${name} a second time`, "feedback");
    const valuePath = `${at}.override`;
    const value = plainValue(override["override"], valuePath, "style");
    style[name] =
      name === "text"
        ? text(value, `${valuePath}.value`, "style")
        : color(value, `${valuePath}.value`, "style");
  });
  return style;
}

/** The feedback kind and its fields, from the stored entity. */
function feedbackKind(stored: Fields, path: string): Fields {
  const { connectionId, definitionId } = stored;
  const options = stored["options"];
  if (!isJsonObject(options))
    refuse(
      `${path}.options`,
      `is ${describeStored(options)}, not a mapping`,
      "feedback",
    );
  const keys = Object.keys(options).sort();
  if (connectionId === "internal" && definitionId === "bank_current_step") {
    const { step, location } = options;
    if (
      keys.join() === "location,step" &&
      isOption(step) &&
      !step.isExpression &&
      isOption(location) &&
      !location.isExpression &&
      location.value === "$(this:location)"
    )
      return { feedback: "step", step: step.value };
  }
  if (connectionId === "internal" && definitionId === "check_expression") {
    const { expression } = options;
    if (
      keys.join() === "expression" &&
      isOption(expression) &&
      expression.isExpression &&
      typeof expression.value === "string" &&
      expression.value !== ""
    )
      return { feedback: "expression", expression: expression.value };
  }
  if (typeof connectionId !== "string" || connectionId === "")
    refuse(`${path}.connectionId`, "is not a connection id", "feedback");
  if (typeof definitionId !== "string" || definitionId === "")
    refuse(`${path}.definitionId`, "is not a definition id", "feedback");
  const plain: Fields = {};
  for (const [key, option] of Object.entries(options)) {
    const optionPath = `${path}.options.${key}`;
    if (!isOption(option))
      refuse(optionPath, "is not a {value, isExpression} option", "feedback");
    if (option.isExpression)
      refuse(
        optionPath,
        "is an expression, which the description format supports only in step and expression feedbacks",
        "feedback",
      );
    plain[key] = option.value;
  }
  return {
    feedback: "passthrough",
    connection: connectionId,
    definition: definitionId,
    ...(Object.keys(plain).length > 0 ? { options: plain } : {}),
  };
}

function exportFeedback(stored: unknown, path: string): Fields {
  if (!isJsonObject(stored))
    refuse(path, `is ${describeStored(stored)}, not a feedback`, "feedback");
  const style = exportStyle(stored["styleOverrides"], `${path}.styleOverrides`);
  const inverted = stored["isInverted"];
  if (
    !isOption(inverted) ||
    inverted.isExpression ||
    typeof inverted.value !== "boolean"
  )
    refuse(
      `${path}.isInverted`,
      "is not a plain true or false; only a fixed invert is supported",
      "feedback",
    );
  return {
    ...feedbackKind(stored, path),
    style,
    ...(inverted.value ? { invert: true } : {}),
  };
}

type ActionSet = (typeof ACTION_SETS)[number];

/** One stored step: its four named action lists and its hold entries. */
interface ExportedStep {
  sets: Record<ActionSet, Fields[]>;
  hold: Fields[];
}

/** A stored hold set key: a positive whole number of milliseconds. */
const HOLD_KEY = /^[1-9]\d*$/;

/**
 * The step's hold entries, from its numeric action sets and `runWhileHeld`:
 * ascending `after`, with the while-held entries in `runWhileHeld` order.
 */
function exportHold(key: string, sets: Fields, options: Fields): Fields[] {
  const durations = Object.keys(sets)
    .filter((set) => !(ACTION_SETS as readonly string[]).includes(set))
    .map((set) => {
      const value = Number(set);
      if (!HOLD_KEY.test(set) || !Number.isSafeInteger(value))
        refuse(
          `steps.${key}.action_sets.${set}`,
          "is not a hold set keyed by a positive whole number of milliseconds",
          "step",
        );
      return value;
    })
    .sort((a, b) => a - b);
  const held = options["runWhileHeld"];
  const heldPath = `steps.${key}.options.runWhileHeld`;
  if (!Array.isArray(held))
    refuse(heldPath, `is ${describeStored(held)}, not a list`, "step");
  held.forEach((duration, index) => {
    if (
      typeof duration !== "number" ||
      !durations.includes(duration) ||
      held.indexOf(duration) !== index
    )
      refuse(
        `${heldPath}[${index}]`,
        `is ${JSON.stringify(duration)}, which names no hold set of the step or repeats one`,
        "step",
      );
  });
  const whileHeld = held as number[];
  let next = 0;
  return durations
    .map((duration) =>
      whileHeld.includes(duration) ? (whileHeld[next++] as number) : duration,
    )
    .map((after) => {
      const path = `steps.${key}.action_sets.${after}`;
      const list = sets[String(after)];
      if (!Array.isArray(list))
        refuse(path, `is ${describeStored(list)}, not a list`, "step");
      return {
        after,
        ...(whileHeld.includes(after) ? { whileHeld: true } : {}),
        actions: list.map((action, index) =>
          exportAction(action, `${path}[${index}]`),
        ),
      };
    });
}

/** Each step's four action lists and hold entries, as description entries. */
function exportSteps(steps: unknown): ExportedStep[] {
  if (!isJsonObject(steps))
    refuse("steps", `is ${describeStored(steps)}, not a mapping`, "step");
  const keys = Object.keys(steps);
  if (keys.length === 0 || keys.some((key, index) => key !== String(index)))
    refuse(
      "steps",
      `has keys ${JSON.stringify(keys)}; a description stores steps "0", "1", … in order`,
      "step",
    );
  return keys.map((key) => {
    const step = steps[key];
    const sets = isJsonObject(step) ? step["action_sets"] : undefined;
    if (!isJsonObject(sets))
      refuse(
        `steps.${key}.action_sets`,
        `is ${describeStored(sets)}, not a mapping`,
        "step",
      );
    const options = isJsonObject(step) ? step["options"] : undefined;
    if (!isJsonObject(options))
      refuse(
        `steps.${key}.options`,
        `is ${describeStored(options)}, not a mapping`,
        "step",
      );
    const other = Object.keys(options).find((name) => name !== "runWhileHeld");
    if (other !== undefined)
      refuse(`steps.${key}.options.${other}`, REASON_UNSUPPORTED, "step");
    return {
      sets: Object.fromEntries(
        ACTION_SETS.map((set) => {
          const path = `steps.${key}.action_sets.${set}`;
          const list = sets[set] ?? [];
          if (!Array.isArray(list))
            refuse(path, `is ${describeStored(list)}, not a list`, "step");
          return [
            set,
            list.map((action, index) =>
              exportAction(action, `${path}[${index}]`),
            ),
          ];
        }),
      ) as Record<ActionSet, Fields[]>,
      hold: exportHold(key, sets, options),
    };
  });
}

/** One step's non-empty lists, in the writer's order, then its hold entries. */
function nonEmpty({ sets, hold }: ExportedStep): Fields {
  return {
    ...Object.fromEntries(
      ACTION_SETS.filter((set) => sets[set].length > 0).map((set) => [
        set,
        sets[set],
      ]),
    ),
    ...(hold.length > 0 ? { hold } : {}),
  };
}

/**
 * The options' description fields, each only when it differs from the
 * default. A stale `stepExpression` (kept by Companion after the
 * progression changed) and an empty one with expression progression are
 * refused; other differences are left to the self-check.
 */
function exportOptions(options: Fields): Fields {
  const progression = options["stepProgression"];
  if (!(PROGRESSIONS as readonly unknown[]).includes(progression))
    refuse(
      "options.stepProgression",
      `is ${JSON.stringify(progression ?? null)}, not one of ${PROGRESSIONS.join(", ")}`,
      "button option",
    );
  const expression = options["stepExpression"];
  if (
    progression !== "expression" &&
    typeof expression === "string" &&
    expression !== ""
  )
    refuse(
      "options.stepExpression",
      `is set while options.stepProgression is ${JSON.stringify(progression)}, which a description cannot express`,
      "button option",
    );
  if (progression === "expression" && expression === "")
    refuse(
      "options.stepExpression",
      'is empty while options.stepProgression is "expression", which a description cannot express',
      "button option",
    );
  const notes = options["notes"];
  return {
    ...(progression !== "auto" ? { progression } : {}),
    ...(progression === "expression" ? { stepExpression: expression } : {}),
    ...(typeof notes === "string" && notes !== "" ? { notes } : {}),
    ...(options["canModifyStyleInApis"] === true ? { apiStyle: true } : {}),
  };
}

/**
 * The description fields of a stored button control, except `location`.
 * Throws `ExportRefusal` naming the stored path. Not yet self-checked.
 */
export function buttonFields(control: unknown): Fields {
  if (!isJsonObject(control))
    refuse("", `is ${describeStored(control)}, not a control`, "control type");
  const type = control["type"];
  if (type !== "button-layered")
    refuse(
      "type",
      `is ${JSON.stringify(type ?? null)}: the cell holds a ${String(type)} control, which a description cannot express`,
      "control type",
    );
  const options = control["options"];
  if (!isJsonObject(options))
    refuse(
      "options",
      `is ${describeStored(options)}, not a mapping`,
      "button option",
    );
  const rotary = options["rotaryActions"];
  if (typeof rotary !== "boolean")
    refuse(
      "options.rotaryActions",
      `is ${describeStored(rotary)}, not true or false`,
      "button option",
    );

  const style = control["style"];
  const layers = isJsonObject(style) ? style["layers"] : undefined;
  if (!Array.isArray(layers))
    refuse("style.layers", `is ${describeStored(layers)}, not a list`, "style");
  const background = layerValue(layers, "box0", "color");
  const textColor = layerValue(layers, "text0", "color");
  const label = layerValue(layers, "text0", "text");

  const steps = exportSteps(control["steps"]);
  const rotateList = steps
    .flatMap(({ sets }, index) =>
      (["rotate_left", "rotate_right"] as const)
        .filter((set) => sets[set].length > 0)
        .map((set) => `steps.${index}.action_sets.${set}`),
    )
    .at(0);
  if (!rotary && rotateList !== undefined)
    refuse(
      rotateList,
      "lists actions while options.rotaryActions is false, which a description cannot express",
      "button option",
    );

  const feedbacks = control["feedbacks"];
  if (!Array.isArray(feedbacks))
    refuse(
      "feedbacks",
      `is ${describeStored(feedbacks)}, not a list`,
      "feedback",
    );

  const lists = steps.map(nonEmpty);
  if (rotary && rotateList === undefined)
    (lists[0] as Fields)["rotate_left"] = [];
  return {
    text: text(label.value, `${label.path}.value`, "style"),
    background: color(background.value, `${background.path}.value`, "style"),
    textColor: color(textColor.value, `${textColor.path}.value`, "style"),
    ...exportOptions(options),
    ...(lists.length === 1 ? lists[0] : { steps: lists }),
    ...(feedbacks.length > 0
      ? {
          feedbacks: feedbacks.map((feedback, index) =>
            exportFeedback(feedback, `feedbacks[${index}]`),
          ),
        }
      : {}),
  };
}

/**
 * A page cell's button entry (`location: {row, column}`), self-checked
 * against the stored control with the writer's parse and build.
 */
export function cellButton(control: unknown, cell: Cell): Fields {
  const fields: Fields = {
    location: { row: cell.row, column: cell.column },
    ...buttonFields(control),
  };
  selfCheck({
    stored: control,
    parse: () => parseButtonDescription(fields, "", parseCell),
    build: buildButtonControl,
    storedPath: (field) => buttonStoredPath(field, fields),
    area: buttonArea,
  });
  return fields;
}

/**
 * A `kind: button` body for the control at `location`, self-checked with the
 * button writer's parse, check and build.
 */
export function locatedButton(
  db: DatabaseSync,
  control: unknown,
  location: Location,
): Fields {
  const fields: Fields = {
    location: { ...location },
    ...buttonFields(control),
  };
  selfCheck<ButtonPlan>({
    stored: control,
    parse: () => buttonWriter.parse(fields),
    check: (plan) => buttonWriter.check?.(db, plan),
    build: buildButtonControl,
    storedPath: (field) => buttonStoredPath(field, fields),
    area: buttonArea,
  });
  return fields;
}
