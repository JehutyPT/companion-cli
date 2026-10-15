/**
 * The writers' exported tables and field lists, and the description fields
 * they accept in the support matrix's field notation. Shared by the support
 * matrix and schema tests, so both compare against the same set.
 */
import { tagged as taggedFields } from "../src/support-matrix.ts";
import { ACTION_KINDS } from "../src/writers/actions.ts";
import {
  ACTION_SETS,
  TOP_LEVEL_FIELDS as BUTTON_FIELDS,
} from "../src/writers/button-control.ts";
import {
  FEEDBACK_FIELDS,
  FEEDBACK_KINDS,
  STYLE_FIELDS,
} from "../src/writers/feedbacks.ts";
import { FIELDS as CONNECTION_FIELDS } from "../src/writers/connection.ts";
import { writers } from "../src/writers/index.ts";
import { FIELDS as SURFACE_FIELDS } from "../src/writers/surface.ts";
import { FIELDS as PAGE_FIELDS } from "../src/writers/page.ts";
import {
  EVENT_FIELDS,
  EVENT_KINDS,
  FIELDS as TRIGGER_FIELDS,
  TRIGGERS_FIELDS,
} from "../src/writers/trigger.ts";
import {
  TOP_LEVEL_FIELDS as VARIABLES_FIELDS,
  VARIABLE_FIELDS,
} from "../src/writers/variables.ts";

/** The writers' tables and field lists, as exported. */
export interface WriterTables {
  kinds: readonly string[];
  actionKinds: Record<string, { fields: readonly string[] }>;
  feedbackKinds: Record<string, { fields: readonly string[] }>;
  eventKinds: Record<string, { fields: readonly string[] }>;
  eventFields: readonly string[];
  styleFields: readonly string[];
  feedbackFields: readonly string[];
  buttonFields: readonly string[];
  stepFields: readonly string[];
  pageFields: readonly string[];
  triggerFields: readonly string[];
  triggersFields: readonly string[];
  variablesFields: readonly string[];
  variableFields: readonly string[];
  connectionFields: readonly string[];
  surfaceFields: readonly string[];
}

export const WRITER_TABLES: WriterTables = {
  kinds: Object.keys(writers),
  actionKinds: ACTION_KINDS,
  feedbackKinds: FEEDBACK_KINDS,
  eventKinds: EVENT_KINDS,
  eventFields: EVENT_FIELDS,
  styleFields: Object.keys(STYLE_FIELDS),
  feedbackFields: FEEDBACK_FIELDS,
  buttonFields: BUTTON_FIELDS,
  stepFields: ACTION_SETS,
  pageFields: PAGE_FIELDS,
  triggerFields: TRIGGER_FIELDS,
  triggersFields: TRIGGERS_FIELDS,
  variablesFields: VARIABLES_FIELDS,
  variableFields: VARIABLE_FIELDS,
  connectionFields: CONNECTION_FIELDS,
  surfaceFields: SURFACE_FIELDS,
};

/** Every description field the writers accept, in the matrix's field notation. */
export function writerFields(tables: WriterTables): Set<string> {
  const tagged = (
    tag: string,
    kinds: Record<string, { fields: readonly string[] }>,
  ) =>
    Object.entries(kinds).flatMap(([kind, { fields }]) =>
      taggedFields(tag, kind, fields),
    );
  const under = (prefix: string, fields: readonly string[]) =>
    fields.map((field) => `${prefix}.${field}`);
  return new Set([
    ...tables.kinds.map((kind) => `kind: ${kind}`),
    ...under("button", tables.buttonFields),
    ...under("steps[]", tables.stepFields),
    ...under("page", tables.pageFields),
    ...under("trigger", tables.triggerFields),
    ...under("triggers", tables.triggersFields),
    ...under("variables", tables.variablesFields),
    ...under("variables[]", tables.variableFields),
    ...under("connection", tables.connectionFields),
    ...under("surface", tables.surfaceFields),
    ...tagged("action", tables.actionKinds),
    ...tagged("feedback", tables.feedbackKinds),
    ...under("feedback", tables.feedbackFields),
    ...under("feedback.style", tables.styleFields),
    ...tagged("event", tables.eventKinds),
    ...under("event", tables.eventFields),
  ]);
}
