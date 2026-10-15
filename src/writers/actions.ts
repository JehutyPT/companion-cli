import { ValidationError } from "../core/errors.ts";
import {
  field,
  type FieldSchema,
  integer,
  NON_EMPTY_STRING,
  ref,
  requiredField,
  SCALAR,
} from "../core/field-schema.ts";
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
  PASSTHROUGH_FIELD_SCHEMAS,
  parsePassthrough,
  parseVariableName,
  prop,
  type TaggedKind,
  taggedKind,
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

const VARIABLE_FIELD = requiredField(
  "The custom variable to set, by name (without `custom:`). It must exist in the database.",
  ref("variableName"),
);

/**
 * An internal `custom_variable_set_value` action on `variable`. `extra`
 * describes the fields that make up its `value` option.
 */
function variableAction<Extra>(extra: {
  doc: string;
  fieldSchemas: Record<string, FieldSchema>;
  parse(fields: Fields, path: string): Extra;
  references(payload: Extra, path: string): VariableReference[];
  value(payload: Extra): Option;
}): ActionKind<{ variable: string } & Extra> {
  return taggedKind({
    doc: `${extra.doc} Written as Companion's internal \`custom_variable_set_value\` action (connection \`internal\`).`,
    fieldSchemas: { variable: VARIABLE_FIELD, ...extra.fieldSchemas },
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
  });
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

const DEFAULT_BY = 1;

function parseBy(fields: Fields, path: string): { by: number } {
  return {
    by: Object.hasOwn(fields, "by")
      ? expectPositiveInteger(fields["by"], fieldPath(path, "by"))
      : DEFAULT_BY,
  };
}

const byField = (verb: string) =>
  field(`How much to ${verb} by.`, { ...integer(1), default: DEFAULT_BY });

export const ACTION_KINDS = {
  set: variableAction({
    doc: "Sets a custom variable to a fixed value.",
    fieldSchemas: {
      value: requiredField(
        "The value, stored as text (numbers and booleans become strings). `$(custom:…)` references in it are checked against the database.",
        SCALAR,
      ),
    },
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
    doc: "Sets a custom variable to the result of a Companion expression.",
    fieldSchemas: {
      expression: requiredField(
        "A Companion expression, for example `$(custom:fx_counter) * 2`. `$(custom:…)` references in it are checked against the database.",
        NON_EMPTY_STRING,
      ),
    },
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
    doc: "Adds to a custom variable (the expression `$(this:current) + by`).",
    fieldSchemas: { by: byField("increment") },
    parse: parseBy,
    references: () => [],
    value: ({ by }) => prop(`$(this:current) + ${by}`, true),
  }),
  decrement: variableAction({
    doc: "Subtracts from a custom variable (the expression `$(this:current) - by`).",
    fieldSchemas: { by: byField("decrement") },
    parse: parseBy,
    references: () => [],
    value: ({ by }) => prop(`$(this:current) - ${by}`, true),
  }),
  passthrough: taggedKind({
    doc: "Any connection's action, written literally: connection, definition and options are not checked against the database.",
    fieldSchemas: PASSTHROUGH_FIELD_SCHEMAS,
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
