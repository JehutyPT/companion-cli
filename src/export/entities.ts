/**
 * The inverse of src/writers/actions.ts, feedbacks.ts and children.ts: a
 * stored action or feedback to its description entry. Shared by every export
 * that holds entities (buttons, pages and triggers).
 *
 * A stored action takes the first rule that applies:
 *
 *  1. internal `custom_variable_set_value` with options exactly `name` and
 *     `value`, `name` a plain valid variable name, no `storeResult` and no
 *     child entries: a plain string value is `set`; `$(this:current) + N` /
 *     `- N` is `increment` / `decrement` (`by` omitted when 1); any other
 *     non-empty expression is `expression`;
 *  2. otherwise `passthrough`, with `options` omitted when empty, an
 *     expression option as `{expr: …}`, `storeResult` as `store` and
 *     non-empty `children` as `children`.
 *
 * A stored feedback is `step` (internal `bank_current_step` on
 * `$(this:location)`) or `expression` (internal `check_expression`) when its
 * options are exactly what those kinds write and it has no child entries,
 * otherwise `passthrough`. Its `styleOverrides` become the `style` mapping
 * when that reproduces them exactly (`box0.color`, `text0.color`,
 * `text0.text`, in that order, plain values the shortcuts can give back),
 * otherwise a list of literal overrides; none when empty. An expression
 * `isInverted` becomes `invert: {expr: …}`.
 *
 * Every entity's `headline`, `disabled`, `upgradeIndex` (and a feedback's
 * `variableName`) are emitted when present. The mapping is not trusted: the
 * caller's self-check rebuilds the entity with the writer's code and refuses
 * any difference (an unknown key, for example).
 */
import { CliError } from "../core/errors.ts";
import { type Fields, isJsonObject } from "../core/validate.ts";
import { STORED_STORE_TYPES } from "../writers/actions.ts";
import { STYLE_FIELDS } from "../writers/feedbacks.ts";
import { isExpressionMapping, parseVariableName } from "../writers/shared.ts";
import type { Area } from "../support-matrix.ts";
import { describeStored, refuse } from "./export.ts";

/** What apply's `increment` and `decrement` store, with N a safe positive integer. */
const STEP = /^\$\(this:current\) ([+-]) ([1-9]\d{0,14})$/;

export interface StoredOption {
  value: unknown;
  isExpression: boolean;
}

/** A wrapped option exactly as the writers store one. */
export function isOption(value: unknown): value is StoredOption {
  return (
    isJsonObject(value) &&
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, "value") &&
    typeof value["isExpression"] === "boolean"
  );
}

/** A wrapped, non-expression value at `path`, refused otherwise. */
export function plainValue(stored: unknown, path: string, area: Area): unknown {
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

/**
 * A wrapped value as a description value: a plain value as itself, an
 * expression as `{expr: …}`.
 */
function optionValue(stored: unknown, path: string, area: Area): unknown {
  if (!isOption(stored))
    refuse(path, "is not a {value, isExpression} option", area);
  if (stored.isExpression) {
    if (typeof stored.value !== "string")
      refuse(
        `${path}.value`,
        `is ${describeStored(stored.value)}, not an expression's text`,
        area,
      );
    return { expr: stored.value };
  }
  if (isExpressionMapping(stored.value))
    refuse(
      `${path}.value`,
      "is a plain mapping with exactly the key expr, which a description would read as an expression",
      area,
    );
  return stored.value;
}

/** A stored color integer as `#RRGGBB`. */
export function color(value: unknown, path: string, area: Area): string {
  if (!isColor(value))
    refuse(
      path,
      `is ${typeof value === "number" ? value : describeStored(value)}, not a 24-bit RGB color`,
      area,
    );
  return `#${value.toString(16).toUpperCase().padStart(6, "0")}`;
}

function isColor(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 0xffffff
  );
}

/** Why a stored text cannot be description text, if it cannot. */
function textProblem(value: string): string | undefined {
  if (value.includes("\n"))
    return "holds a line-feed character, which apply would store as a line break (\\n)";
  if (value.endsWith("\\n"))
    return "ends in a line break (\\n), which a description cannot keep: apply drops one trailing line break";
  return undefined;
}

/**
 * A stored button text as description text: literal backslash-n becomes a
 * line break. Refuses what `parseText` cannot give back.
 */
