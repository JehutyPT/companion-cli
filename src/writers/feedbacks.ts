import { ValidationError } from "../core/errors.ts";
import {
  BOOLEAN,
  field,
  type FieldSchema,
  integer,
  NON_EMPTY_STRING,
  ref,
  requiredField,
  STRING,
} from "../core/field-schema.ts";
import {
  describeType,
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
  buildChildGroups,
  type ChildGroups,
  childReferences,
  parseChildGroups,
} from "./children.ts";
import { newId } from "./ids.ts";
import {
  buildPassthrough,
  CHILDREN_FIELD_SCHEMA,
  CHILDREN_NEED_INTERNAL,
  customReferences,
  ENTITY_FIELD_SCHEMAS,
  ENTITY_FIELDS,
  type EntityCommon,
  entityJson,
  type Option,
  type Passthrough,
  PASSTHROUGH_FIELD_SCHEMAS,
  parseBooleanOrExpression,
  parseColor,
  parseEntityCommon,
  parseOptionValue,
  parsePassthrough,
  parseText,
  prop,
  type TaggedKind,
  taggedKind,
  type TaggedSpec,
  taggedKinds,
  type VariableReference,
} from "./shared.ts";

/**
 * Feedback lists in description files, shared by the button writer and (later)
 * the page and trigger writers. Each entry is tagged with `feedback`:
 *
 *   - { feedback: step, step: 2, style: { background: "#00FF00" } }   # 1-based step
 *   - feedback: expression                       # Companion's boolean expression check
 *     expression: "$(custom:fx_label) == 'on'"
 *     style: { textColor: "#000000", text: "ON" }
 *     invert: true                               # optional, default false
 *   - feedback: passthrough                      # any connection's feedback, literally
 *     connection: FixtureConnectionAAAA
 *     definition: some_feedback_id
 *     options: { input: 1 }                      # optional, default {}
 *     style: { text: "LIVE" }
 *   - feedback: passthrough                      # an advanced feedback: literal overrides
 *     connection: FixtureConnectionAAAA
 *     definition: some_advanced_feedback
 *     style:
 *       - { element: text0, property: size, value: 24 }
 *       - { element: box0, property: color, value: { expr: "$(custom:fx_color)" } }
 *
 * `style` overrides only the given fields while the feedback holds; without
 * it the feedback overrides nothing (advanced and value feedbacks). `invert`
 * may be `{expr: …}`. Every entry also takes `headline`, `disabled`,
 * `upgradeIndex` and `variableName`; a pass-through on connection `internal`
 * takes `children` (children.ts). Shapes: docs/companion-internals.md,
 * "Feedbacks".
 */

/** What a feedback's parse needs to know about the control it belongs to. */
export interface FeedbackContext {
  /** The number of steps the control has; `step` feedbacks must name one. */
  stepCount: number;
}

/** One kind of feedback. Adding a feedback means adding one entry to FEEDBACK_KINDS. */
type FeedbackKind<P> = TaggedKind<P, FeedbackContext>;

const defineKind = <P>(
  kind: Omit<FeedbackKind<P>, "fields">,
): FeedbackKind<P> => taggedKind(kind);

function parseStepNumber(
  value: unknown,
  field: string,
  stepCount: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > stepCount
  ) {
    const got = typeof value === "number" ? String(value) : describeType(value);
    throw new ValidationError(
      field,
      `must be an integer between 1 and ${stepCount}, got ${got}`,
    );
  }
  return value;
}

