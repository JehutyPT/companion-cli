/**
 * `list triggers`: the triggers as the trigger writer reads them (a
 * `trigger:` control holding an object of type "trigger"; missing options
 * are Companion's defaults, so "New Trigger", disabled), ordered by
 * `options.sortOrder`, then control id. Flags count as on when truthy, as
 * Companion tests them (`if(e.enabled)`).
 */
import type { DatabaseSync } from "node:sqlite";
import { type Fields, isJsonObject } from "../core/validate.ts";
import { readTriggers, type StoredTrigger } from "../writers/trigger.ts";
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

/** One event's summary, such as `startup 0ms` or `var fx_counter (off)`. */
export function eventSummary(event: ListedEvent): string {
  const { delay, seconds, variableId } = event.options;
  let text = event.type;
  if (event.type === "startup" && typeof delay === "number") {
    text = `startup ${delay}ms`;
  } else if (event.type === "interval" && typeof seconds === "number") {
    text = `interval ${seconds}s`;
  } else if (
    event.type === "variable_changed" &&
    typeof variableId === "string"
  ) {
    text = `var ${variableId.startsWith("custom:") ? variableId.slice("custom:".length) : variableId}`;
  }
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