export function text(value: unknown, path: string, area: Area): string {
  if (typeof value !== "string")
    refuse(path, `is ${describeStored(value)}, not a string`, area);
  const problem = textProblem(value);
  if (problem) refuse(path, problem, area);
  return value.replaceAll("\\n", "\n");
}

function isVariableName(value: unknown): value is string {
  try {
    parseVariableName(value, "");
    return true;
  } catch (error) {
    if (error instanceof CliError) return false;
    throw error;
  }
}

/** Whether the stored entity has child entries (not just empty or no groups). */
function hasChildren(stored: Fields): boolean {
  const children = stored["children"];
  if (children === undefined) return false;
  if (!isJsonObject(children)) return true;
  return Object.keys(children).length > 0;
}

/** The common fields, each when present. */
function commonFields(stored: Fields, feedback: boolean): Fields {
  const keys = ["headline", "disabled", "upgradeIndex"];
  if (feedback) keys.push("variableName");
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(stored, key))
      .map((key) => [key, stored[key]]),
  );
}

/** Rule 1, when it applies. */
function variableAction(stored: Fields, options: Fields): Fields | undefined {
  if (
    stored["connectionId"] !== "internal" ||
    stored["definitionId"] !== "custom_variable_set_value" ||
    Object.hasOwn(stored, "storeResult") ||
    hasChildren(stored)
  )
    return undefined;
  const keys = Object.keys(options).sort();
  if (keys.length !== 2 || keys[0] !== "name" || keys[1] !== "value")
    return undefined;
  const { name, value } = options;
  if (!isOption(name) || name.isExpression || !isVariableName(name.value))
    return undefined;
  if (!isOption(value) || typeof value.value !== "string") return undefined;
  const variable = name.value;
  if (!value.isExpression)
    return { action: "set", variable, value: value.value };
  const step = STEP.exec(value.value);
  if (step) {
    const by = Number(step[2]);
    return {
      action: step[1] === "+" ? "increment" : "decrement",
      variable,
      ...(by === 1 ? {} : { by }),
    };
  }
  if (value.value === "") return undefined;
  return { action: "expression", variable, expression: value.value };
}

/** The stored entity's options, refused unless a mapping. */
function storedOptions(stored: Fields, path: string, area: Area): Fields {
  const options = stored["options"];
  if (!isJsonObject(options))
    refuse(
      `${path}.options`,
      `is ${describeStored(options)}, not a mapping`,
      area,
    );
  return options;
}

/** A pass-through entry's connection, definition, options and children. */
function passthrough(
  tag: "action" | "feedback",
  stored: Fields,
  options: Fields,
  path: string,
): Fields {
  const { connectionId, definitionId } = stored;
  if (typeof connectionId !== "string" || connectionId === "")
    refuse(`${path}.connectionId`, "is not a connection id", tag);
  if (typeof definitionId !== "string" || definitionId === "")
    refuse(`${path}.definitionId`, "is not a definition id", tag);
  const values = Object.fromEntries(
    Object.entries(options).map(([key, option]) => [
      key,
      optionValue(option, `${path}.options.${key}`, tag),
    ]),
  );
  return {
    [tag]: "passthrough",
    connection: connectionId,
    definition: definitionId,
    ...(Object.keys(values).length > 0 ? { options: values } : {}),
  };
}

/** Non-empty stored `children` as description child groups. */
function exportChildren(stored: Fields, path: string, area: Area): Fields {
  if (!hasChildren(stored)) return {};
  const children = stored["children"];
  const childrenPath = `${path}.children`;
  if (!isJsonObject(children))
    refuse(childrenPath, `is ${describeStored(children)}, not a mapping`, area);
  return {
    children: Object.fromEntries(
      Object.entries(children).map(([group, list]) => {
        const groupPath = `${childrenPath}.${group}`;
        if (!Array.isArray(list))
          refuse(groupPath, `is ${describeStored(list)}, not a list`, area);
        return [
          group,
          list.map((child, index) =>
            exportEntity(child, `${groupPath}[${index}]`, area),
          ),
        ];
      }),
    ),
  };
}

