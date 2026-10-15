import type { DatabaseSync } from "node:sqlite";
import { parseStoredJson } from "../core/database.ts";
import { CheckError, ValidationError } from "../core/errors.ts";
import {
  BOOLEAN,
  field,
  type FieldSchema,
  integer,
  NON_EMPTY_STRING,
  ref,
  requiredField,
  type SchemaFragment,
  STRING,
} from "../core/field-schema.ts";
import {
  expectBoolean,
  expectInteger,
  expectJsonValue,
  expectMapping,
  expectNonEmptyString,
  expectString,
  fieldPath,
  type Fields,
  isJsonObject,
  rejectUnknownFields,
  requireField,
} from "../core/validate.ts";

/**
 * Companion shapes and rules shared by several writers. Writers (button.ts,
 * page.ts, trigger.ts, variables.ts) never import from a sibling writer; they share code
 * through this module and the other non-writer modules: ids.ts, actions.ts,
 * feedbacks.ts, children.ts and button-control.ts.
 */

/** A wrapped option value, as Companion stores options in layers, actions and feedbacks. */
export function prop<T>(
  value: T,
  isExpression = false,
): { value: T; isExpression: boolean } {
  return { value, isExpression };
}

/**
 * Companion 5.1's own name rule, from `createVariable` in its bundled main.js:
 * a name is valid when replacing `[^\w]` with `_` leaves it unchanged (that is,
 * non-empty and only ASCII letters, digits and `_`), and it is not one of these
 * reserved object keys.
 */
export const VALID_NAME = /^\w+$/;
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/**
 * Stricter than Companion: the `id` column is declared `STRING`, which SQLite
 * gives NUMERIC affinity, so a name such as `007` or `1e5` is stored as the
 * number 7 or 100000. Those names pass Companion's rule but cannot round-trip.
 */
export const NUMERIC_NAME = /^\d+(?:[eE]\d+)?$/;

/** Validates a custom variable name, for definitions and references alike. */
export function parseVariableName(value: unknown, field: string): string {
  const name = expectString(value, field);
  if (!VALID_NAME.test(name)) {
    throw new ValidationError(
      field,
      `invalid variable name "${name}": use only letters A-Z/a-z, digits and _ (Companion's rule for $(custom:<name>))`,
    );
  }
  if (RESERVED_NAMES.has(name)) {
    throw new ValidationError(
      field,
      `variable name "${name}" is reserved by Companion`,
    );
  }
  if (NUMERIC_NAME.test(name)) {
    throw new ValidationError(
      field,
      `variable name "${name}" looks like a number; Companion's database would store it as ${Number(name)} and lose the name`,
    );
  }
  return name;
}

/** A `#RRGGBB` color, as a JSON Schema pattern. */
export const COLOR_PATTERN = "^#[0-9A-Fa-f]{6}$";
const COLOR = new RegExp(COLOR_PATTERN);

/** A quoted `#RRGGBB` color, stored as the integer `0xRRGGBB`. */
export function parseColor(value: unknown, field: string): number {
  if (value === null) {
    throw new ValidationError(
      field,
      'is empty; quote the color, for example "#000080" (an unquoted # starts a YAML comment)',
    );
  }
  const text = expectString(value, field);
  if (!COLOR.test(text)) {
    throw new ValidationError(
      field,
      `must be a color "#RRGGBB", got "${text}"`,
    );
  }
  return parseInt(text.slice(1), 16);
}

/**
 * Companion stores line breaks in button text as a literal backslash-n. One
 * trailing newline (a `|` block scalar's) is dropped first.
 */
export function parseText(value: unknown, field: string): string {
  const text = expectString(value, field);
  return (text.endsWith("\n") ? text.slice(0, -1) : text).replaceAll(
    "\n",
    "\\n",
  );
}

/**
 * An expression in a description: a mapping with exactly the key `expr`,
 * holding the expression text. Stored as `{value: <text>, isExpression: true}`.
 */
