import { ValidationError } from "../core/errors.ts";
import {
  describeType,
  expectList,
  expectMapping,
  expectNonEmptyString,
  expectPositiveInteger,
  expectString,
  fieldPath,
  type Fields,
  rejectUnknownFields,
  requireField,
} from "../core/validate.ts";
import { newId } from "./ids.ts";
import { parseVariableName, prop } from "./shared.ts";

/**
 * Action lists in description files, shared by the button writer and (later)
 * the trigger writer. Each entry is tagged with `action`:
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

/** A `$(custom:<name>)` reference, or an action's target variable, with the field it came from. */
export interface VariableReference {
  field: string;
  name: string;
}

const CUSTOM_REFERENCE = /\$\(custom:([^)]*)\)/g;

/** Every `$(custom:<name>)` in a text, attributed to `field`. */
export function customReferences(
  text: string,
  field: string,
): VariableReference[] {
  return [...text.matchAll(CUSTOM_REFERENCE)].map((match) => ({
    field,
    name: match[1] ?? "",
  }));
}

type Option = ReturnType<typeof prop>;

/** Companion action JSON other than `type` and `id`. */
interface ActionBody {
  definitionId: string;
  connectionId: string;
  options: Record<string, Option>;
}

/**
 * One kind of action in a description file. `P` is its parsed payload (the
 * entry without `action`). Adding an action means adding one entry to
 * ACTION_KINDS.
 */
interface ActionKind<P> {
  /** Fields the entry accepts besides `action`. */
  readonly fields: readonly string[];
  /** Validates the entry's fields (unknown fields are already rejected). */
  parse(fields: Fields, path: string): P;
  /** Custom variables the action uses, in field order; checked against the database. */
  references(payload: P, path: string): VariableReference[];
  build(payload: P): ActionBody;
}

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

/** Rejects values that JSON cannot carry unchanged. */
function expectJsonValue(value: unknown, field: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new ValidationError(field, `must be a finite number, got ${value}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      expectJsonValue(item, fieldPath(field, index)),
    );
    return;
  }
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    for (const [key, child] of Object.entries(value))
      expectJsonValue(child, fieldPath(field, key));
    return;
  }
  throw new ValidationError(
    field,
    `must be a JSON value, got ${describeType(value)}`,
  );
}

const ACTION_KINDS = {
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
    fields: ["connection", "definition", "options"],
    parse: (fields, path) => {
      const optionsPath = fieldPath(path, "options");
      const options = Object.hasOwn(fields, "options")
        ? expectMapping(fields["options"], optionsPath)
        : {};
      expectJsonValue(options, optionsPath);
      return {
        connection: expectNonEmptyString(
          requireField(fields, "connection", path),
          fieldPath(path, "connection"),
        ),
        definition: expectNonEmptyString(
          requireField(fields, "definition", path),
          fieldPath(path, "definition"),
        ),
        options,
      };
    },
    references: () => [],
    build: ({ connection, definition, options }) => ({
      definitionId: definition,
      connectionId: connection,
      options: Object.fromEntries(
        Object.entries(options).map(([key, value]) => [key, prop(value)]),
      ),
    }),
  }),
};

type ActionName = keyof typeof ACTION_KINDS;
const ACTION_NAMES = Object.keys(ACTION_KINDS) as ActionName[];

/** A parsed action entry: its `action` name and that kind's payload. */
export type ActionSpec = {
  [K in ActionName]: { action: K } & ReturnType<
    (typeof ACTION_KINDS)[K]["parse"]
  >;
}[ActionName];

function isActionName(name: string): name is ActionName {
  return Object.hasOwn(ACTION_KINDS, name);
}

/** The kind of a parsed spec. Its payload type matches by construction. */
function kindOf(spec: ActionSpec): ActionKind<ActionSpec> {
  return ACTION_KINDS[spec.action] as unknown as ActionKind<ActionSpec>;
}

function parseAction(item: unknown, path: string): ActionSpec {
  const fields = expectMapping(item, path);
  const actionPath = fieldPath(path, "action");
  const name = expectString(requireField(fields, "action", path), actionPath);
  if (!isActionName(name)) {
    throw new ValidationError(
      actionPath,
      `unknown action "${name}" (expected one of: ${ACTION_NAMES.join(", ")})`,
    );
  }
  const kind = ACTION_KINDS[name];
  rejectUnknownFields(fields, ["action", ...kind.fields], path);
  return { action: name, ...kind.parse(fields, path) } as ActionSpec;
}

/** Parses an optional action list such as `down`; a missing field is an empty list. */
export function parseActionList(fields: Fields, key: string): ActionSpec[] {
  if (!Object.hasOwn(fields, key)) return [];
  return expectList(fields[key], key).map((item, index) =>
    parseAction(item, fieldPath(key, index)),
  );
}

/**
 * The custom variables a list of actions uses, in file order: each internal
 * action's target and the references in set values and expressions.
 * Pass-through actions are not inspected.
 */
export function actionVariableReferences(
  actions: readonly ActionSpec[],
  key: string,
): VariableReference[] {
  return actions.flatMap((spec, index) =>
    kindOf(spec).references(spec, fieldPath(key, index)),
  );
}

/** Companion 5.1 action JSON with a fresh id. */
export function buildAction(spec: ActionSpec): Record<string, unknown> {
  return { type: "action", id: newId(), ...kindOf(spec).build(spec) };
}