/** A child entity, by its stored `type`. */
function exportEntity(stored: unknown, path: string, area: Area): Fields {
  const type = isJsonObject(stored) ? stored["type"] : undefined;
  if (type === "action") return exportAction(stored, path);
  if (type === "feedback") return exportFeedback(stored, path);
  return refuse(
    path,
    `is ${describeStored(stored)}, not an action or a feedback`,
    area,
  );
}

/** The description `store.type` of each stored `storeResult.type`: the writer's table inverted. */
const STORE_TYPES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(STORED_STORE_TYPES).map(([type, stored]) => [stored, type]),
);

/** A stored `storeResult` as `store`. */
function exportStore(stored: Fields, path: string): Fields {
  if (!Object.hasOwn(stored, "storeResult")) return {};
  const result = stored["storeResult"];
  const at = `${path}.storeResult`;
  if (!isJsonObject(result))
    refuse(at, `is ${describeStored(result)}, not a mapping`, "action");
  const type = STORE_TYPES[String(result["type"])];
  if (type === undefined)
    refuse(
      `${at}.type`,
      `is ${JSON.stringify(result["type"] ?? null)}, not one of ${Object.keys(STORE_TYPES).join(", ")}`,
      "action",
    );
  const value = (key: string) =>
    optionValue(result[key], `${at}.${key}`, "action");
  const store: Fields = { type, variable: value("variableName") };
  if (type === "custom") {
    const create = result["createIfNotExists"];
    if (typeof create !== "boolean")
      refuse(
        `${at}.createIfNotExists`,
        `is ${describeStored(create)}, not a boolean`,
        "action",
      );
    if (create) store["create"] = true;
  } else if (type === "local") store["location"] = value("location");
  else store["page"] = value("page");
  return { store };
}

/** One stored action at `path` (`actions[2]`) as an action entry. */
export function exportAction(stored: unknown, path: string): Fields {
  if (!isJsonObject(stored))
    refuse(path, `is ${describeStored(stored)}, not an action`, "action");
  const options = storedOptions(stored, path, "action");
  const common = commonFields(stored, false);
  const named = variableAction(stored, options);
  if (named) return { ...named, ...common };
  return {
    ...passthrough("action", stored, options, path),
    ...common,
    ...exportStore(stored, path),
    ...exportChildren(stored, path, "action"),
  };
}

/** The `step` or `expression` feedback, when the stored one is exactly that. */
function namedFeedback(stored: Fields, options: Fields): Fields | undefined {
  if (stored["connectionId"] !== "internal" || hasChildren(stored))
    return undefined;
  const keys = Object.keys(options).sort().join();
  if (stored["definitionId"] === "bank_current_step") {
    const { step, location } = options;
    if (
      keys === "location,step" &&
      isOption(step) &&
      !step.isExpression &&
      isOption(location) &&
      !location.isExpression &&
      location.value === "$(this:location)"
    )
      return { feedback: "step", step: step.value };
  }
  if (stored["definitionId"] === "check_expression") {
    const { expression } = options;
    if (
      keys === "expression" &&
      isOption(expression) &&
      expression.isExpression &&
      typeof expression.value === "string" &&
      expression.value !== ""
    )
      return { feedback: "expression", expression: expression.value };
  }
  return undefined;
}

type StyleName = keyof typeof STYLE_FIELDS;
const STYLE_NAMES = Object.keys(STYLE_FIELDS) as StyleName[];

/** The style mapping, when it gives back exactly these overrides. */
function styleMapping(overrides: readonly Fields[]): Fields | undefined {
  const style: Fields = {};
  let next = 0;
  for (const override of overrides) {
    const index = STYLE_NAMES.findIndex(
      (name) =>
        STYLE_FIELDS[name][0] === override["elementId"] &&
        STYLE_FIELDS[name][1] === override["elementProperty"],
    );
    if (index < next) return undefined;
    next = index + 1;
    const name = STYLE_NAMES[index] as StyleName;
    const stored = override["override"];
    if (!isOption(stored) || stored.isExpression) return undefined;
    const value = stored.value;
    if (name === "text") {
      if (typeof value !== "string" || textProblem(value)) return undefined;
      style[name] = value.replaceAll("\\n", "\n");
    } else {
      if (!isColor(value)) return undefined;
      style[name] = color(value, "", "feedback");
    }
  }
  return style;
}

