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
import { ACTION_KINDS } from "./writers/actions.ts";
import {
  ACTION_SET_SCHEMAS,
  ACTION_SETS,
  buttonFieldSchemas,
  CELL_FIELD_SCHEMAS,
  LOCATION_FIELD_SCHEMAS,
} from "./writers/button-control.ts";
import * as button from "./writers/button.ts";
import * as connection from "./writers/connection.ts";
import {
  FEEDBACK_FIELD_SCHEMAS,
  FEEDBACK_KINDS,
  STYLE_FIELD_SCHEMAS,
} from "./writers/feedbacks.ts";
import { writers } from "./writers/index.ts";
import * as page from "./writers/page.ts";
import {
  COLOR_PATTERN,
  NUMERIC_NAME,
  RESERVED_NAMES,
  type TaggedKind,
  VALID_NAME,
} from "./writers/shared.ts";
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
 * `steps` replaces the top-level action lists, so a button with `steps` must
 * have none of them.
 */
const STEPS_EXCLUDE_ACTION_SETS: SchemaFragment = {
  dependentSchemas: {
    steps: {
      $comment: "With `steps`, the top-level action lists are refused.",
      properties: Object.fromEntries(ACTION_SETS.map((set) => [set, false])),
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
    extra: STEPS_EXCLUDE_ACTION_SETS,
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
};

/** A `oneOf` over a table of tagged kinds, each discriminated by `tag`. */
function taggedSchema(
  tag: string,
  description: string,
  kinds: Readonly<
    Record<string, Pick<TaggedKind<unknown>, "doc" | "fieldSchemas">>
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
        { title: `${tag}: ${name}`, description: kind.doc },
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
        "Button text. Line breaks are kept, except that one trailing line break (a `|` block's) is dropped. `$(custom:…)` references in it are checked against the database; other variables are not.",
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
        ...STEPS_EXCLUDE_ACTION_SETS,
      },
    ),
    step: objectSchema(ACTION_SET_SCHEMAS, {
      description: "One step of a button: its own action lists.",
    }),
    action: taggedSchema(
      "action",
      "An action, tagged with `action`. Only `$(custom:…)` references and named variables are checked against the database; pass-through actions are written literally and not checked.",
      ACTION_KINDS,
    ),
    feedback: taggedSchema(
      "feedback",
      "A boolean feedback, tagged with `feedback`, that overrides the button's style while it holds.",
      FEEDBACK_KINDS,
      FEEDBACK_FIELD_SCHEMAS,
    ),
    style: objectSchema(STYLE_FIELD_SCHEMAS, {
      description:
        "The style fields a feedback overrides; at least one. The others keep the button's own style.",
      minProperties: 1,
    }),
    triggerBody: objectSchema(trigger.FIELD_SCHEMAS, {
      description: "One trigger: every `kind: trigger` field, without `kind`.",
    }),
    event: taggedSchema(
      "event",
      "What starts a trigger, tagged with `event`.",
      trigger.EVENT_KINDS,
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
