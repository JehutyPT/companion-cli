/**
 * `list triggers`: the triggers as the trigger writer reads them (a
 * `trigger:` control holding an object of type "trigger"; missing options
 * are Companion's defaults, so "New Trigger", disabled), ordered by
 * `options.sortOrder`, then control id. Flags count as on when truthy, as
 * Companion tests them (`if(e.enabled)`).
 */
import type { DatabaseSync } from "node:sqlite";
import { type Fields, isJsonObject } from "../core/validate.ts";
import {
  DAY_NAMES,
  readTriggers,
  type StoredTrigger,
} from "../writers/trigger.ts";
import { bySortOrderThen, type Lister, yesNo } from "./list.ts";

export interface ListedEvent {
  type: string;
  enabled: boolean;
  /** The stored options, as plain values. */
  options: Fields;
}

export interface ListedTrigger {
  id: string;
  name: string;
  enabled: boolean;
  sortOrder: number | null;
  events: ListedEvent[];
  actionCount: number;
  conditionCount: number;
  collectionId: unknown;
}

function listItems(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toListed({ id, options, control }: StoredTrigger): ListedTrigger {
  const { name, enabled, sortOrder, collectionId } = options;
  return {
    id,
    name: typeof name === "string" ? name : JSON.stringify(name ?? null),
    enabled: Boolean(enabled),
    sortOrder: typeof sortOrder === "number" ? sortOrder : null,
    events: listItems(control["events"])
      .filter(isJsonObject)
      .map((event) => ({
        type: String(event["type"]),
        enabled: Boolean(event["enabled"]),
        options: isJsonObject(event["options"]) ? event["options"] : {},
      })),
    actionCount: listItems(control["actions"]).length,
    conditionCount: listItems(control["condition"]).length,
    collectionId: collectionId ?? null,
  };
}

function read(db: DatabaseSync): ListedTrigger[] {
  return readTriggers(db)
    .map(toListed)
    .sort(
      bySortOrderThen(
        (trigger) => trigger.sortOrder ?? undefined,
        (trigger) => trigger.id,
      ),
    );
}

/**
 * Day numbers as names in week order, Sunday first: runs of three or more
 * days as `mon-fri`, others joined with commas (`sun,sat`). Undefined when
 * any entry is not a day number.
 */
function dayList(days: unknown): string | undefined {
  if (!Array.isArray(days) || days.length === 0) return undefined;
  if (!days.every((day) => typeof day === "number" && DAY_NAMES[day]))
    return undefined;
  const sorted = [...new Set(days as number[])].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let start = 0; start < sorted.length;) {
    let end = start;
    while (sorted[end + 1] === (sorted[end] as number) + 1) end += 1;
    const names = sorted.slice(start, end + 1).map((day) => DAY_NAMES[day]);
    parts.push(
      names.length >= 3 ? `${names[0]}-${names.at(-1)}` : names.join(","),
    );
    start = end + 1;
  }
  return parts.join(",");
}

const isText = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number";

/**
 * Each event type's summary from its stored options, or undefined when an
 * option it shows is missing or of another type (the type name is shown).
 */
const SUMMARIES: Record<string, (options: Fields) => string | undefined> = {
  startup: ({ delay }) => (isNumber(delay) ? `startup ${delay}ms` : undefined),
  interval: ({ seconds }) =>
    isNumber(seconds) ? `interval ${seconds}s` : undefined,
  intervalRandom: ({ minimum, maximum }) =>
    isNumber(minimum) && isNumber(maximum)
      ? `random ${minimum}-${maximum}s`
      : undefined,
  timeofday: ({ time, days }) => {
    const names = dayList(days);
    return isText(time) && names ? `timeofday ${time} ${names}` : undefined;
  },
  specificDate: ({ date, time }) =>
    isText(date) && isText(time) ? `date ${date} ${time}` : undefined,
  sun_event: ({ type, offset }) => {
    if (!isText(type) || !isNumber(offset)) return undefined;
    if (offset === 0) return `sun ${type}`;
    return `sun ${type} ${offset > 0 ? "+" : ""}${offset}m`;
  },
  client_connect: ({ delay }) =>
    isNumber(delay) ? `connect ${delay}ms` : undefined,
  button_press: () => "press",
  button_release: () => "release",
  variable_changed: ({ variableId }) =>
    isText(variableId)
      ? `var ${variableId.startsWith("custom:") ? variableId.slice("custom:".length) : variableId}`
      : undefined,
  computer_locked: () => "locked",
  computer_unlocked: () => "unlocked",
};

/**
 * One event's summary, such as `startup 0ms`, `timeofday 08:00:00 mon-fri`,
 * `sun sunset +10m` or `var fx_counter (off)`; the type name when the type
 * or its options are not ones the description format writes.
 */
export function eventSummary(event: ListedEvent): string {
  const summary = Object.hasOwn(SUMMARIES, event.type)
    ? (SUMMARIES[event.type] as (typeof SUMMARIES)[string])(event.options)
    : undefined;
  const text = summary ?? event.type;
  return event.enabled ? text : `${text} (off)`;
}

export const triggersLister: Lister<ListedTrigger> = {
  kind: "triggers",
  read,
  name: (trigger) => trigger.name,
  columns: [
    { header: "NAME", cell: (trigger) => trigger.name },
    { header: "ENABLED", cell: (trigger) => yesNo(trigger.enabled) },
    {
      header: "EVENTS",
      cell: (trigger) => trigger.events.map(eventSummary).join(", "),
    },
    {
      header: "ACTIONS",
      cell: (trigger) =>
        `${trigger.actionCount}${trigger.conditionCount > 0 ? " +cond" : ""}`,
    },
    { header: "ID", cell: (trigger) => trigger.id },
  ],
  json: (trigger) => ({
    id: trigger.id,
    name: trigger.name,
    enabled: trigger.enabled,
    sortOrder: trigger.sortOrder,
    events: trigger.events,
    actionCount: trigger.actionCount,
    conditionCount: trigger.conditionCount,
    collectionId: trigger.collectionId,
  }),
};
