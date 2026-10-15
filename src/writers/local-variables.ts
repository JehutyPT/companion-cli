import { ValidationError } from "../core/errors.ts";
import {
  BOOLEAN,
  field,
  type FieldSchema,
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
  expectString,
  fieldPath,
  type Fields,
  rejectUnknownFields,
  requireField,
} from "../core/validate.ts";
import {
  buildFeedback,
  type FeedbackContext,
  feedbackReferences,
  type FeedbackSpec,
  parseFeedback,
} from "./feedbacks.ts";
import { newId } from "./ids.ts";
import {
  ENTITY_FIELD_SCHEMAS,
  type EntityCommon,
  entityJson,
  type Option,
  parseEntityCommon,
  parseOptionValue,
  prop,
  variableReferences,
  type VariableReference,
} from "./shared.ts";

/**
 * A control's local variables (`localVariables`), shared by the button
 * description (so also page buttons) and the trigger writer. Each entry names one variable, `$(local:<name>)`, and
 * is one of:
 *
 *   - { name: count, value: 0 }                       # internal user_value
 *   - { name: count, value: 0, persist: true }        # persist: default false
 *   - { name: double, expression: "$(local:count) * 2" }   # internal expression_value
 *   - name: level                                     # any feedback entry
 *     feedback: passthrough
 *     connection: FixtureConnectionAAAA
 *     definition: some_value_feedback
 *
 * Companion stores each as a feedback entity whose `variableName` is the
 * name (docs/companion-internals.md, "Local variables"). Names follow
 * Companion's local rule and are unique per control.
 */

/** Companion's `LocalVariableNamePattern` (shared-lib/lib/LocalVariable.ts), same set of names. */
export const LOCAL_NAME_PATTERN = "^[a-zA-Z0-9_.-]+$";
export const LOCAL_NAME = new RegExp(LOCAL_NAME_PATTERN);
/** LOCAL_NAME_PATTERN in words, for messages. */
export const LOCAL_NAME_RULE = "letters A-Z/a-z, digits, _, - and .";

/** A shortcut entry's fields, by the internal option each is stored as. */
export const LOCAL_SHORTCUT_OPTIONS = {
  value: "startup_value",
  persist: "persist_value",
  expression: "expression",
} as const;

const NAME_FIELD = requiredField(
  "The variable's name, used as `$(local:<name>)` in the control: letters A-Z/a-z, digits, `_`, `-` and `.`, unique among the control's local variables. Stored as `variableName`.",
  { type: "string", pattern: LOCAL_NAME_PATTERN },
);

/** The fields of a `value` entry (internal `user_value`). */
export const LOCAL_VALUE_FIELD_SCHEMAS: Record<string, FieldSchema> = {
  name: NAME_FIELD,
  value: requiredField(
    "The startup value (Companion's `startup_value`): any JSON value, or `{expr: …}`. Written as Companion's internal `user_value`.",
    ref("optionValue"),
  ),
  persist: field(
    "Keep the value across restarts (`persist_value`): Companion then writes the current value back as the startup value. An apply still writes the file's value.",
    { ...BOOLEAN, default: false },
  ),
  ...ENTITY_FIELD_SCHEMAS,
};

/** The fields of an `expression` entry (internal `expression_value`). */
export const LOCAL_EXPRESSION_FIELD_SCHEMAS: Record<string, FieldSchema> = {
  name: NAME_FIELD,
  expression: requiredField(
    "A Companion expression whose result is the variable's value. Written as Companion's internal `expression_value`. `$(custom:…)` references in it are checked against the database, `$(local:…)` ones against the control's local variables.",
    NON_EMPTY_STRING,
  ),
  ...ENTITY_FIELD_SCHEMAS,
};

/** `localVariables` on a button or a trigger. */
export const LOCAL_VARIABLES_FIELD: FieldSchema = field(
  "The control's local variables, in order: each defines `$(local:<name>)` for the control's text, actions and feedbacks.",
  {
    ...list(ref("localVariable"), {
      $comment:
        "Not expressible here: names must be distinct within the control, and every `$(local:…)` reference in the control must name one of them.",
    }),
    default: [],
  },
);

/** `name` on a feedback entry in a local-variables list. */
export const LOCAL_FEEDBACK_NAME_FIELD = NAME_FIELD;

/**
 * Every field a local-variables entry may have, for the support matrix:
 * the shortcuts' fields and `feedback`, which makes the entry a feedback
 * entry (whose own fields are the feedback list's).
 */
export const LOCAL_VARIABLE_FIELDS: readonly string[] = [
  ...new Set([
    ...Object.keys(LOCAL_VALUE_FIELD_SCHEMAS),
    ...Object.keys(LOCAL_EXPRESSION_FIELD_SCHEMAS),
    "feedback",
  ]),
];

