import { ValidationError } from "../core/errors.ts";
import {
  describeType,
  expectList,
  expectMapping,
  expectNonEmptyString,
  expectPositiveInteger,
  fieldPath,
  type Fields,
  requireField,
} from "../core/validate.ts";
import { newId } from "./ids.ts";
import {
  buildPassthrough,
  customReferences,
  type Option,
  PASSTHROUGH_FIELDS,
  parsePassthrough,
  parseVariableName,
  prop,
  type TaggedKind,
  type TaggedSpec,
  taggedKinds,
  type VariableReference,
} from "./shared.ts";

/**
 * Action lists in description files, shared by the button, page and trigger
 * writers. Each entry is tagged with `action`:
 *
 *   - { action: set, variable: fx_label, value: pressed }
 *   - { action: expression, variable: fx_label, expression: "$(custom:fx_counter) * 2" }
 *   - { action: increment, variable: fx_counter, by: 1 }     # by: optional, default 1
 *   - { action: decrement, variable: fx_counter }
 *   - action: passthrough                                     # any connection's action, literally
 *     connection: FixtureConnectionAAAA
 *     definition: some_definition_id
 *     options: { mode: 1 }                                    # optional, default {}
 *
 * The four named actions become Companion 5.1's internal
 * `custom_variable_set_value`; see docs/companion-internals.md, "Actions".
 */

/** One kind of action. Adding an action means adding one entry to ACTION_KINDS. */
type ActionKind<P> = TaggedKind<P>;

const defineKind = <P>(kind: ActionKind<P>): ActionKind<P> => kind;

/**
 * An internal `custom_variable_set_value` action on `variable`. `extra`
 * describes the fields that make up its `value` option.
 */
function variableAction<Extra>(extra: {
  fields: readonly string[];
  parse(fields: Fields, path: string): Extra;
  references(payload: Extra, path: string): VariableReference[];
  value(payload: Extra): Option;
}): ActionKind<{ variable: string } & Extra> {
  return {
    fields: ["variable", ...extra.fields],
    parse: (fields, path) => ({
      variable: parseVariableName(
        requireField(fields, "variable", path),
        fieldPath(path, "variable"),
      ),
      ...extra.parse(fields, path),
    }),
    references: (payload, path) => [
      { field: fieldPath(path, "variable"), name: payload.variable },
      ...extra.references(payload, path),
    ],
    build: (payload) => ({
      definitionId: "custom_variable_set_value",
      connectionId: "internal",
      options: { name: prop(payload.variable), value: extra.value(payload) },
    }),
  };
}

/** Companion's `value` option is a text input, so numbers and booleans become strings. */
function parseSetValue(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new ValidationError(
    field,
    `must be a string, number or boolean, got ${describeType(value)}`,
  );
}

function parseBy(fields: Fields, path: string): { by: number } {
  return {
    by: Object.hasOwn(fields, "by")
      ? expectPositiveInteger(fields["by"], fieldPath(path, "by"))
      : 1,
  };
}

export const ACTION_KINDS = {
  set: variableAction({
    fields: ["value"],
    parse: (fields, path) => ({
      value: parseSetValue(
        requireField(fields, "value", path),
        fieldPath(path, "value"),
      ),
    }),
    references: ({ value }, path) =>
      customReferences(value, fieldPath(path, "value")),
    value: ({ value }) => prop(value),
  }),
  expression: variableAction({
    fields: ["expression"],
    parse: (fields, path) => ({
      expression: expectNonEmptyString(
        requireField(fields, "expression", path),
        fieldPath(path, "expression"),
      ),
    }),
    references: ({ expression }, path) =>
      customReferences(expression, fieldPath(path, "expression")),
    value: ({ expression }) => prop(expression, true),
  }),
  increment: variableAction({
    fields: ["by"],
    parse: parseBy,
    references: () => [],
    value: ({ by }) => prop(`$(this:current) + ${by}`, true),
  }),
  decrement: variableAction({
    fields: ["by"],
    parse: parseBy,
    references: () => [],
    value: ({ by }) => prop(`$(this:current) - ${by}`, true),
  }),
  /** Any connection's action, written literally. Not checked against the database. */
  passthrough: defineKind({
    fields: PASSTHROUGH_FIELDS,
    parse: parsePassthrough,
    references: () => [],
    build: buildPassthrough,
  }),
};

const ACTIONS = taggedKinds("action")(ACTION_KINDS);

/** A parsed action entry: its kind name and that kind's payload. */
export type ActionSpec = TaggedSpec<typeof ACTION_KINDS>;

/**
 * Parses an optional action list such as `down`; a missing field is an empty
 * list. `parent` is the path of `fields` (for example `steps[1]`).
 */
export function parseActionList(
  fields: Fields,
  key: string,
  parent = "",
): ActionSpec[] {
  if (!Object.hasOwn(fields, key)) return [];
  const path = fieldPath(parent, key);
  return expectList(fields[key], path).map((item, index) => {
    const itemPath = fieldPath(path, index);
    return ACTIONS.parse(expectMapping(item, itemPath), itemPath, undefined);
  });
}

/**
 * The custom variables a list of actions uses, in file order: each internal
 * action's target and the references in set values and expressions.
 * Pass-through actions are not inspected. `key` is the list's path.
 */
export function actionVariableReferences(
  actions: readonly ActionSpec[],
  key: string,
): VariableReference[] {
  return actions.flatMap((spec, index) =>
    ACTIONS.references(spec, fieldPath(key, index)),
  );
}

/** Companion 5.1 action JSON with a fresh id. */
export function buildAction(spec: ActionSpec): Record<string, unknown> {
  return { type: "action", id: newId(), ...ACTIONS.build(spec) };
}
