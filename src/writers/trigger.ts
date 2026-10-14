import type { DatabaseSync } from "node:sqlite";
import { parseStoredJson } from "../core/database.ts";
import { CliError, ValidationError } from "../core/errors.ts";
import {
  expectBoolean,
  expectList,
  expectMapping,
  expectNonEmptyString,
  expectNonNegativeInteger,
  expectPositiveInteger,
  fieldPath,
  type Fields,
  isJsonObject,
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
import { controlExists, freshId, newId } from "./ids.ts";
import {
  checkVariablesExist,
  nextSortOrder,
  parseVariableName,
  type TaggedKind,
  type TaggedSpec,
  taggedKinds,
} from "./shared.ts";

/**
 * Trigger writer: creates or replaces one trigger, identified by its name.
 *
 *   kind: trigger
 *   name: Reset counter                    # required, non-empty; the identity
 *   enabled: true                          # optional, default true
 *   events:                                # required, non-empty
 *     - { event: startup, delay: 0 }       # delay in ms, optional, default 10000
 *     - { event: interval, seconds: 5 }    # positive integer
 *     - { event: variable_changed, variable: fx_counter }
 *   actions:                               # optional action list, default []
 *     - { action: increment, variable: fx_counter }
 *
 * The control is Companion 5.1's stored trigger: `{type: "trigger", options,
 * actions, condition: [], events, localVariables: []}`, with event options as
 * plain values. A trigger with the same name is rewritten under its control
 * id, keeping its `sortOrder` and `collectionId`; everything else is replaced,
 * and `notes` is reset to "". Otherwise a new `trigger:<id>` row is appended
 * after the highest `sortOrder`. Two triggers with the same name refuse the
 * apply. See docs/companion-internals.md, "Triggers".
 */

/** A stored event, before its id and enabled flag. Option values are plain. */
interface EventBody {
  type: string;
  options: Record<string, unknown>;
}

type EventKind<P> = TaggedKind<P, undefined, EventBody>;

const defineKind = <P>(kind: EventKind<P>): EventKind<P> => kind;

/** Companion's own default for a new startup event (`VK.startup`). */
const DEFAULT_STARTUP_DELAY_MS = 10000;

const EVENT_KINDS = {
  startup: defineKind({
    fields: ["delay"],
    parse: (fields, path) => ({
      delay: Object.hasOwn(fields, "delay")
        ? expectNonNegativeInteger(fields["delay"], fieldPath(path, "delay"))
        : DEFAULT_STARTUP_DELAY_MS,
    }),
    references: () => [],
    build: ({ delay }) => ({ type: "startup", options: { delay } }),
  }),
  interval: defineKind({
    fields: ["seconds"],
    parse: (fields, path) => ({
      seconds: expectPositiveInteger(
        requireField(fields, "seconds", path),
        fieldPath(path, "seconds"),
      ),
    }),
    references: () => [],
    build: ({ seconds }) => ({ type: "interval", options: { seconds } }),
  }),
  variable_changed: defineKind({
    fields: ["variable"],
    parse: (fields, path) => ({
      variable: parseVariableName(
        requireField(fields, "variable", path),
        fieldPath(path, "variable"),
      ),
    }),
    references: ({ variable }, path) => [
      { field: fieldPath(path, "variable"), name: variable },
    ],
    build: ({ variable }) => ({
      type: "variable_changed",
      options: { variableId: `custom:${variable}` },
    }),
  }),
};

const EVENTS = taggedKinds<undefined, EventBody>("event")(EVENT_KINDS);

type EventSpec = TaggedSpec<typeof EVENT_KINDS>;

export interface TriggerPlan {
  name: string;
  enabled: boolean;
  events: EventSpec[];
  actions: ActionSpec[];
}

const FIELDS = ["name", "enabled", "events", "actions"];

function parseTrigger(fields: Fields): TriggerPlan {
  rejectUnknownFields(fields, FIELDS, "");
  const name = expectNonEmptyString(requireField(fields, "name", ""), "name");
  const enabled = Object.hasOwn(fields, "enabled")
    ? expectBoolean(fields["enabled"], "enabled")
    : true;
  const list = expectList(requireField(fields, "events", ""), "events");
  if (list.length === 0)
    throw new ValidationError("events", "must list at least one event");
  const events = list.map((item, index) => {
    const path = fieldPath("events", index);
    return EVENTS.parse(expectMapping(item, path), path, undefined);
  });
  return { name, enabled, events, actions: parseActionList(fields, "actions") };
}

/** A `controls` row Companion loads as a trigger: a JSON object of type "trigger". */
interface StoredTrigger {
  id: string;
  options: Fields;
}

/** Companion's options for a trigger stored without any (`DefaultOptions`). */
const DEFAULT_OPTIONS: Fields = { name: "New Trigger", sortOrder: 0 };

/**
 * Every `trigger:` control holding a trigger object. Rows without the prefix
 * are ignored on purpose, even of type "trigger": Companion's upgrades and
 * export decide trigger-ness from the `trigger:` id, and the writer must never
 * match a button. LIKE ignores ASCII case, so the prefix is checked exactly
 * again in code. A trigger row with no options is read as Companion
 * reads it (`this.options=n.options||this.options`): with its default
 * options, so it is named "New Trigger". Rows whose options are not an object
 * are ignored.
 */
function readTriggers(db: DatabaseSync): StoredTrigger[] {
  const triggers: StoredTrigger[] = [];
  for (const row of db
    .prepare("SELECT id, value FROM controls WHERE id LIKE 'trigger:%'")
    .all()) {
    const id = String(row["id"]);
    if (!id.startsWith("trigger:")) continue;
    const value = parseStoredJson(row["value"]);
    if (!isJsonObject(value) || value["type"] !== "trigger") continue;
    const options = value["options"] || DEFAULT_OPTIONS;
    if (isJsonObject(options)) triggers.push({ id, options });
  }
  return triggers;
}

/** What the write does: replace `existing`, or create a trigger at `nextSortOrder`. */
interface Target {
  existing: StoredTrigger | undefined;
  nextSortOrder: number;
}

/** Finds the trigger with the name, refusing when several have it. */
function readTarget(db: DatabaseSync, name: string): Target {
  const triggers = readTriggers(db);
  const named = triggers.filter((trigger) => trigger.options["name"] === name);
  if (named.length > 1) {
    throw new CliError(
      `name: ${named.length} triggers with the same name ${JSON.stringify(name)} (${named
        .map((trigger) => trigger.id)
        .sort()
        .join(", ")}); refusing to choose one`,
    );
  }
  const orders = triggers
    .map((trigger) => trigger.options["sortOrder"])
    .filter((order): order is number => typeof order === "number");
  return {
    existing: named[0],
    nextSortOrder: nextSortOrder(orders),
  };
}

function checkTrigger(db: DatabaseSync, plan: TriggerPlan): void {
  checkVariablesExist(db, [
    ...plan.events.flatMap((spec, index) =>
      EVENTS.references(spec, fieldPath("events", index)),
    ),
    ...actionVariableReferences(plan.actions, "actions"),
  ]);
  readTarget(db, plan.name);
}

function writeTrigger(db: DatabaseSync, plan: TriggerPlan): string {
  const { existing, nextSortOrder } = readTarget(db, plan.name);
  const kept = existing?.options ?? {};
  const sortOrder =
    typeof kept["sortOrder"] === "number" ? kept["sortOrder"] : nextSortOrder;
  const collectionId = kept["collectionId"];
  const value = JSON.stringify({
    type: "trigger",
    options: {
      name: plan.name,
      enabled: plan.enabled,
      sortOrder,
      notes: "",
      ...(collectionId === undefined || collectionId === null
        ? {}
        : { collectionId }),
    },
    actions: plan.actions.map(buildAction),
    condition: [],
    events: plan.events.map((spec) => {
      const { type, options } = EVENTS.build(spec);
      return { id: newId(), type, enabled: true, options };
    }),
    localVariables: [],
  });

  if (existing) {
    db.prepare("UPDATE controls SET value = ? WHERE id = ?").run(
      value,
      existing.id,
    );
    return `trigger ${JSON.stringify(plan.name)}: replaced ${existing.id}`;
  }
  const id = freshId((candidate) => controlExists(db, candidate), "trigger:");
  db.prepare("INSERT INTO controls (id, value) VALUES (?, ?)").run(id, value);
  return `trigger ${JSON.stringify(plan.name)}: created ${id}`;
}

export const triggerWriter: Writer<TriggerPlan> = {
  kind: "trigger",
  parse: parseTrigger,
  check: checkTrigger,
  write: writeTrigger,
};
