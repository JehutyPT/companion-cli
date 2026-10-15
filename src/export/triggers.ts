/**
 * `export trigger "<name>"` (one `kind: trigger` file) and
 * `export triggers [<pattern>...]` (one `kind: triggers` file, in
 * `sortOrder`, then id order). Triggers are read as the trigger writer reads
 * them (`readTriggers`). Each entry emits `name`, `enabled`, `events` and
 * `actions` (left out when empty).
 */
import type { DatabaseSync } from "node:sqlite";
import { CliError } from "../core/errors.ts";
import { type Fields, isJsonObject } from "../core/validate.ts";
import { bySortOrderThen } from "../readers/list.ts";
import type { Area } from "../support-matrix.ts";
import {
  buildTriggerControl,
  checkTrigger,
  parseTrigger,
  readTriggers,
  type StoredTrigger,
} from "../writers/trigger.ts";
import { exportAction } from "./actions.ts";
import {
  describeStored,
  type Exporter,
  refuse,
  selectByPatterns,
  selfCheck,
} from "./export.ts";

/** The support-matrix area of a stored trigger path. */
function area(path: string): Area {
  if (path.startsWith("options")) return "trigger option";
  if (path.startsWith("events")) return "event";
  if (path.startsWith("actions")) return "action";
  if (path.startsWith("condition")) return "condition";
  if (path.startsWith("localVariables")) return "local variable";
  return "trigger";
}

/** A description field path of a trigger body as a stored path. */
function storedPath(field: string): string {
  return field
    .replace(/^(name|enabled)$/, "options.$1")
    .replace(/^(events\[\d+\])\.variable$/, "$1.options.variableId")
    .replace(/^(events\[\d+\])\.(delay|seconds)$/, "$1.options.$2")
    .replace(/^(actions\[\d+\])\.variable$/, "$1.options.name")
    .replace(/^(actions\[\d+\])\.(value|expression|by)$/, "$1.options.value")
    .replace(/^(actions\[\d+\])\.options\./, "$1.options.");
}

function integerOption(
  options: Fields,
  key: string,
  path: string,
  min: number,
): number {
  const value = options[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    refuse(
      `${path}.options.${key}`,
      `is ${typeof value === "number" ? value : describeStored(value)}, not an integer of at least ${min}`,
      "event",
    );
  return value;
}

/** The inverse of the trigger writer's EVENT_KINDS, by stored event type. */
const EVENTS: Record<string, (options: Fields, path: string) => Fields> = {
  startup: (options, path) => ({
    event: "startup",
    delay: integerOption(options, "delay", path, 0),
  }),
  interval: (options, path) => ({
    event: "interval",
    seconds: integerOption(options, "seconds", path, 1),
  }),
  variable_changed: (options, path) => {
    const id = options["variableId"];
    if (typeof id !== "string" || !id.startsWith("custom:"))
      refuse(
        `${path}.options.variableId`,
        `is ${JSON.stringify(id ?? null)}; only custom variables are supported yet`,
        "event",
      );
    return { event: "variable_changed", variable: id.slice("custom:".length) };
  },
};

function exportEvent(stored: unknown, path: string): Fields {
  if (!isJsonObject(stored))
    refuse(path, `is ${describeStored(stored)}, not an event`, "event");
  const type = stored["type"];
  if (typeof type !== "string" || !Object.hasOwn(EVENTS, type))
    refuse(
      `${path}.type`,
      `is ${JSON.stringify(type ?? null)}, which the description format does not support yet`,
      "event",
    );
  if (stored["enabled"] !== true)
    refuse(
      `${path}.enabled`,
      `is ${JSON.stringify(stored["enabled"] ?? null)}; disabled events are not supported yet`,
      "event",
    );
  const options = stored["options"];
  if (!isJsonObject(options))
    refuse(
      `${path}.options`,
      `is ${describeStored(options)}, not a mapping`,
      "event",
    );
  return (EVENTS[type] as (typeof EVENTS)[string])(options, path);
}

function list(control: Fields, key: string): unknown[] {
  const value = control[key];
  if (!Array.isArray(value))
    refuse(key, `is ${describeStored(value)}, not a list`, area(key));
  return value;
}

/** One stored trigger as a trigger body, self-checked. */
function entry(db: DatabaseSync, trigger: StoredTrigger): Fields {
  const { control } = trigger;
  const options = control["options"];
  if (!isJsonObject(options))
    refuse(
      "options",
      `is ${describeStored(options)}; a trigger without options takes Companion's defaults, which apply would store explicitly`,
      "trigger option",
    );
  const { name, enabled, sortOrder, collectionId } = options;
  if (typeof name !== "string" || name === "")
    refuse("options.name", "is not a non-empty string", "trigger option");
  if (typeof enabled !== "boolean")
    refuse(
      "options.enabled",
      `is ${describeStored(enabled)}, not true or false`,
      "trigger option",
    );
  if (typeof sortOrder !== "number")
    refuse(
      "options.sortOrder",
      `is ${describeStored(sortOrder)}, not a number`,
      "trigger option",
    );
  const events = list(control, "events").map((event, index) =>
    exportEvent(event, `events[${index}]`),
  );
  const actions = list(control, "actions").map((action, index) =>
    exportAction(action, `actions[${index}]`),
  );
  const body: Fields = {
    name,
    enabled,
    events,
    ...(actions.length > 0 ? { actions } : {}),
  };
  selfCheck({
    stored: control,
    parse: () => parseTrigger(body),
    check: (plan) => checkTrigger(db, plan),
    build: (plan) => buildTriggerControl(plan, { sortOrder, collectionId }),
    storedPath,
    area,
  });
  return body;
}

const label = (trigger: StoredTrigger) =>
  `trigger ${JSON.stringify(nameOf(trigger))} (${trigger.id})`;

function nameOf(trigger: StoredTrigger): string {
  const name = trigger.options["name"];
  return typeof name === "string" ? name : JSON.stringify(name ?? null);
}

function readSorted(db: DatabaseSync): StoredTrigger[] {
  return readTriggers(db).sort(
    bySortOrderThen(
      (trigger) => {
        const order = trigger.options["sortOrder"];
        return typeof order === "number" ? order : undefined;
      },
      (trigger) => trigger.id,
    ),
  );
}

export const triggerExporter: Exporter<StoredTrigger> = {
  kind: "trigger",
  arguments: '"<name>"',
  noun: "triggers",
  checkArgs: (args) =>
    args.length === 1
      ? undefined
      : "export trigger takes exactly one trigger name",
  select: (db, [name]) => {
    const named = readSorted(db).filter(
      (trigger) => trigger.options["name"] === name,
    );
    if (named.length === 0)
      throw new CliError(`no trigger named ${JSON.stringify(name)}`, {
        code: "not_found",
      });
    if (named.length > 1)
      throw new CliError(
        `${named.length} triggers with the same name ${JSON.stringify(name)} (${named
          .map((trigger) => trigger.id)
          .sort()
          .join(", ")}); apply would refuse to choose one`,
        { code: "check_failed", path: "options.name" },
      );
    return named;
  },
  name: nameOf,
  label,
  entry,
  file: ([body]) => ({ kind: "trigger", ...body }),
};

export const triggersExporter: Exporter<StoredTrigger> = {
  kind: "triggers",
  arguments: "[<pattern>...]",
  noun: "triggers",
  select: (db, patterns) =>
    selectByPatterns(readSorted(db), patterns, nameOf, {
      one: "trigger",
      many: "triggers",
    }),
  name: nameOf,
  label,
  entry,
  file: (entries) => ({ kind: "triggers", triggers: entries }),
};
