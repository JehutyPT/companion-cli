import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  type FieldSchema,
  objectSchema,
  ref,
  requiredField,
  type SchemaFragment,
} from "./core/field-schema.ts";
import type { DescriptionKind } from "./core/writer.ts";
import {
  ACTION_KINDS,
  STORE_KIND_SCHEMAS,
  STORED_STORE_TYPES,
} from "./writers/actions.ts";
import {
  buttonFieldSchemas,
  CELL_FIELD_SCHEMAS,
  HOLD_FIELD_SCHEMAS,
  LOCATION_FIELD_SCHEMAS,
  STEP_FIELD_SCHEMAS,
  STEP_FIELDS,
} from "./writers/button-control.ts";
import * as button from "./writers/button.ts";
import * as connection from "./writers/connection.ts";
import {
  CONDITION_FIELD_SCHEMAS,
  CONDITION_KINDS,
  FEEDBACK_FIELD_SCHEMAS,
  FEEDBACK_KINDS,
  STYLE_FIELD_SCHEMAS,
  STYLE_OVERRIDE_FIELD_SCHEMAS,
} from "./writers/feedbacks.ts";
import { writers } from "./writers/index.ts";
import {
  LOCAL_EXPRESSION_FIELD_SCHEMAS,
  LOCAL_FEEDBACK_NAME_FIELD,
  LOCAL_VALUE_FIELD_SCHEMAS,
} from "./writers/local-variables.ts";
import * as page from "./writers/page.ts";
import {
  COLOR_PATTERN,
  ENTITY_FIELD_SCHEMAS,
  NUMERIC_NAME,
  RESERVED_NAMES,
  type TaggedKind,
  VALID_NAME,
} from "./writers/shared.ts";
import * as surface from "./writers/surface.ts";
import * as trigger from "./writers/trigger.ts";
import * as variables from "./writers/variables.ts";

/**
 * The JSON Schema (draft 2020-12) of description files, generated from the
 * writers' tables: `companion-cli schema` prints it, and
 * `npm run gen:schema` writes the committed copy that editors use
 * (schema/description.schema.json). A test checks that the schema accepts
 * exactly what the writers' parsers accept, apart from the cross-field rules
 * listed in `$comment`s.
 */

export const SCHEMA_ID =
  "https://github.com/JehutyPT/companion-cli/schema/description.schema.json";

/** Where editors fetch the committed schema; exports name it in their modeline. */
export const SCHEMA_URL =
  "https://raw.githubusercontent.com/JehutyPT/companion-cli/main/schema/description.schema.json";

/** The YAML language server's modeline, for the top of a description file. */
export const SCHEMA_MODELINE = `# yaml-language-server: $schema=${SCHEMA_URL}`;

/** The committed copy. */
export const SCHEMA_FILE = fileURLToPath(
  new URL("../schema/description.schema.json", import.meta.url),
);

/** One description kind: what it does, examples, and its fields besides `kind`. */
export interface KindSchema {
  doc: string;
  /** YAML description files; the schema shows them as JSON. */
  examples: readonly string[];
  fields: Readonly<Record<string, FieldSchema>>;
  /** More keywords for the kind's object, such as `dependentSchemas`. */
  extra?: SchemaFragment;
}

/**
 * A button's cross-field rules: `steps` replaces the top-level action lists,
 * so a button with `steps` must have none of them; `stepExpression` goes
 * with `progression: expression` and nothing else.
 */
const BUTTON_RULES: SchemaFragment = {
  dependentSchemas: {
    steps: {
      $comment: "With `steps`, the top-level action lists are refused.",
      properties: Object.fromEntries(STEP_FIELDS.map((set) => [set, false])),
    },
    stepExpression: {
      $comment: "`stepExpression` needs `progression: expression`.",
      required: ["progression"],
      properties: { progression: { const: "expression" } },
    },
  },
  if: {
    required: ["progression"],
    properties: {
      progression: {
        description: "`progression: expression` needs `stepExpression`.",
        const: "expression",
      },
    },
  },
  then: {
    required: ["stepExpression"],
    properties: {
      stepExpression: {
        description: "Required with `progression: expression`.",
      },
    },
  },
};

/** Every description kind's schema. Adding a kind means adding an entry. */
export const KIND_SCHEMAS: Record<DescriptionKind, KindSchema> = {
  variables: {
    doc: variables.DOC,
    examples: variables.EXAMPLES,
    fields: variables.TOP_LEVEL_FIELD_SCHEMAS,
  },
  button: {
    doc: button.DOC,
    examples: button.EXAMPLES,
    fields: buttonFieldSchemas(
      requiredField("Where the button goes.", ref("location")),
    ),
    extra: BUTTON_RULES,
  },
  page: {
    doc: page.DOC,
    examples: page.EXAMPLES,
    fields: page.FIELD_SCHEMAS,
  },
  trigger: {
    doc: trigger.DOC,
    examples: trigger.EXAMPLES,
    fields: trigger.FIELD_SCHEMAS,
  },
  triggers: {
    doc: trigger.TRIGGERS_DOC,
    examples: trigger.TRIGGERS_EXAMPLES,
    fields: trigger.TRIGGERS_FIELD_SCHEMAS,
  },
  connection: {
    doc: connection.DOC,
    examples: connection.EXAMPLES,
    fields: connection.FIELD_SCHEMAS,
    extra: connection.EXTRA_SCHEMA,
  },
  surface: {
    doc: surface.DOC,
    examples: surface.EXAMPLES,
    fields: surface.FIELD_SCHEMAS,
  },
};

