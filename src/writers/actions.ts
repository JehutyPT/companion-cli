import { ValidationError } from "../core/errors.ts";
import {
  BOOLEAN,
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
  expectBoolean,
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
import {
  buildChildGroups,
  type ChildGroups,
  childReferences,
  parseChildGroups,
} from "./children.ts";
import type { FeedbackContext } from "./feedbacks.ts";
import { newId } from "./ids.ts";
import {
  buildPassthrough,
  CHILDREN_FIELD_SCHEMA,
  CHILDREN_NEED_INTERNAL,
  customReferences,
  ENTITY_FIELDS,
  type EntityCommon,
  entityJson,
  type Option,
  type Passthrough,
  PASSTHROUGH_FIELD_SCHEMAS,
  parseEntityCommon,
  parsePassthrough,
  parseStringOrExpression,
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
type ActionKind<P> = TaggedKind<P, FeedbackContext>;

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
  passthrough: taggedKind<PassthroughAction, FeedbackContext>({
    doc: "Any connection's action, written literally: connection, definition and options are not checked against the database.",
    fieldSchemas: {
      ...PASSTHROUGH_FIELD_SCHEMAS,
      store: field(
        "Where Companion stores the action's result (`storeResult`). Left out, the result is discarded.",
        ref("store"),
      ),
      children: CHILDREN_FIELD_SCHEMA,
    },
    schema: CHILDREN_NEED_INTERNAL,
    parse: (fields, path, context) => ({
      ...parsePassthrough(fields, path),
      store: parseStore(fields, path),
      children: parseChildGroups(fields, path, context),
    }),
    references: ({ store, children }, path) => [
      ...(store ? storeReferences(store, fieldPath(path, "store")) : []),
      ...childReferences(children, fieldPath(path, "children")),
    ],
    build: (payload) => ({
      ...buildPassthrough(payload),
      ...(payload.store ? { storeResult: buildStore(payload.store) } : {}),
      ...(payload.children
        ? { children: buildChildGroups(payload.children) }
        : {}),
    }),
  }),
};

const ACTIONS = taggedKinds<FeedbackContext>("action")(ACTION_KINDS);

/** Fields every action entry accepts besides its kind's own. */
export const ACTION_FIELDS = ENTITY_FIELDS;

/** A parsed action entry: its kind name, that kind's payload and the common fields. */
export type ActionSpec = TaggedSpec<typeof ACTION_KINDS> & {
  common: EntityCommon;
};

/**
 * What an action's children see of the control: a `feedback: step` child of
 * an action is not checked against the button's number of steps.
 */
export const ACTION_CONTEXT: FeedbackContext = {
  stepCount: Number.MAX_SAFE_INTEGER,
};

/** Parses one action entry at `path`. */
export function parseAction(
  fields: Fields,
  path: string,
  context: FeedbackContext = ACTION_CONTEXT,
): ActionSpec {
  return {
    ...ACTIONS.parse(fields, path, context, ACTION_FIELDS),
    common: parseEntityCommon(fields, path),
  };
}

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
    return parseAction(expectMapping(item, itemPath), itemPath);
  });
}

/** The custom variables one action uses (its children's included). */
export function actionReferences(
  spec: ActionSpec,
  path: string,
): VariableReference[] {
  return ACTIONS.references(spec, path);
}

/**
 * The custom variables a list of actions uses, in file order: each internal
 * action's target and the references in set values and expressions, a
 * pass-through action's `store` custom variable, and its children's.
 * Pass-through options are not inspected. `key` is the list's path.
 */
export function actionVariableReferences(
  actions: readonly ActionSpec[],
  key: string,
): VariableReference[] {
  return actions.flatMap((spec, index) =>
    actionReferences(spec, fieldPath(key, index)),
  );
}

/** Companion 5.1 action JSON with a fresh id. */
export function buildAction(spec: ActionSpec): Record<string, unknown> {
  return entityJson("action", newId(), ACTIONS.build(spec), {}, spec.common);
}