export function isExpressionMapping(
  value: unknown,
): value is { expr: unknown } {
  return (
    isJsonObject(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, "expr")
  );
}

function parseExpressionMapping(value: { expr: unknown }, field: string) {
  return prop(expectString(value.expr, fieldPath(field, "expr")), true);
}

/**
 * A pass-through option value: `{expr: "<expression>"}` is an expression,
 * anything else a plain JSON value.
 */
export function parseOptionValue(value: unknown, field: string): Option {
  if (isExpressionMapping(value)) return parseExpressionMapping(value, field);
  expectJsonValue(value, field);
  return prop(value);
}

/** A string or `{expr: "<expression>"}`, as stored. */
export function parseStringOrExpression(value: unknown, field: string): Option {
  if (isExpressionMapping(value)) return parseExpressionMapping(value, field);
  return prop(expectString(value, field));
}

/** A boolean or `{expr: "<expression>"}`, as stored. */
export function parseBooleanOrExpression(
  value: unknown,
  field: string,
): Option {
  if (isExpressionMapping(value)) return parseExpressionMapping(value, field);
  return prop(expectBoolean(value, field));
}

/**
 * Fields every action and feedback entry accepts, whatever its kind
 * (Companion's `EntityModelBase`). Each is stored only when given.
 */
export const ENTITY_FIELD_SCHEMAS: Record<
  "headline" | "disabled" | "upgradeIndex",
  FieldSchema
> = {
  headline: field(
    "A label Companion's editor shows for the entry. Stored only when given.",
    STRING,
  ),
  disabled: field(
    "Whether Companion skips the entry. Stored only when given.",
    BOOLEAN,
  ),
  upgradeIndex: field(
    "Where the connection's upgrade scripts start for this entry. Left out, Companion fills in the connection's current index when it loads; stored exactly when given.",
    integer(),
  ),
};

export const ENTITY_FIELDS = Object.keys(ENTITY_FIELD_SCHEMAS) as Array<
  keyof typeof ENTITY_FIELD_SCHEMAS
>;

/** The common entity fields given in an entry. */
export interface EntityCommon {
  headline?: string;
  disabled?: boolean;
  upgradeIndex?: number;
}

export function parseEntityCommon(fields: Fields, path: string): EntityCommon {
  const common: EntityCommon = {};
  if (Object.hasOwn(fields, "headline"))
    common.headline = expectString(
      fields["headline"],
      fieldPath(path, "headline"),
    );
  if (Object.hasOwn(fields, "disabled"))
    common.disabled = expectBoolean(
      fields["disabled"],
      fieldPath(path, "disabled"),
    );
  if (Object.hasOwn(fields, "upgradeIndex"))
    common.upgradeIndex = expectInteger(
      fields["upgradeIndex"],
      fieldPath(path, "upgradeIndex"),
    );
  return common;
}

/**
 * An entry's stored JSON around its kind's body: `extra` (a feedback's
 * fields), `children` exactly when the connection is `internal`, as Companion
 * stores entities (`{}` unless the body has child groups), and the common
 * fields when given.
 */
export function entityJson(
  type: "action" | "feedback",
  id: string,
  { children, ...body }: EntityBody,
  extra: Record<string, unknown>,
  common: EntityCommon,
): Record<string, unknown> {
  return {
    type,
    id,
    ...body,
    ...extra,
    ...(body.connectionId === "internal" ? { children: children ?? {} } : {}),
    ...common,
  };
}

/**
 * A pass-through action or feedback: any connection's definition, written
 * literally. Connection ids, definition ids and option values are not checked
 * against the database. An option value `{expr: "<expression>"}` is stored as
 * an expression.
 */
export const PASSTHROUGH_FIELD_SCHEMAS: Record<string, FieldSchema> = {
  connection: requiredField(
    "The connection id, written literally and not checked against the database.",
    NON_EMPTY_STRING,
  ),
  definition: requiredField(
    "The connection's definition id, written literally and not checked against the database.",
    NON_EMPTY_STRING,
  ),
  options: field(
    'The definition\'s options, not checked. Each value is stored as a plain value, except `{expr: "<expression>"}`, which is stored as an expression.',
    {
      type: "object",
      additionalProperties: { $ref: "#/$defs/optionValue" },
      default: {},
    },
  ),
};