/** Stored `styleOverrides` as `style`: none, the mapping, or a list. */
function exportStyle(stored: Fields, path: string): Fields {
  const overrides = stored["styleOverrides"];
  const at = `${path}.styleOverrides`;
  if (overrides === undefined) return {};
  if (!Array.isArray(overrides))
    refuse(at, `is ${describeStored(overrides)}, not a list`, "feedback");
  if (overrides.length === 0) return {};
  const entries = overrides.map((override, index) => {
    if (!isJsonObject(override))
      refuse(
        `${at}[${index}]`,
        `is ${describeStored(override)}, not a style override`,
        "feedback",
      );
    return override;
  });
  const mapping = styleMapping(entries);
  if (mapping) return { style: mapping };
  return {
    style: entries.map((override, index) => ({
      element: override["elementId"],
      property: override["elementProperty"],
      value: optionValue(
        override["override"],
        `${at}[${index}].override`,
        "feedback",
      ),
    })),
  };
}

/** A stored `isInverted` as `invert`: left out when false. */
function exportInvert(stored: Fields, path: string): Fields {
  if (!Object.hasOwn(stored, "isInverted")) return {};
  const invert = optionValue(
    stored["isInverted"],
    `${path}.isInverted`,
    "feedback",
  );
  return invert === false ? {} : { invert };
}

/** One stored feedback at `path` (`feedbacks[0]`) as a feedback entry. */
export function exportFeedback(stored: unknown, path: string): Fields {
  if (!isJsonObject(stored))
    refuse(path, `is ${describeStored(stored)}, not a feedback`, "feedback");
  const options = storedOptions(stored, path, "feedback");
  return {
    ...(namedFeedback(stored, options) ??
      passthrough("feedback", stored, options, path)),
    ...exportStyle(stored, path),
    ...exportInvert(stored, path),
    ...commonFields(stored, true),
    ...exportChildren(stored, path, "feedback"),
  };
}

/** The entry at `index` of a description list, if any. */
function item(list: unknown, index: number): unknown {
  return Array.isArray(list) ? (list[index] as unknown) : undefined;
}

/**
 * A description path inside an entity list, `[i]<rest>`, as a stored path
 * suffix. `list` is the description list, which tells each entry's kind.
 */
export function entityListPath(list: unknown, rest: string): string {
  const match = /^\[(\d+)\](.*)$/.exec(rest);
  if (!match) return rest;
  const index = Number(match[1]);
  return `[${index}]${entityPath(item(list, index), match[2] ?? "")}`;
}

/**
 * A description path inside one entity entry (`.variable`, `.store.create`,
 * `.children.actions[1].options.x`) as a stored path suffix.
 */
function entityPath(entry: unknown, rest: string): string {
  const fields = isJsonObject(entry) ? entry : {};
  const child = /^\.children\.([^.[]+)(.*)$/.exec(rest);
  if (child) {
    const groups = fields["children"];
    const group = child[1] as string;
    return `.children.${group}${entityListPath(
      isJsonObject(groups) ? groups[group] : undefined,
      child[2] ?? "",
    )}`;
  }
  const head = /^\.(\w+)(.*)$/.exec(rest);
  if (!head) return rest;
  const key = head[1] as string;
  const tail = head[2] ?? "";
  switch (key) {
    case "action":
    case "feedback":
      return "";
    case "variable":
      return ".options.name";
    case "value":
    case "by":
      return ".options.value";
    case "expression":
      return Object.hasOwn(fields, "feedback")
        ? ".options.expression"
        : ".options.value";
    case "step":
      return ".options.step";
    case "connection":
      return ".connectionId";
    case "definition":
      return ".definitionId";
    case "invert":
      return ".isInverted";
    case "store":
      return `.storeResult${tail
        .replace(/^\.variable$/, ".variableName")
        .replace(/^\.create$/, ".createIfNotExists")}`;
    case "style":
      return `.styleOverrides${styleTail(fields["style"], tail)}`;
    default:
      return rest;
  }
}

/** A path inside a `style` list as a path inside `styleOverrides`. */
function styleTail(style: unknown, tail: string): string {
  if (!Array.isArray(style)) return "";
  const match = /^(\[\d+\])\.(\w+)/.exec(tail);
  if (!match) return tail;
  const stored = { element: "elementId", property: "elementProperty" }[
    match[2] as string
  ];
  return `${match[1]}.${stored ?? "override"}`;
}
