import type { DatabaseSync } from "node:sqlite";
import { parseStoredJson } from "../core/database.ts";
import { CheckError, ValidationError } from "../core/errors.ts";
import {
  BOOLEAN,
  field,
  type FieldSchema,
  integer,
  list,
  NON_EMPTY_STRING,
  ref,
  requiredField,
} from "../core/field-schema.ts";
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
  plural,
  type TaggedKind,
  taggedKind,
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

const defineKind = <P>(kind: Omit<EventKind<P>, "fields">): EventKind<P> =>
  taggedKind(kind);

/** Companion's own default for a new startup event (`VK.startup`). */
const DEFAULT_STARTUP_DELAY_MS = 10000;

export const EVENT_KINDS = {
  startup: defineKind({
    doc: "Runs when Companion starts.",
    fieldSchemas: {
      delay: field("Milliseconds to wait after startup.", {
        ...integer(0),
        default: DEFAULT_STARTUP_DELAY_MS,
      }),
    },
    parse: (fields, path) => ({
      delay: Object.hasOwn(fields, "delay")
        ? expectNonNegativeInteger(fields["delay"], fieldPath(path, "delay"))
        : DEFAULT_STARTUP_DELAY_MS,
    }),
    references: () => [],
    build: ({ delay }) => ({ type: "startup", options: { delay } }),
  }),
  interval: defineKind({
    doc: "Runs every so many seconds.",
    fieldSchemas: {
      seconds: requiredField("The interval in seconds.", integer(1)),
    },
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
    doc: "Runs when a custom variable's value changes.",
    fieldSchemas: {
      variable: requiredField(
        "The custom variable, by name (without `custom:`). It must exist in the database.",
        ref("variableName"),
      ),
    },
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

export const FIELDS = ["name", "enabled", "events", "actions"] as const;

export const FIELD_SCHEMAS: Record<(typeof FIELDS)[number], FieldSchema> = {
  name: requiredField(
    "The trigger's name, which identifies it: a trigger with this name is replaced under its id, keeping its order and collection; otherwise one is created.",
    NON_EMPTY_STRING,
  ),
  enabled: field("Whether the trigger runs.", { ...BOOLEAN, default: true }),
  events: requiredField(
    "What starts the trigger. At least one.",
    list(ref("event"), { minItems: 1 }),
  ),
  actions: field("The actions the trigger runs, in order.", {
    ...list(ref("action")),
    default: [],
  }),
};

/** What a trigger file does: the kind's `description` in the schema. */
export const DOC =
  "Creates or replaces one trigger, identified by its name. Its condition is always empty and its notes are reset.";

/** YAML examples of a trigger file, as the schema shows them. */
export const EXAMPLES = [
  `kind: trigger
name: Reset counter
enabled: true
events:
  - { event: startup, delay: 0 }
  - { event: interval, seconds: 5 }
  - { event: variable_changed, variable: fx_counter }
actions:
  - { action: set, variable: fx_counter, value: 0 }
`,
];

/**
 * Parses one trigger body (a `kind: trigger` description without `kind`).
 * `parent` is the body's path: "" for a `kind: trigger` file, `triggers[2]`
 * for an entry of a `kind: triggers` file.
 */
export function parseTrigger(fields: Fields, parent = ""): TriggerPlan {
  rejectUnknownFields(fields, FIELDS, parent);
  const name = expectNonEmptyString(
    requireField(fields, "name", parent),
    fieldPath(parent, "name"),
  );
  const enabled = Object.hasOwn(fields, "enabled")
    ? expectBoolean(fields["enabled"], fieldPath(parent, "enabled"))
    : true;
  const eventsPath = fieldPath(parent, "events");
  const list = expectList(requireField(fields, "events", parent), eventsPath);
  if (list.length === 0)
    throw new ValidationError(eventsPath, "must list at least one event");
  const events = list.map((item, index) => {
    const path = fieldPath(eventsPath, index);
    return EVENTS.parse(expectMapping(item, path), path, undefined);
  });
  return {
    name,
    enabled,
    events,
    actions: parseActionList(fields, "actions", parent),
  };
}

/** A `controls` row Companion loads as a trigger: a JSON object of type "trigger". */
export interface StoredTrigger {
  id: string;
  /** The stored options, or Companion's defaults when there are none. */
  options: Fields;
  /** The whole stored control. */
  control: Fields;
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
export function readTriggers(db: DatabaseSync): StoredTrigger[] {
  const triggers: StoredTrigger[] = [];
  for (const row of db
    .prepare("SELECT id, value FROM controls WHERE id LIKE 'trigger:%'")
    .all()) {
    const id = String(row["id"]);
    if (!id.startsWith("trigger:")) continue;
    const value = parseStoredJson(row["value"]);
    if (!isJsonObject(value) || value["type"] !== "trigger") continue;
    const options = value["options"] || DEFAULT_OPTIONS;
    if (isJsonObject(options)) triggers.push({ id, options, control: value });
  }
  return triggers;
}

/** What the write does: replace `existing`, or create a trigger at `nextSortOrder`. */
interface Target {
  existing: StoredTrigger | undefined;
  nextSortOrder: number;
}

/**
 * Finds the trigger with the name, refusing when several have it. `path` is
 * the description field holding the name.
 */
function readTarget(db: DatabaseSync, name: string, path = "name"): Target {
  const triggers = readTriggers(db);
  const named = triggers.filter((trigger) => trigger.options["name"] === name);
  if (named.length > 1) {
    throw new CheckError(
      path,
      `${named.length} triggers with the same name ${JSON.stringify(name)} (${named
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

/** The writer's checks for one trigger body at `parent` ("" or `triggers[2]`). */
export function checkTrigger(
  db: DatabaseSync,
  plan: TriggerPlan,
  parent = "",
): void {
  const eventsPath = fieldPath(parent, "events");
  checkVariablesExist(db, [
    ...plan.events.flatMap((spec, index) =>
      EVENTS.references(spec, fieldPath(eventsPath, index)),
    ),
    ...actionVariableReferences(plan.actions, fieldPath(parent, "actions")),
  ]);
  readTarget(db, plan.name, fieldPath(parent, "name"));
}

/** What a replace keeps from the stored trigger's options. */
export interface KeptTriggerOptions {
  sortOrder: number;
  /** Kept when set; `undefined` and `null` are left out. */
  collectionId: unknown;
}

/**
 * The stored trigger control for a plan: what both apply and export build.
 * Event and action ids are fresh (ADR 0005 masks them when comparing).
 */
export function buildTriggerControl(
  plan: TriggerPlan,
  kept: KeptTriggerOptions,
): Fields {
  const { sortOrder, collectionId } = kept;
  return {
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
  };
}

/**
 * Writes one trigger at `parent` ("" or `triggers[2]`); returns its control
 * id and whether it was created.
 */
function writeOne(
  db: DatabaseSync,
  plan: TriggerPlan,
  parent = "",
): { id: string; created: boolean } {
  const { existing, nextSortOrder } = readTarget(
    db,
    plan.name,
    fieldPath(parent, "name"),
  );
  const kept = existing?.options ?? {};
  const value = JSON.stringify(
    buildTriggerControl(plan, {
      sortOrder:
        typeof kept["sortOrder"] === "number"
          ? kept["sortOrder"]
          : nextSortOrder,
      collectionId: kept["collectionId"],
    }),
  );

  if (existing) {
    db.prepare("UPDATE controls SET value = ? WHERE id = ?").run(
      value,
      existing.id,
    );
    return { id: existing.id, created: false };
  }
  const id = freshId((candidate) => controlExists(db, candidate), "trigger:");
  db.prepare("INSERT INTO controls (id, value) VALUES (?, ?)").run(id, value);
  return { id, created: true };
}

function writeTrigger(db: DatabaseSync, plan: TriggerPlan): string {
  const { id, created } = writeOne(db, plan);
  return `trigger ${JSON.stringify(plan.name)}: ${created ? "created" : "replaced"} ${id}`;
}

export const triggerWriter: Writer<TriggerPlan> = {
  kind: "trigger",
  parse: (fields) => parseTrigger(fields),
  check: (db, plan) => checkTrigger(db, plan),
  describe: (plan) => `trigger ${JSON.stringify(plan.name)}`,
  write: writeTrigger,
};

/**
 * Triggers writer: creates or replaces several triggers in one apply.
 *
 *   kind: triggers
 *   triggers:                  # required, non-empty
 *     - name: Reset counter    # each entry is a `kind: trigger` body
 *       events: [ { event: startup } ]
 *
 * Each entry is parsed, checked and written exactly as a `kind: trigger`
 * file, in list order and in the pipeline's one transaction, so new triggers
 * get increasing sort orders. Two entries with the same name are refused.
 * Triggers the file does not name are untouched.
 */
export const TRIGGERS_FIELDS = ["triggers"] as const;

export const TRIGGERS_FIELD_SCHEMAS: Record<
  (typeof TRIGGERS_FIELDS)[number],
  FieldSchema
> = {
  triggers: requiredField(
    "The triggers to create or replace, in order. At least one; names must be distinct.",
    list(ref("triggerBody"), {
      minItems: 1,
      $comment: "Not expressible here: names must be distinct.",
    }),
  ),
};

/** What a triggers file does: the kind's `description` in the schema. */
export const TRIGGERS_DOC =
  "Creates or replaces several triggers in one apply, each exactly as a `kind: trigger` file would. Triggers the file does not name are untouched.";

/** YAML examples of a triggers file, as the schema shows them. */
export const TRIGGERS_EXAMPLES = [
  `kind: triggers
triggers:
  - name: Reset counter
    events: [ { event: startup, delay: 0 } ]
    actions: [ { action: set, variable: fx_counter, value: 0 } ]
  - name: Tick
    events: [ { event: interval, seconds: 5 } ]
    actions: [ { action: increment, variable: fx_counter } ]
`,
];

export function parseTriggers(fields: Fields): TriggerPlan[] {
  rejectUnknownFields(fields, TRIGGERS_FIELDS, "");
  const list = expectList(requireField(fields, "triggers", ""), "triggers");
  if (list.length === 0)
    throw new ValidationError("triggers", "must list at least one trigger");
  const seen = new Map<string, string>();
  return list.map((item, index) => {
    const path = fieldPath("triggers", index);
    const plan = parseTrigger(expectMapping(item, path), path);
    const first = seen.get(plan.name);
    if (first !== undefined)
      throw new ValidationError(
        fieldPath(path, "name"),
        `duplicate trigger name ${JSON.stringify(plan.name)} (also at ${first})`,
      );
    seen.set(plan.name, path);
    return plan;
  });
}

export const triggersWriter: Writer<TriggerPlan[]> = {
  kind: "triggers",
  parse: parseTriggers,
  describe: (plans) => plural(plans.length, "trigger"),
  check: (db, plans) =>
    plans.forEach((plan, index) =>
      checkTrigger(db, plan, fieldPath("triggers", index)),
    ),
  write: (db, plans) => {
    let created = 0;
    plans.forEach((plan, index) => {
      if (writeOne(db, plan, fieldPath("triggers", index)).created) created++;
    });
    return `triggers: ${created} created, ${plans.length - created} replaced`;
  },
};