/** `children` on a pass-through entry; `#/$defs/children` describes the groups. */
export const CHILDREN_FIELD_SCHEMA: FieldSchema = field(
  "Child entries by group, for internal entities that have them (such as `logic_if`). Only on connection `internal`: Companion discards the children of other connections' entities.",
  ref("children"),
);

/** A pass-through entry with `children` must be on connection `internal`. */
export const CHILDREN_NEED_INTERNAL: SchemaFragment = {
  dependentSchemas: {
    children: {
      $comment: "`children` only on connection `internal`.",
      properties: { connection: { const: "internal" } },
    },
  },
};

export interface Passthrough {
  connection: string;
  definition: string;
  options: Record<string, Option>;
}

export function parsePassthrough(fields: Fields, path: string): Passthrough {
  const optionsPath = fieldPath(path, "options");
  const options = Object.hasOwn(fields, "options")
    ? expectMapping(fields["options"], optionsPath)
    : {};
  const connection = expectNonEmptyString(
    requireField(fields, "connection", path),
    fieldPath(path, "connection"),
  );
  const definition = expectNonEmptyString(
    requireField(fields, "definition", path),
    fieldPath(path, "definition"),
  );
  const parsed = Object.fromEntries(
    Object.entries(options).map(([key, value]) => [
      key,
      parseOptionValue(value, fieldPath(optionsPath, key)),
    ]),
  );
  if (Object.hasOwn(fields, "children") && connection !== "internal")
    throw new ValidationError(
      fieldPath(path, "children"),
      `is only allowed on connection internal, not "${connection}": Companion discards the children of other connections' entities`,
    );
  return { connection, definition, options: parsed };
}

export function buildPassthrough({
  connection,
  definition,
  options,
}: Passthrough): EntityBody {
  return { definitionId: definition, connectionId: connection, options };
}

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

/** Refuses the first reference to a custom variable the database does not have. */
export function checkVariablesExist(
  db: DatabaseSync,
  references: readonly VariableReference[],
): void {
  const known = new Set(
    db
      .prepare("SELECT id FROM custom_variables")
      .all()
      .map((row) => String(row["id"])),
  );
  for (const { field, name } of references) {
    if (!known.has(name))
      throw new CheckError(field, `unknown custom variable "${name}"`, {
        hint: "run companion-cli list variables",
      });
  }
}

/** A wrapped option value. */
export type Option = ReturnType<typeof prop>;

/** Companion action or feedback JSON for a kind: definition, connection and options. */
export interface EntityBody {
  definitionId: string;
  connectionId: string;
  options: Record<string, Option>;
  /** An action's `storeResult`, when given. */
  storeResult?: Record<string, unknown>;
  /** Built child groups, when given; `entityJson` stores `{}` otherwise on internal entities. */
  children?: Record<string, Record<string, unknown>[]>;
}

/**
 * One kind of a tagged entry in a description file, such as an action
 * (`action: set`) or a feedback (`feedback: step`). `P` is its parsed
 * payload, `C` what parsing needs to know about the surrounding control, and
 * `B` what it builds.
 */
export interface TaggedKind<P, C = undefined, B = EntityBody> {
  /** What the kind does: the kind's `description` in the schema. */
  readonly doc: string;
  /** Fields the entry accepts besides the tag (and the table's common fields). */
  readonly fields: readonly string[];
  /** Each of `fields`, documented, in the same order. */
  readonly fieldSchemas: Readonly<Record<string, FieldSchema>>;
  /** More JSON Schema keywords for the entry, for rules across its fields. */
  readonly schema?: SchemaFragment;
  /** Validates the kind's fields (unknown fields are already rejected). */
  parse(fields: Fields, path: string, context: C): P;
  /** Custom variables the kind's fields use, in field order; checked against the database. */
  references(payload: P, path: string): VariableReference[];
  build(payload: P): B;
}

