import { ValidationError } from "../core/errors.ts";
import {
  describeType,
  expectBoolean,
  expectList,
  expectMapping,
  expectNonEmptyString,
  fieldPath,
  type Fields,
  rejectUnknownFields,
  requireField,
} from "../core/validate.ts";
import { newId } from "./ids.ts";
import {
  buildPassthrough,
  customReferences,
  PASSTHROUGH_FIELDS,
  parseColor,
  parsePassthrough,
  parseText,
  prop,
  type TaggedKind,
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
 *
 * `style` overrides only the given fields while the feedback holds. Shapes:
 * docs/companion-internals.md, "Feedbacks".
 */

/** What a feedback's parse needs to know about the control it belongs to. */
export interface FeedbackContext {
  /** The number of steps the control has; `step` feedbacks must name one. */
  stepCount: number;
}

/** One kind of feedback. Adding a feedback means adding one entry to FEEDBACK_KINDS. */
type FeedbackKind<P> = TaggedKind<P, FeedbackContext>;

const defineKind = <P>(kind: FeedbackKind<P>): FeedbackKind<P> => kind;

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

const FEEDBACK_KINDS = {
  /**
   * Internal `bank_current_step`: holds while the button is on step `step`
   * (1-based). Companion fills in `$(this:location)` as the button itself.
   */
  step: defineKind({
    fields: ["step"],
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
    fields: ["expression"],
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
  passthrough: defineKind({
    fields: PASSTHROUGH_FIELDS,
    parse: parsePassthrough,
    references: () => [],
    build: buildPassthrough,
  }),
};

const FEEDBACKS = taggedKinds<FeedbackContext>("feedback")(FEEDBACK_KINDS);

/**
 * The style fields a feedback may override, in stored order: the layer and
 * property each overrides, and how its value is parsed.
 */
const STYLE_FIELDS = {
  background: ["box0", "color", parseColor],
  textColor: ["text0", "color", parseColor],
  text: ["text0", "text", parseText],
} as const;
type StyleField = keyof typeof STYLE_FIELDS;
const STYLE_FIELD_NAMES = Object.keys(STYLE_FIELDS) as StyleField[];

/** Given style fields, as stored (colors as integers, text with literal backslash-n). */
export type StyleOverrides = Partial<Record<StyleField, number | string>>;

/** A parsed feedback entry: its kind and payload, style and invert flag. */
export type FeedbackSpec = TaggedSpec<typeof FEEDBACK_KINDS> & {
  style: StyleOverrides;
  invert: boolean;
};

function parseStyle(value: unknown, path: string): StyleOverrides {
  const fields = expectMapping(value, path);
  rejectUnknownFields(fields, STYLE_FIELD_NAMES, path);
  if (Object.keys(fields).length === 0) {
    throw new ValidationError(
      path,
      `must set at least one of ${STYLE_FIELD_NAMES.join(", ")}`,
    );
  }
  const style: StyleOverrides = {};
  for (const name of STYLE_FIELD_NAMES) {
    const parse = STYLE_FIELDS[name][2];
    if (Object.hasOwn(fields, name))
      style[name] = parse(fields[name], fieldPath(path, name));
  }
  return style;
}

function parseFeedback(
  item: unknown,
  path: string,
  context: FeedbackContext,
): FeedbackSpec {
  const fields = expectMapping(item, path);
  const spec = FEEDBACKS.parse(fields, path, context, ["style", "invert"]);
  const style = parseStyle(
    requireField(fields, "style", path),
    fieldPath(path, "style"),
  );
  const invert = Object.hasOwn(fields, "invert")
    ? expectBoolean(fields["invert"], fieldPath(path, "invert"))
    : false;
  return { ...spec, style, invert };
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
  return expectList(fields[key], path).map((item, index) =>
    parseFeedback(item, fieldPath(path, index), context),
  );
}

/**
 * The custom variables a list of feedbacks uses, in file order: references
 * in expressions and in style text. Pass-through options are not inspected.
 * `key` is the list's path.
 */
export function feedbackVariableReferences(
  feedbacks: readonly FeedbackSpec[],
  key: string,
): VariableReference[] {
  return feedbacks.flatMap((spec, index) => {
    const path = fieldPath(key, index);
    const text = spec.style.text;
    return [
      ...FEEDBACKS.references(spec, path),
      ...(typeof text === "string"
        ? customReferences(text, fieldPath(fieldPath(path, "style"), "text"))
        : []),
    ];
  });
}

/** Companion 5.1 boolean feedback JSON with fresh ids. */
export function buildFeedback(spec: FeedbackSpec): Record<string, unknown> {
  return {
    type: "feedback",
    id: newId(),
    ...FEEDBACKS.build(spec),
    isInverted: prop(spec.invert),
    styleOverrides: STYLE_FIELD_NAMES.flatMap((name) => {
      const value = spec.style[name];
      if (value === undefined) return [];
      const [elementId, elementProperty] = STYLE_FIELDS[name];
      return [
        {
          overrideId: newId(),
          elementId,
          elementProperty,
          override: prop(value),
        },
      ];
    }),
    children: {},
  };
}