/** A parsed local variable: its name and what it is. */
export type LocalVariableSpec = { name: string } & (
  | { kind: "value"; value: Option; persist: boolean; common: EntityCommon }
  | { kind: "expression"; expression: string; common: EntityCommon }
  | { kind: "feedback"; feedback: FeedbackSpec }
);

function parseName(fields: Fields, path: string): string {
  const at = fieldPath(path, "name");
  const name = expectString(requireField(fields, "name", path), at);
  if (!LOCAL_NAME.test(name))
    throw new ValidationError(
      at,
      `invalid local variable name ${JSON.stringify(name)}: use only ${LOCAL_NAME_RULE} (Companion's rule for $(local:<name>))`,
    );
  return name;
}

function parseLocalVariable(
  fields: Fields,
  path: string,
  context: FeedbackContext,
): LocalVariableSpec {
  const name = parseName(fields, path);
  if (Object.hasOwn(fields, "feedback")) {
    if (Object.hasOwn(fields, "variableName"))
      throw new ValidationError(
        fieldPath(path, "variableName"),
        "is not allowed in a local variable: its name is `name`",
      );
    const rest = { ...fields };
    delete rest["name"];
    const feedback = parseFeedback(rest, path, context);
    return { name, kind: "feedback", feedback };
  }
  const hasValue = Object.hasOwn(fields, "value");
  const hasExpression = Object.hasOwn(fields, "expression");
  if (hasValue && hasExpression)
    throw new ValidationError(
      fieldPath(path, "expression"),
      "give either value or expression, not both",
    );
  if (hasExpression) {
    rejectUnknownFields(
      fields,
      Object.keys(LOCAL_EXPRESSION_FIELD_SCHEMAS),
      path,
    );
    return {
      name,
      kind: "expression",
      expression: expectNonEmptyString(
        fields["expression"],
        fieldPath(path, "expression"),
      ),
      common: parseEntityCommon(fields, path),
    };
  }
  if (!hasValue)
    throw new ValidationError(
      fieldPath(path, "value"),
      "is required (or expression, or feedback for any feedback entry)",
    );
  rejectUnknownFields(fields, Object.keys(LOCAL_VALUE_FIELD_SCHEMAS), path);
  return {
    name,
    kind: "value",
    value: parseOptionValue(fields["value"], fieldPath(path, "value")),
    persist: Object.hasOwn(fields, "persist")
      ? expectBoolean(fields["persist"], fieldPath(path, "persist"))
      : false,
    common: parseEntityCommon(fields, path),
  };
}

/**
 * Parses the optional `localVariables` list of `fields` (at `parent`);
 * missing is empty. Refuses a name used twice.
 */
export function parseLocalVariableList(
  fields: Fields,
  context: FeedbackContext,
  parent = "",
): LocalVariableSpec[] {
  if (!Object.hasOwn(fields, "localVariables")) return [];
  const path = fieldPath(parent, "localVariables");
  const seen = new Map<string, string>();
  return expectList(fields["localVariables"], path).map((item, index) => {
    const itemPath = fieldPath(path, index);
    const spec = parseLocalVariable(
      expectMapping(item, itemPath),
      itemPath,
      context,
    );
    const first = seen.get(spec.name);
    if (first !== undefined)
      throw new ValidationError(
        fieldPath(itemPath, "name"),
        `duplicate local variable name ${JSON.stringify(spec.name)} (also at ${first})`,
      );
    seen.set(spec.name, itemPath);
    return spec;
  });
}

/** The names the list defines, for `checkLocalReferences`. */
export function localVariableNames(
  locals: readonly LocalVariableSpec[],
): Set<string> {
  return new Set(locals.map((spec) => spec.name));
}

/**
 * The custom and local variables the list uses, in file order: each
 * expression's references and a feedback entry's (`feedbackReferences`).
 * `key` is the list's path.
 */
export function localVariableReferences(
  locals: readonly LocalVariableSpec[],
  key: string,
): VariableReference[] {
  return locals.flatMap((spec, index) => {
    const path = fieldPath(key, index);
    switch (spec.kind) {
      case "value":
        return [];
      case "expression":
        return variableReferences(
          spec.expression,
          fieldPath(path, "expression"),
        );
      case "feedback":
        return feedbackReferences(spec.feedback, path);
    }
  });
}

/** One local variable as Companion 5.1 stores it, with fresh ids. */
export function buildLocalVariable(
  spec: LocalVariableSpec,
): Record<string, unknown> {
  if (spec.kind === "feedback")
    return buildFeedback({ ...spec.feedback, variableName: spec.name });
  const body =
    spec.kind === "value"
      ? {
          definitionId: "user_value",
          connectionId: "internal",
          options: {
            persist_value: prop(spec.persist),
            startup_value: spec.value,
          },
        }
      : {
          definitionId: "expression_value",
          connectionId: "internal",
          options: { expression: prop(spec.expression, true) },
        };
  return entityJson(
    "feedback",
    newId(),
    body,
    { isInverted: prop(false), styleOverrides: [], variableName: spec.name },
    spec.common,
  );
}
