/**
 * The JSON Schema of each description field, kept beside the parser that
 * validates it. src/schema.ts assembles these into the document that
 * `companion-cli schema` prints (draft 2020-12). Every fragment states its
 * `type`, so the schema says exactly what the parser accepts.
 */

/** JSON Schema keywords. */
export type SchemaFragment = Readonly<Record<string, unknown>>;

/** One description field: its documentation and its JSON Schema. */
export interface FieldSchema {
  /** The field's `description` in the schema. Required and non-empty. */
  readonly doc: string;
  readonly schema: SchemaFragment;
  /** Whether the parser requires the field. */
  readonly required?: boolean;
}

/** An optional field. */
export const field = (doc: string, schema: SchemaFragment): FieldSchema => ({
  doc,
  schema,
});

/** A required field. */
export const requiredField = (
  doc: string,
  schema: SchemaFragment,
): FieldSchema => ({ doc, schema, required: true });

/** A reference to one of the schema's `$defs` (src/schema.ts defines them). */
export const ref = (name: string): SchemaFragment => ({
  $ref: `#/$defs/${name}`,
});

/** A list of `items`. */
export const list = (
  items: SchemaFragment,
  extra: SchemaFragment = {},
): SchemaFragment => ({ type: "array", items, ...extra });

/** A safe integer (`Number.isSafeInteger`), at least `minimum` when given. */
export const integer = (
  minimum = -Number.MAX_SAFE_INTEGER,
): SchemaFragment => ({
  type: "integer",
  minimum,
  maximum: Number.MAX_SAFE_INTEGER,
});

export const STRING: SchemaFragment = { type: "string" };
export const NON_EMPTY_STRING: SchemaFragment = {
  type: "string",
  minLength: 1,
};
export const BOOLEAN: SchemaFragment = { type: "boolean" };
/** A string, number or boolean (a variable's value; YAML cannot write a non-finite JSON number). */
export const SCALAR: SchemaFragment = { type: ["string", "number", "boolean"] };

/**
 * A strict object of `fields`: `additionalProperties: false`, `required` from
 * the fields, `extra` keywords first (for example `description`).
 */
export function objectSchema(
  fields: Readonly<Record<string, FieldSchema>>,
  extra: SchemaFragment = {},
): Record<string, unknown> {
  const required = Object.entries(fields)
    .filter(([, spec]) => spec.required)
    .map(([name]) => name);
  return {
    type: "object",
    ...extra,
    properties: Object.fromEntries(
      Object.entries(fields).map(([name, spec]) => [
        name,
        { description: spec.doc, ...spec.schema },
      ]),
    ),
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}