/** A pass-through action's payload. */
interface PassthroughAction extends Passthrough {
  store: StoreSpec | undefined;
  children: ChildGroups | undefined;
}

/**
 * `store`: Companion's `storeResult`, one of three targets. Each string
 * field is a string or `{expr: …}`.
 */
export const STORE_KIND_SCHEMAS = {
  custom: {
    variable: requiredField(
      "The custom variable, by name (without `custom:`), or an expression. A name must exist in the database unless `create` is true.",
      { anyOf: [ref("variableName"), ref("expression")] },
    ),
    create: field("Create the variable when it does not exist.", {
      ...BOOLEAN,
      default: false,
    }),
  },
  local: {
    variable: requiredField(
      "The local variable's name, or an expression; not checked.",
      ref("stringOrExpression"),
    ),
    location: requiredField(
      "The button whose local variable it is, for example `$(this:location)`, or an expression; not checked.",
      ref("stringOrExpression"),
    ),
  },
  page: {
    variable: requiredField(
      "The page variable's name, or an expression; not checked.",
      ref("stringOrExpression"),
    ),
    page: requiredField(
      "The page, as text, or an expression; not checked.",
      ref("stringOrExpression"),
    ),
  },
} as const satisfies Record<string, Record<string, FieldSchema>>;

type StoreType = keyof typeof STORE_KIND_SCHEMAS;
const STORE_TYPES = Object.keys(STORE_KIND_SCHEMAS) as StoreType[];

/** The stored `storeResult.type` of each `store.type`. */
export const STORED_STORE_TYPES: Record<StoreType, string> = {
  custom: "custom-variable",
  local: "local-variable",
  page: "page-variable",
};

type StoreSpec =
  | { type: "custom"; variable: Option; create: boolean }
  | { type: "local"; variable: Option; location: Option }
  | { type: "page"; variable: Option; page: Option };

function parseStore(fields: Fields, path: string): StoreSpec | undefined {
  if (!Object.hasOwn(fields, "store")) return undefined;
  const storePath = fieldPath(path, "store");
  const store = expectMapping(fields["store"], storePath);
  const typePath = fieldPath(storePath, "type");
  const type = expectString(requireField(store, "type", storePath), typePath);
  if (!(STORE_TYPES as string[]).includes(type))
    throw new ValidationError(
      typePath,
      `unknown store type "${type}" (expected one of: ${STORE_TYPES.join(", ")})`,
    );
  const storeType = type as StoreType;
  rejectUnknownFields(
    store,
    ["type", ...Object.keys(STORE_KIND_SCHEMAS[storeType])],
    storePath,
  );
  const text = (key: string) =>
    parseStringOrExpression(
      requireField(store, key, storePath),
      fieldPath(storePath, key),
    );
  const variable = text("variable");
  switch (storeType) {
    case "custom": {
      if (!variable.isExpression)
        parseVariableName(variable.value, fieldPath(storePath, "variable"));
      const create = Object.hasOwn(store, "create")
        ? expectBoolean(store["create"], fieldPath(storePath, "create"))
        : false;
      return { type: storeType, variable, create };
    }
    case "local":
      return { type: storeType, variable, location: text("location") };
    case "page":
      return { type: storeType, variable, page: text("page") };
  }
}

/** A named custom variable that `create` does not create must exist. */
function storeReferences(store: StoreSpec, path: string): VariableReference[] {
  if (store.type !== "custom" || store.create || store.variable.isExpression)
    return [];
  return [
    { field: fieldPath(path, "variable"), name: String(store.variable.value) },
  ];
}

function buildStore(store: StoreSpec): Record<string, unknown> {
  const type = STORED_STORE_TYPES[store.type];
  switch (store.type) {
    case "custom":
      return {
        type,
        variableName: store.variable,
        createIfNotExists: store.create,
      };
    case "local":
      return { type, location: store.location, variableName: store.variable };
    case "page":
      return { type, page: store.page, variableName: store.variable };
  }
}
