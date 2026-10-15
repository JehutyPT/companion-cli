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
  STRING,
} from "../core/field-schema.ts";
import {
  expectBoolean,
  expectList,
  expectMapping,
  expectNonEmptyString,
  expectNonNegativeInteger,
  expectNumberInRange,
  expectPositiveInteger,
  expectString,
  fieldPath,
  type Fields,
  isJsonObject,
  rejectUnknownFields,
  requireField,
} from "../core/validate.ts";
import type { Writer } from "../core/writer.ts";
import {
  ACTION_CONTEXT,
  type ActionSpec,
  actionVariableReferences,
  buildAction,
  parseActionList,
} from "./actions.ts";
import {
  buildFeedback,
  type FeedbackSpec,
  feedbackVariableReferences,
  parseConditionList,
} from "./feedbacks.ts";
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
 *   notes: "Resets at startup"             # optional, default ""
 *   events:                                # required, non-empty
 *     - { event: startup, delay: 0 }       # delay in ms, optional, default 10000
 *     - { event: interval, seconds: 5 }    # positive integer
 *     - { event: variable_changed, variable: fx_counter }
 *     - { event: timeofday, time: "08:00:00", days: [mon, fri], enabled: false }
 *     - { event: condition_true }          # needs at least one condition
 *   conditions:                            # optional condition list, default []
 *     - { condition: expression, expression: "$(custom:fx_counter) > 0" }
 *   actions:                               # optional action list, default []
 *     - { action: increment, variable: fx_counter }
 *
 * The control is Companion 5.1's stored trigger: `{type: "trigger", options,
 * actions, condition, events, localVariables: []}`, with event options as
 * plain values. Every Companion 5.1 event type is written (EVENT_KINDS);
 * `enabled: false` on an event stores it disabled. Conditions are boolean
 * feedbacks (feedbacks.ts, `parseConditionList`). A trigger with the same
 * name is rewritten under its control id, keeping its `sortOrder` and
 * `collectionId`; everything else is replaced. Otherwise a new `trigger:<id>` row is appended
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

/** Day names in a description file, by Companion's day number (Sunday = 0). */
export const DAY_NAMES: readonly string[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

/** The times Companion runs a time-of-day event at (`Timer.ts`). */
const TIME_OF_DAY_PATTERN = "^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$";
/** The times Companion runs a specific-date event at: seconds optional. */
const SPECIFIC_TIME_PATTERN = "^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$";
/** A date as the web UI's date input stores it. */
const DATE_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";

const SUN_EVENTS = ["sunrise", "sunset"];

/** `<label>:<name>`, as Companion names a variable. */
const VARIABLE_ID_PATTERN = "^[^:]+:.+$";

/** Whether `text` is a "YYYY-MM-DD" date that exists in the calendar. */
function isCalendarDate(text: string): boolean {
  if (!new RegExp(DATE_PATTERN).test(text)) return false;
  const [year, month, day] = text.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** An optional field: the parsed value, or `fallback` when it is missing. */
function optional<T>(
  fields: Fields,
  key: string,
  path: string,
  parse: (value: unknown, field: string) => T,
  fallback: T,
): T {
  return Object.hasOwn(fields, key)
    ? parse(fields[key], fieldPath(path, key))
    : fallback;
}

function parseTime(
  fields: Fields,
  path: string,
  pattern: string,
  format: string,
): string {
  const field = fieldPath(path, "time");
  const time = expectString(requireField(fields, "time", path), field);
  if (!new RegExp(pattern).test(time))
    throw new ValidationError(
      field,
      `must be a time ${format}, got ${JSON.stringify(time)}`,
    );
  return time;
}

/** Day names as Companion's day numbers, in file order; all seven by default. */
function parseDays(fields: Fields, path: string): number[] {
  if (!Object.hasOwn(fields, "days")) return DAY_NAMES.map((_, day) => day);
  const daysPath = fieldPath(path, "days");
  const items = expectList(fields["days"], daysPath);
  if (items.length === 0)
    throw new ValidationError(daysPath, "must list at least one day");
  const days: number[] = [];
  items.forEach((item, index) => {
    const itemPath = fieldPath(daysPath, index);
    const name = expectString(item, itemPath);
    const day = DAY_NAMES.indexOf(name);
    if (day < 0)
      throw new ValidationError(
        itemPath,
        `unknown day ${JSON.stringify(name)} (expected one of: ${DAY_NAMES.join(", ")})`,
      );
    if (days.includes(day))
      throw new ValidationError(
        itemPath,
        `duplicate day ${JSON.stringify(name)}`,
      );
    days.push(day);
  });
  return days;
}

/** A variable_changed event's variable: a custom one by name, or any by id. */
type VariableChanged = { variable: string } | { variableId: string };

function parseVariableChanged(fields: Fields, path: string): VariableChanged {
  const hasVariable = Object.hasOwn(fields, "variable");
  const hasId = Object.hasOwn(fields, "variableId");
  if (hasVariable && hasId)
    throw new ValidationError(
      fieldPath(path, "variableId"),
      "give either variable or variableId, not both",
    );
  if (hasVariable)
    return {
      variable: parseVariableName(
        fields["variable"],
        fieldPath(path, "variable"),
      ),
    };
  if (!hasId)
    throw new ValidationError(
      fieldPath(path, "variable"),
      "is required (or variableId for a variable that is not a custom variable)",
    );
  const field = fieldPath(path, "variableId");
  const id = expectString(fields["variableId"], field);
  if (!new RegExp(VARIABLE_ID_PATTERN).test(id))
    throw new ValidationError(
      field,
      `must be "<label>:<name>", got ${JSON.stringify(id)}`,
    );
  if (id.startsWith("custom:"))
    throw new ValidationError(
      field,
      `is a custom variable; write variable: ${id.slice("custom:".length)} instead`,
    );
  return { variableId: id };
}

const inRange =
  (min: number, max: number) =>
  (value: unknown, field: string): number =>
    expectNumberInRange(value, field, min, max);

const numberInRange = (minimum: number, maximum: number) => ({
  type: "number",
  minimum,
  maximum,
});

/** An event kind without options. */
const noOptions = (type: string, doc: string) =>
  defineKind({
    doc,
    fieldSchemas: {},
    parse: () => ({}),
    references: () => [],
    build: () => ({ type, options: {} }),
  });

const CONDITION_NOTE =
  " The trigger needs at least one condition: without any, they always hold and the event never fires.";

const PLATFORM_NOTE =
  " Companion registers it only on macOS and Windows; Companion on Linux ignores it.";

/**
 * Every event kind, built as Companion stores it: options in the order of
 * its event definition (`Resources/EventDefinitions.ts`), as plain values.
 */
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
      delay: optional(
        fields,
        "delay",
        path,
        expectNonNegativeInteger,
        DEFAULT_STARTUP_DELAY_MS,
      ),
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
  intervalRandom: defineKind({
    doc: "Runs again and again, each time after a random whole number of seconds from `min` to `max`.",
    fieldSchemas: {
      min: field("The shortest interval in seconds.", {
        ...integer(1),
        default: 3,
      }),
      max: field("The longest interval in seconds; at least `min`.", {
        ...integer(1),
        default: 10,
        $comment: "Not expressible here: max must be at least min.",
      }),
    },
    parse: (fields, path) => {
      const min = optional(fields, "min", path, expectPositiveInteger, 3);
      const max = optional(fields, "max", path, expectPositiveInteger, 10);
      if (max < min)
        throw new ValidationError(
          fieldPath(path, "max"),
          `must be at least min (${min}), got ${max}`,
        );
      return { min, max };
    },
    references: () => [],
    build: ({ min, max }) => ({
      type: "intervalRandom",
      options: { minimum: min, maximum: max },
    }),
  }),
  timeofday: defineKind({
    doc: "Runs at a time of day on the given days, in Companion's configured timezone (or the system's).",
    fieldSchemas: {
      time: requiredField('The time, "HH:MM:SS" (24-hour).', {
        type: "string",
        pattern: TIME_OF_DAY_PATTERN,
      }),
      days: field("The days it runs on, at least one.", {
        ...list(
          { type: "string", enum: DAY_NAMES },
          { minItems: 1, uniqueItems: true },
        ),
        default: DAY_NAMES,
      }),
    },
    parse: (fields, path) => ({
      time: parseTime(fields, path, TIME_OF_DAY_PATTERN, '"HH:MM:SS"'),
      days: parseDays(fields, path),
    }),
    references: () => [],
    build: ({ time, days }) => ({
      type: "timeofday",
      options: { time, days },
    }),
  }),
  specificDate: defineKind({
    doc: "Runs once, at a date and time in Companion's configured timezone (or the system's).",
    fieldSchemas: {
      date: requiredField('The date, "YYYY-MM-DD".', {
        type: "string",
        pattern: DATE_PATTERN,
        $comment: "Not expressible here: the date must exist in the calendar.",
      }),
      time: requiredField('The time, "HH:MM:SS" or "HH:MM" (24-hour).', {
        type: "string",
        pattern: SPECIFIC_TIME_PATTERN,
      }),
    },
    parse: (fields, path) => {
      const field = fieldPath(path, "date");
      const date = expectString(requireField(fields, "date", path), field);
      if (!isCalendarDate(date))
        throw new ValidationError(
          field,
          `must be a date "YYYY-MM-DD", got ${JSON.stringify(date)}`,
        );
      return {
        date,
        time: parseTime(
          fields,
          path,
          SPECIFIC_TIME_PATTERN,
          '"HH:MM" or "HH:MM:SS"',
        ),
      };
    },
    references: () => [],
    build: ({ date, time }) => ({
      type: "specificDate",
      options: { date, time },
    }),
  }),
  sun_event: defineKind({
    doc: "Runs at sunrise or sunset at a place, shifted by an offset.",
    fieldSchemas: {
      sun: field("Sunrise or sunset.", {
        type: "string",
        enum: SUN_EVENTS,
        default: "sunrise",
      }),
      latitude: field("The place's latitude in degrees.", {
        ...numberInRange(-90, 90),
        default: 0,
      }),
      longitude: field("The place's longitude in degrees.", {
        ...numberInRange(-180, 180),
        default: 0,
      }),
      offset: field("Minutes after (or, when negative, before) the event.", {
        ...numberInRange(-720, 720),
        default: 0,
      }),
    },
    parse: (fields, path) => {
      const sun = optional(fields, "sun", path, expectString, "sunrise");
      if (!SUN_EVENTS.includes(sun))
        throw new ValidationError(
          fieldPath(path, "sun"),
          `must be one of ${SUN_EVENTS.join(", ")}, got ${JSON.stringify(sun)}`,
        );
      return {
        sun,
        latitude: optional(fields, "latitude", path, inRange(-90, 90), 0),
        longitude: optional(fields, "longitude", path, inRange(-180, 180), 0),
        offset: optional(fields, "offset", path, inRange(-720, 720), 0),
      };
    },
    references: () => [],
    build: ({ sun, latitude, longitude, offset }) => ({
      type: "sun_event",
      options: { type: sun, latitude, longitude, offset },
    }),
  }),
  client_connect: defineKind({
    doc: "Runs when a web client connects to Companion.",
    fieldSchemas: {
      delay: field("Milliseconds to wait after the connection.", {
        ...integer(0),
        default: 0,
      }),
    },
    parse: (fields, path) => ({
      delay: optional(fields, "delay", path, expectNonNegativeInteger, 0),
    }),
    references: () => [],
    build: ({ delay }) => ({ type: "client_connect", options: { delay } }),
  }),
  button_press: noOptions("button_press", "Runs when any button is pressed."),
  button_release: noOptions(
    "button_release",
    "Runs when any button is released.",
  ),
  variable_changed: defineKind<VariableChanged>({
    doc: "Runs when a variable's value changes: a custom variable by `variable`, or any other by `variableId`.",
    fieldSchemas: {
      variable: field(
        "The custom variable, by name (without `custom:`). It must exist in the database. Give this or `variableId`.",
        ref("variableName"),
      ),
      variableId: field(
        "Any other variable, as `<label>:<name>` (for example `internal:time_hms` or `local:counter`), stored as given and not checked against the database. Give this or `variable`.",
        { type: "string", pattern: VARIABLE_ID_PATTERN },
      ),
    },
    schema: {
      $comment:
        "Not expressible here: one of variable and variableId is required, and a variableId must not start with custom: (use variable).",
      dependentSchemas: {
        variable: {
          $comment: "With `variable`, `variableId` is refused.",
          properties: { variableId: false },
        },
      },
    },
    parse: parseVariableChanged,
    references: (payload, path) =>
      "variable" in payload
        ? [{ field: fieldPath(path, "variable"), name: payload.variable }]
        : [],
    build: (payload) => ({
      type: "variable_changed",
      options: {
        variableId:
          "variable" in payload
            ? `custom:${payload.variable}`
            : payload.variableId,
      },
    }),
  }),
  computer_locked: noOptions(
    "computer_locked",
    `Runs when the computer running Companion locks.${PLATFORM_NOTE}`,
  ),
  computer_unlocked: noOptions(
    "computer_unlocked",
    `Runs when the computer running Companion unlocks.${PLATFORM_NOTE}`,
  ),
  condition_true: noOptions(
    "condition_true",
    `Runs when the trigger's conditions, taken together, become true.${CONDITION_NOTE}`,
  ),
  condition_false: noOptions(
    "condition_false",
    `Runs when the trigger's conditions, taken together, become false.${CONDITION_NOTE}`,
  ),
};