/** A tagged kind whose `fields` are the keys of its `fieldSchemas`. */
export function taggedKind<P, C = undefined, B = EntityBody>(
  kind: Omit<TaggedKind<P, C, B>, "fields">,
): TaggedKind<P, C, B> {
  return { ...kind, fields: Object.keys(kind.fieldSchemas) };
}

/** A parsed tagged entry: its kind name and that kind's payload. */
export type TaggedSpec<T> = {
  [K in keyof T & string]: {
    kind: K;
    payload: T[K] extends TaggedKind<infer P, never, unknown> ? P : never;
  };
}[keyof T & string];

/** The operations on one table of tagged kinds. */
export interface TaggedTable<T, C, B> {
  /**
   * Reads the tag, rejects unknown fields (the kind's and `commonFields` are
   * allowed) and parses the kind's fields. The caller parses `commonFields`.
   */
  parse(
    fields: Fields,
    path: string,
    context: C,
    commonFields?: readonly string[],
  ): TaggedSpec<T>;
  references(spec: TaggedSpec<T>, path: string): VariableReference[];
  build(spec: TaggedSpec<T>): B;
}

/**
 * A table of tagged kinds keyed by tag value, for example
 * `taggedKinds<undefined, EntityBody>("action")({ set: …, passthrough: … })`.
 * Adding a kind means adding one entry to the table.
 */
export function taggedKinds<C = undefined, B = EntityBody>(tag: string) {
  return <T extends Record<string, TaggedKind<unknown, C, B>>>(
    kinds: T,
  ): TaggedTable<T, C, B> => {
    const names = Object.keys(kinds);
    const kindOf = (spec: TaggedSpec<T>) =>
      kinds[spec.kind] as TaggedKind<unknown, C, B>;
    return {
      parse(fields, path, context, commonFields = []) {
        const tagPath = fieldPath(path, tag);
        const name = expectString(requireField(fields, tag, path), tagPath);
        if (!Object.hasOwn(kinds, name)) {
          throw new ValidationError(
            tagPath,
            `unknown ${tag} "${name}" (expected one of: ${names.join(", ")})`,
          );
        }
        const kind = kinds[name] as TaggedKind<unknown, C, B>;
        rejectUnknownFields(
          fields,
          [tag, ...kind.fields, ...commonFields],
          path,
        );
        return {
          kind: name,
          payload: kind.parse(fields, path, context),
        } as TaggedSpec<T>;
      },
      references: (spec, path) => kindOf(spec).references(spec.payload, path),
      build: (spec) => kindOf(spec).build(spec.payload),
    };
  };
}

/**
 * The sort order after the highest of `orders`: one more than the maximum,
 * or 0 when there are none. When every order is negative it is 0 too.
 */
export function nextSortOrder(orders: Iterable<number>): number {
  return Math.max(-1, ...orders) + 1;
}

/**
 * Every page-numbered `pages` row, parsed, by page number. Rows with other
 * keys are ignored. The `id` column has NUMERIC affinity, so keys come back
 * as numbers and are read as text first.
 */
export function readPageRows(db: DatabaseSync): Map<number, unknown> {
  const pages = new Map<number, unknown>();
  for (const row of db.prepare("SELECT id, value FROM pages").all()) {
    const key = String(row["id"]);
    if (/^[1-9]\d*$/.test(key))
      pages.set(Number(key), parseStoredJson(row["value"]));
  }
  return pages;
}

/**
 * How many pages Companion 5.1 loads: its page store reads rows "1", "2", …
 * and stops at the first missing or falsy one. Counting only JSON objects is
 * stricter: a row holding a list or a number also ends the run, so a writer
 * never relies on one.
 */
export function loadedPageCount(pages: ReadonlyMap<number, unknown>): number {
  let count = 0;
  while (isJsonObject(pages.get(count + 1))) count += 1;
  return count;
}

/** `1 button`, `2 buttons`. */
export const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;