export const FEEDBACK_KINDS = {
  /**
   * Internal `bank_current_step`: holds while the button is on step `step`
   * (1-based). Companion fills in `$(this:location)` as the button itself.
   */
  step: defineKind({
    doc: "Holds while the button is on the given step. Written as Companion's internal `bank_current_step` feedback, with `$(this:location)` as the button.",
    fieldSchemas: {
      step: requiredField(
        "The step, 1-based. It must not exceed the button's number of steps.",
        {
          ...integer(1),
          $comment:
            "Not expressible here: the step must be at most the number of the button's steps (1 without `steps`).",
        },
      ),
    },
    parse: (fields, path, { stepCount }) => ({
      step: parseStepNumber(
        requireField(fields, "step", path),
        fieldPath(path, "step"),
        stepCount,
      ),
    }),
    references: () => [],
    build: ({ step }) => ({
      definitionId: "bank_current_step",
      connectionId: "internal",
      options: { step: prop(step), location: prop("$(this:location)") },
    }),
  }),
  /** Internal `check_expression`: holds while the expression is true. */
  expression: defineKind({
    doc: "Holds while a Companion boolean expression is true. Written as Companion's internal `check_expression` feedback.",
    fieldSchemas: {
      expression: requiredField(
        "A Companion expression, for example `$(custom:fx_label) == 'on'`. `$(custom:…)` references in it are checked against the database.",
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
    build: ({ expression }) => ({
      definitionId: "check_expression",
      connectionId: "internal",
      options: { expression: prop(expression, true) },
    }),
  }),
  /** Any connection's feedback, written literally. Not checked against the database. */
  passthrough: defineKind<PassthroughFeedback>({
    doc: "Any connection's feedback (boolean, advanced or value), written literally: connection, definition and options are not checked against the database.",
    fieldSchemas: {
      ...PASSTHROUGH_FIELD_SCHEMAS,
      children: CHILDREN_FIELD_SCHEMA,
    },
    schema: CHILDREN_NEED_INTERNAL,
    parse: (fields, path, context) => ({
      ...parsePassthrough(fields, path),
      children: parseChildGroups(fields, path, context),
    }),
    references: ({ children }, path) =>
      childReferences(children, fieldPath(path, "children")),
    build: (payload) => ({
      ...buildPassthrough(payload),
      ...(payload.children
        ? { children: buildChildGroups(payload.children) }
        : {}),
    }),
  }),
};

/** A pass-through feedback's payload. */
interface PassthroughFeedback extends Passthrough {
  children: ChildGroups | undefined;
}

const FEEDBACKS = taggedKinds<FeedbackContext>("feedback")(FEEDBACK_KINDS);

/** Fields every feedback entry accepts besides its kind's own. */
export const FEEDBACK_FIELDS = [
  "style",
  "invert",
  "variableName",
  ...ENTITY_FIELDS,
] as const;

export const FEEDBACK_FIELD_SCHEMAS: Record<
  (typeof FEEDBACK_FIELDS)[number],
  FieldSchema
> = {
  style: field(
    "What the feedback overrides while it holds: a mapping of style shortcuts, or a list of literal overrides. Left out, it overrides nothing.",
    ref("style"),
  ),
  invert: field(
    "Holds while the condition is false instead: true or false, or `{expr: …}`.",
    {
      anyOf: [{ ...BOOLEAN, default: false }, ref("expression")],
    },
  ),
  variableName: field(
    "Companion's `variableName` on the feedback, stored when given; not checked.",
    STRING,
  ),
  ...ENTITY_FIELD_SCHEMAS,
};

/**
 * The style fields a feedback may override, in stored order: the layer and
 * property each overrides, and how its value is parsed.
 */
export const STYLE_FIELDS = {
  background: ["box0", "color", parseColor],
  textColor: ["text0", "color", parseColor],
  text: ["text0", "text", parseText],
} as const;
type StyleField = keyof typeof STYLE_FIELDS;
const STYLE_FIELD_NAMES = Object.keys(STYLE_FIELDS) as StyleField[];

export const STYLE_FIELD_SCHEMAS: Record<StyleField, FieldSchema> = {
  background: field("The background color.", ref("color")),
  textColor: field("The text color.", ref("color")),
  text: field("The button text.", ref("text")),
};

/** One stored style override, before its id is generated. */
export interface StyleOverride {
  elementId: string;
  elementProperty: string;
  override: Option;
}

/** A parsed style: the overrides in stored order and the `$(custom:…)` references in its text. */
interface ParsedStyle {
  overrides: StyleOverride[];
  references: VariableReference[];
}

/** The fields of one literal override in a `style` list. */
export const STYLE_OVERRIDE_FIELD_SCHEMAS: Record<
  "element" | "property" | "value",
  FieldSchema
> = {
  element: requiredField(
    "The style element's id, for example `box0` or `text0`; not checked.",
    NON_EMPTY_STRING,
  ),
  property: requiredField(
    "The element's property, for example `color` or `size`, or the property of an advanced feedback's result; not checked.",
    NON_EMPTY_STRING,
  ),
  value: requiredField(
    'The value, stored as given (colors as integers), or `{expr: "<expression>"}`. Not checked, except that `$(custom:…)` references in a plain `text0` `text` value are checked against the database.',
    ref("optionValue"),
  ),
};

/** A parsed feedback entry: its kind and payload, and the fields every entry takes. */
export type FeedbackSpec = TaggedSpec<typeof FEEDBACK_KINDS> & {
  style: ParsedStyle;
  invert: Option;
  variableName: string | undefined;
  common: EntityCommon;
};

const TEXT_OVERRIDE = STYLE_FIELDS.text;

function parseStyleMapping(fields: Fields, path: string): ParsedStyle {
  rejectUnknownFields(fields, STYLE_FIELD_NAMES, path);
  if (Object.keys(fields).length === 0) {
    throw new ValidationError(
      path,
      `must set at least one of ${STYLE_FIELD_NAMES.join(", ")}`,
    );
  }
  const overrides: StyleOverride[] = [];
  const references: VariableReference[] = [];
  for (const name of STYLE_FIELD_NAMES) {
    if (!Object.hasOwn(fields, name)) continue;
    const [elementId, elementProperty, parse] = STYLE_FIELDS[name];
    const fieldName = fieldPath(path, name);
    const value = parse(fields[name], fieldName);
    overrides.push({ elementId, elementProperty, override: prop(value) });
    if (typeof value === "string")
      references.push(...customReferences(value, fieldName));
  }
  return { overrides, references };
}

function parseStyleList(items: unknown[], path: string): ParsedStyle {
  const overrides: StyleOverride[] = [];
  const references: VariableReference[] = [];
  items.forEach((item, index) => {
    const itemPath = fieldPath(path, index);
    const fields = expectMapping(item, itemPath);
    rejectUnknownFields(
      fields,
      Object.keys(STYLE_OVERRIDE_FIELD_SCHEMAS),
      itemPath,
    );
    const text = (key: string) =>
      expectNonEmptyString(
        requireField(fields, key, itemPath),
        fieldPath(itemPath, key),
      );
    const elementId = text("element");
    const elementProperty = text("property");
    const valuePath = fieldPath(itemPath, "value");
    const override = parseOptionValue(
      requireField(fields, "value", itemPath),
      valuePath,
    );
    overrides.push({ elementId, elementProperty, override });
    if (
      elementId === TEXT_OVERRIDE[0] &&
      elementProperty === TEXT_OVERRIDE[1] &&
      !override.isExpression &&
      typeof override.value === "string"
    )
      references.push(...customReferences(override.value, valuePath));
  });
  return { overrides, references };
}

/** `style`: a mapping of shortcuts or a list of literal overrides; none when left out. */
function parseStyle(fields: Fields, path: string): ParsedStyle {
  if (!Object.hasOwn(fields, "style")) return { overrides: [], references: [] };
  const value = fields["style"];
  const stylePath = fieldPath(path, "style");
  if (Array.isArray(value)) return parseStyleList(value, stylePath);
  if (value !== null && typeof value === "object")
    return parseStyleMapping(value as Fields, stylePath);
  throw new ValidationError(
    stylePath,
    `must be a mapping or a list, got ${describeType(value)}`,
  );
}

/** Parses one feedback entry at `path`. */
export function parseFeedback(
  fields: Fields,
  path: string,
  context: FeedbackContext,
): FeedbackSpec {
  const spec = FEEDBACKS.parse(fields, path, context, FEEDBACK_FIELDS);
  const invert = Object.hasOwn(fields, "invert")
    ? parseBooleanOrExpression(fields["invert"], fieldPath(path, "invert"))
    : prop(false);
  const variableName = Object.hasOwn(fields, "variableName")
    ? expectString(fields["variableName"], fieldPath(path, "variableName"))
    : undefined;
  return {
    ...spec,
    style: parseStyle(fields, path),
    invert,
    variableName,
    common: parseEntityCommon(fields, path),
  };
}

/**
 * Parses an optional feedback list such as `feedbacks`; a missing field is an
 * empty list. `parent` is the path of `fields` (for example `buttons[3]`).
 */
export function parseFeedbackList(
  fields: Fields,
  key: string,
  context: FeedbackContext,
  parent = "",
): FeedbackSpec[] {
  if (!Object.hasOwn(fields, key)) return [];
  const path = fieldPath(parent, key);
  return expectList(fields[key], path).map((item, index) => {
    const itemPath = fieldPath(path, index);
    return parseFeedback(expectMapping(item, itemPath), itemPath, context);
  });
}

/**
 * The custom variables one feedback uses: references in its expression, its
 * children and its style text. Pass-through options are not inspected.
 */
export function feedbackReferences(
  spec: FeedbackSpec,
  path: string,
): VariableReference[] {
  return [...FEEDBACKS.references(spec, path), ...spec.style.references];
}

/**
 * The custom variables a list of feedbacks uses, in file order. `key` is the
 * list's path.
 */
export function feedbackVariableReferences(
  feedbacks: readonly FeedbackSpec[],
  key: string,
): VariableReference[] {
  return feedbacks.flatMap((spec, index) =>
    feedbackReferences(spec, fieldPath(key, index)),
  );
}

/** Companion 5.1 feedback JSON with fresh ids. */
export function buildFeedback(spec: FeedbackSpec): Record<string, unknown> {
  return entityJson(
    "feedback",
    newId(),
    FEEDBACKS.build(spec),
    {
      isInverted: spec.invert,
      styleOverrides: spec.style.overrides.map((override) => ({
        overrideId: newId(),
        ...override,
      })),
      ...(spec.variableName === undefined
        ? {}
        : { variableName: spec.variableName }),
    },
    spec.common,
  );
}