/** The events that fire on the trigger's conditions. */
const CONDITION_EVENTS: readonly string[] = [
  "condition_true",
  "condition_false",
] satisfies (keyof typeof EVENT_KINDS)[];

const EVENTS = taggedKinds<undefined, EventBody>("event")(EVENT_KINDS);

/** Fields every event entry accepts besides its kind's own. */
export const EVENT_FIELDS = ["enabled"] as const;

export const EVENT_FIELD_SCHEMAS: Record<
  (typeof EVENT_FIELDS)[number],
  FieldSchema
> = {
  enabled: field("Whether the event can start the trigger.", {
    ...BOOLEAN,
    default: true,
  }),
};

type EventSpec = TaggedSpec<typeof EVENT_KINDS> & { enabled: boolean };

function parseEvent(item: unknown, path: string): EventSpec {
  const fields = expectMapping(item, path);
  const spec = EVENTS.parse(fields, path, undefined, EVENT_FIELDS);
  return {
    ...spec,
    enabled: optional(fields, "enabled", path, expectBoolean, true),
  };
}

export interface TriggerPlan {
  name: string;
  enabled: boolean;
  notes: string;
  events: EventSpec[];
  conditions: FeedbackSpec[];
  actions: ActionSpec[];
}

export const FIELDS = [
  "name",
  "enabled",
  "notes",
  "events",
  "conditions",
  "actions",
] as const;