/** A `oneOf` over a table of tagged kinds, each discriminated by `tag`. */
function taggedSchema(
  tag: string,
  description: string,
  kinds: Readonly<
    Record<string, Pick<TaggedKind<unknown>, "doc" | "fieldSchemas" | "schema">>
  >,
  common: Readonly<Record<string, FieldSchema>> = {},
): Record<string, unknown> {
  return {
    description,
    oneOf: Object.entries(kinds).map(([name, kind]) =>
      objectSchema(
        {
          [tag]: requiredField(`Selects the ${name} ${tag}.`, {
            const: name,
          }),
          ...kind.fieldSchemas,
          ...common,
        },
        { title: `${tag}: ${name}`, description: kind.doc, ...kind.schema },
      ),
    ),
  };
}

function defs(): Record<string, unknown> {
  return {
    variableName: {
      description:
        "A custom variable name: letters A-Z/a-z, digits and _ (Companion's rule for `$(custom:<name>)`), not a name Companion reserves, and not one that looks like a number.",
      type: "string",
      pattern: VALID_NAME.source,
      not: {
        anyOf: [
          { enum: [...RESERVED_NAMES] },
          { pattern: NUMERIC_NAME.source },
        ],
      },
    },
    color: {
      description:
        'A color "#RRGGBB". Quote it in YAML: an unquoted # starts a comment.',
      type: "string",
      pattern: COLOR_PATTERN,
    },
    text: {
      description:
        "Button text. Line breaks are kept, except that one trailing line break (a `|` block's) is dropped. `$(custom:…)` references in it are checked against the database and `$(local:…)` ones against the button's local variables; other variables are not.",
      type: "string",
    },
    jsonValue: {
      description:
        "Any JSON value: null, a boolean, a finite number, a string, or a list or mapping of JSON values.",
      type: ["null", "boolean", "number", "string", "array", "object"],
      items: { $ref: "#/$defs/jsonValue" },
      additionalProperties: { $ref: "#/$defs/jsonValue" },
    },
    variable: objectSchema(variables.VARIABLE_FIELD_SCHEMAS, {
      description: "One custom variable.",
    }),
    location: objectSchema(LOCATION_FIELD_SCHEMAS, {
      description: "A button's page, row and column.",
    }),
    cell: objectSchema(CELL_FIELD_SCHEMAS, {
      description: "A button's row and column on the page.",
    }),
    pageButton: objectSchema(
      buttonFieldSchemas(
        requiredField("Where the button goes on the page.", ref("cell")),
      ),
      {
        description:
          "A button on the page: every `kind: button` field, with a location of row and column only.",
        ...BUTTON_RULES,
      },
    ),
    step: objectSchema(STEP_FIELD_SCHEMAS, {
      description: "One step of a button: its own action lists.",
    }),
    hold: objectSchema(HOLD_FIELD_SCHEMAS, {
      description:
        "A hold action set: actions run once the button has been held `after` milliseconds.",
    }),
    expression: {
      description:
        'A Companion expression instead of a plain value: `{expr: "<expression>"}`, stored as `{value: <expression>, isExpression: true}`.',
      type: "object",
      properties: {
        expr: {
          description: "The expression text; not checked.",
          type: "string",
        },
      },
      required: ["expr"],
      additionalProperties: false,
    },
    optionValue: {
      description:
        "A plain JSON value, or `{expr: …}` (a mapping with exactly the key `expr`) for an expression. A plain mapping with exactly the key `expr` cannot be written.",
      if: {
        type: "object",
        properties: {
          expr: {
            description: "Any value: the expression text when a string.",
          },
        },
        required: ["expr"],
        maxProperties: 1,
      },
      then: { $ref: "#/$defs/expression" },
      else: { $ref: "#/$defs/jsonValue" },
    },
    stringOrExpression: {
      description: "A string, or `{expr: …}` for an expression.",
      anyOf: [{ type: "string" }, { $ref: "#/$defs/expression" }],
    },
    action: taggedSchema(
      "action",
      "An action, tagged with `action`. Only `$(custom:…)` references and named variables are checked against the database; pass-through actions are written literally and not checked.",
      ACTION_KINDS,
      ENTITY_FIELD_SCHEMAS,
    ),
    feedback: taggedSchema(
      "feedback",
      "A feedback, tagged with `feedback`, that overrides the button's style while it holds.",
      FEEDBACK_KINDS,
      FEEDBACK_FIELD_SCHEMAS,
    ),
    children: {
      description:
        "Child entries by group name (for example `actions` and `else_actions` of `logic_if`), in order. Each child is an action or a feedback entry; a group may be empty.",
      type: "object",
      propertyNames: { minLength: 1 },
      additionalProperties: {
        type: "array",
        items: {
          anyOf: [{ $ref: "#/$defs/action" }, { $ref: "#/$defs/feedback" }],
        },
      },
    },
    store: {
      description:
        "Where Companion stores an action's result, selected by `type`.",
      oneOf: Object.entries(STORE_KIND_SCHEMAS).map(([type, fields]) =>
        objectSchema(
          {
            type: requiredField(
              `Stores into a ${STORED_STORE_TYPES[type as keyof typeof STORED_STORE_TYPES]}.`,
              { const: type },
            ),
            ...fields,
          },
          {
            title: `store: ${type}`,
            description: `Companion's \`${STORED_STORE_TYPES[type as keyof typeof STORED_STORE_TYPES]}\` result target.`,
          },
        ),
      ),
    },
    style: {
      description:
        "What a feedback overrides while it holds: a mapping of style shortcuts, or a list of literal overrides in stored order.",
      anyOf: [
        { $ref: "#/$defs/styleShortcuts" },
        { type: "array", items: { $ref: "#/$defs/styleOverride" } },
      ],
    },
    styleShortcuts: objectSchema(STYLE_FIELD_SCHEMAS, {
      description:
        "The style fields a feedback overrides; at least one. The others keep the button's own style.",
      minProperties: 1,
    }),
    styleOverride: objectSchema(STYLE_OVERRIDE_FIELD_SCHEMAS, {
      description:
        "One literal style override: an element's property and its value.",
    }),
    localVariable: {
      description:
        "One local variable, `$(local:<name>)`: a `value` (internal `user_value`), an `expression` (internal `expression_value`), or any feedback entry with `name`.",
      anyOf: [
        { $ref: "#/$defs/localValue" },
        { $ref: "#/$defs/localExpression" },
        { $ref: "#/$defs/localFeedback" },
      ],
    },
    localValue: objectSchema(LOCAL_VALUE_FIELD_SCHEMAS, {
      title: "local variable: value",
      description:
        "A user value: Companion's internal `user_value`, starting at `value`.",
    }),
    localExpression: objectSchema(LOCAL_EXPRESSION_FIELD_SCHEMAS, {
      title: "local variable: expression",
      description:
        "An expression's result: Companion's internal `expression_value`.",
    }),
    localFeedback: taggedSchema(
      "feedback",
      "Any feedback entry as a local variable, with `name` instead of `variableName`.",
      FEEDBACK_KINDS,
      {
        name: LOCAL_FEEDBACK_NAME_FIELD,
        ...Object.fromEntries(
          Object.entries(FEEDBACK_FIELD_SCHEMAS).filter(
            ([key]) => key !== "variableName",
          ),
        ),
      },
    ),
    triggerBody: objectSchema(trigger.FIELD_SCHEMAS, {
      description: "One trigger: every `kind: trigger` field, without `kind`.",
    }),
    event: taggedSchema(
      "event",
      "What starts a trigger, tagged with `event`.",
      trigger.EVENT_KINDS,
      trigger.EVENT_FIELD_SCHEMAS,
    ),
    condition: taggedSchema(
      "condition",
      "A trigger condition, tagged with `condition`: a boolean feedback that must hold for the trigger's actions to run.",
      CONDITION_KINDS,
      CONDITION_FIELD_SCHEMAS,
    ),
  };
}

function kindSchema(kind: DescriptionKind): Record<string, unknown> {
  const { doc, examples, fields, extra = {} } = KIND_SCHEMAS[kind];
  return objectSchema(
    {
      kind: requiredField("The description kind.", { const: kind }),
      ...fields,
    },
    {
      title: `kind: ${kind}`,
      description: doc,
      examples: examples.map((yaml) => parseYaml(yaml) as unknown),
      ...extra,
    },
  );
}

/** The schema document, kinds in the writer registry's order. */
export function descriptionSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: SCHEMA_ID,
    title: "companion-cli description file",
    description:
      "A file that `companion-cli apply` writes into Companion 5.1's database. `kind` selects what it describes. Only `$(custom:…)` references are checked against the database.",
    oneOf: (Object.keys(writers) as DescriptionKind[]).map(kindSchema),
    $defs: defs(),
  };
}

/** The schema as printed and committed: 2-space indent, trailing newline. */
export function renderSchema(): string {
  return `${JSON.stringify(descriptionSchema(), null, 2)}\n`;
}