export const FIELD_SCHEMAS: Record<(typeof FIELDS)[number], FieldSchema> = {
  name: requiredField(
    "The trigger's name, which identifies it: a trigger with this name is replaced under its id, keeping its order and collection; otherwise one is created.",
    NON_EMPTY_STRING,
  ),
  enabled: field("Whether the trigger runs.", { ...BOOLEAN, default: true }),
  notes: field("Notes on the trigger, shown in Companion's editor.", {
    ...STRING,
    default: "",
  }),
  events: requiredField(
    "What starts the trigger. At least one.",
    list(ref("event"), {
      minItems: 1,
      $comment:
        "Not expressible here: condition_true and condition_false need at least one condition.",
    }),
  ),
  conditions: field(
    "What must all hold for the actions to run when an event starts the trigger.",
    { ...list(ref("condition")), default: [] },
  ),
  actions: field("The actions the trigger runs, in order.", {
    ...list(ref("action")),
    default: [],
  }),
};

/** What a trigger file does: the kind's `description` in the schema. */
export const DOC = "Creates or replaces one trigger, identified by its name.";

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
  const events = list.map((item, index) =>
    parseEvent(item, fieldPath(eventsPath, index)),
  );
  const conditions = parseConditionList(
    fields,
    "conditions",
    ACTION_CONTEXT,
    parent,
  );
  if (conditions.length === 0) {
    const index = events.findIndex((spec) =>
      CONDITION_EVENTS.includes(spec.kind),
    );
    if (index >= 0)
      throw new ValidationError(
        fieldPath(fieldPath(eventsPath, index), "event"),
        `${(events[index] as EventSpec).kind} needs at least one condition: without conditions it never fires`,
      );
  }
  return {
    name,
    enabled,
    notes: Object.hasOwn(fields, "notes")
      ? expectString(fields["notes"], fieldPath(parent, "notes"))
      : "",
    events,
    conditions,
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
    ...feedbackVariableReferences(
      plan.conditions,
      fieldPath(parent, "conditions"),
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
      notes: plan.notes,
      ...(collectionId === undefined || collectionId === null
        ? {}
        : { collectionId }),
    },
    actions: plan.actions.map(buildAction),
    condition: plan.conditions.map(buildFeedback),
    events: plan.events.map((spec) => {
      const { type, options } = EVENTS.build(spec);
      return { id: newId(), type, enabled: spec.enabled, options };
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
