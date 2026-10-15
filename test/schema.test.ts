/**
 * `companion-cli schema` (#21): the JSON Schema of description files,
 * generated from the writers' tables. It must be a valid draft 2020-12
 * schema, accept exactly what the parsers accept (apart from the documented
 * cross-field rules), name every writer field and nothing else, document
 * every field and kind, and match the committed copy.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { readDescriptionFile } from "../src/core/description.ts";
import { DESCRIPTION_KINDS } from "../src/core/writer.ts";
import { SUPPORT_MATRIX } from "../src/support-matrix.ts";
import {
  descriptionSchema,
  KIND_SCHEMAS,
  renderSchema,
  SCHEMA_FILE,
} from "../src/schema.ts";
import { ACTION_KINDS } from "../src/writers/actions.ts";
import { FEEDBACK_KINDS } from "../src/writers/feedbacks.ts";
import { writers } from "../src/writers/index.ts";
import { EVENT_KINDS } from "../src/writers/trigger.ts";
import { runCli } from "./helpers.ts";
import { agreement, newAjv } from "./schema-check.ts";
import { WRITER_TABLES, writerFields } from "./writer-tables.ts";

type Json = Record<string, unknown>;

const EXAMPLES_DIR = new URL("../examples/", import.meta.url);

/** Every description file under examples/, by path. */
function exampleFiles(): string[] {
  return readdirSync(EXAMPLES_DIR, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".yaml"))
    .sort()
    .map((name) => new URL(name, EXAMPLES_DIR).pathname);
}

const BUTTON = `kind: button
location: { page: 1, row: 0, column: 0 }
text: A
background: "#000000"
`;

/** Descriptions both the schema and the parser accept. */
const VALID: Record<string, string> = {
  "a variable with a boolean default and persist": `kind: variables
variables:
  - { name: a_1, default: true, persist: true, description: "" }
`,
  "a minimal button with empty text, negative cell": `kind: button
location: { page: 2, row: -1, column: -3 }
text: ""
background: "#abcdef"
`,
  "a button with every action kind and rotate keys": `${BUTTON}down:
  - { action: set, variable: v, value: 1.5 }
  - { action: set, variable: v, value: false }
  - { action: expression, variable: v, expression: "1 + 1" }
  - { action: increment, variable: v, by: 3 }
  - { action: decrement, variable: v }
  - { action: passthrough, connection: c, definition: d }
up: []
rotate_left: []
rotate_right:
  - { action: passthrough, connection: c, definition: d, options: { a: [1, null] } }
`,
  "a button with steps and step lists": `kind: button
location: { page: 1, row: 0, column: 0 }
text: A
background: "#000000"
steps:
  - {}
  - { down: [], up: [], rotate_left: [], rotate_right: [] }
feedbacks:
  - { feedback: step, step: 2, style: { textColor: "#FFFFFF" }, invert: false }
`,
  "a button with every option and hold actions": `${BUTTON}progression: expression
stepExpression: "$(custom:v) + 1"
notes: "Line one\\nline two"
apiStyle: true
hold:
  - { after: 1000, whileHeld: true, actions: [{ action: increment, variable: v }] }
  - { after: 3000 }
`,
  "a manual button with hold actions in a step": `${BUTTON}progression: manual
apiStyle: false
notes: ""
steps:
  - {}
  - hold: [{ after: 500, whileHeld: false, actions: [] }]
`,
  "feedback without style": `${BUTTON}feedbacks: [{ feedback: expression, expression: "1" }]\n`,
  "an empty style list": `${BUTTON}feedbacks: [{ feedback: expression, expression: "1", style: [] }]\n`,
  "full entities (#23)": `${BUTTON}down:
  - { action: set, variable: v, value: 1, headline: "", disabled: true, upgradeIndex: -1 }
  - action: passthrough
    connection: internal
    definition: logic_if
    options: { a: { expr: "1 + 1" }, b: { not: expr }, c: { expr: x, y: 1 } }
    children:
      condition:
        - { feedback: passthrough, connection: c, definition: d, style: [] }
      actions:
        - action: passthrough
          connection: internal
          definition: logic_if
          children: { actions: [], else_actions: [] }
      else_actions: []
  - { action: passthrough, connection: c, definition: d, store: { type: custom, variable: v, create: true } }
  - { action: passthrough, connection: c, definition: d, store: { type: custom, variable: { expr: x } } }
  - { action: passthrough, connection: c, definition: d, store: { type: local, variable: v, location: "$(this:location)" } }
  - { action: passthrough, connection: c, definition: d, store: { type: page, variable: { expr: x }, page: { expr: y } } }
feedbacks:
  - feedback: passthrough
    connection: c
    definition: d
    invert: { expr: "1 == 1" }
    variableName: out
    headline: h
    style:
      - { element: text0, property: size, value: 24 }
      - { element: box0, property: color, value: { expr: "$(custom:c)" } }
  - { feedback: step, step: 1, invert: true, disabled: false }
`,
  "a page with no buttons": `kind: page
page: 3
name: Empty
buttons: []
`,
  "a minimal trigger": `kind: trigger
name: t
events: [{ event: startup }]
`,
  "a trigger with every event kind": `kind: trigger
name: t
events:
  - { event: startup, enabled: false }
  - { event: interval, seconds: 5 }
  - { event: intervalRandom, min: 2, max: 9 }
  - { event: timeofday, time: "08:30:00", days: [mon, fri] }
  - { event: specificDate, date: "2026-12-31", time: "23:00" }
  - { event: sun_event, sun: sunset, latitude: 38.72, longitude: -9.14, offset: 10 }
  - { event: client_connect, delay: 0 }
  - { event: button_press }
  - { event: button_release }
  - { event: variable_changed, variable: fx_counter }
  - { event: variable_changed, variableId: "internal:time_hms" }
  - { event: computer_locked }
  - { event: computer_unlocked }
  - { event: condition_true }
  - { event: condition_false, enabled: false }
conditions:
  - { condition: expression, expression: "$(custom:a) > 1", invert: true }
`,
  "a trigger with notes and every condition field": `kind: trigger
name: t
notes: |
  line one
  line two
events: [{ event: interval, seconds: 5 }]
conditions:
  - condition: expression
    expression: "1 > 0"
    invert: { expr: "$(custom:a)" }
    disabled: true
    headline: H
    upgradeIndex: 2
  - condition: passthrough
    connection: internal
    definition: logic_and
    options: { x: 1 }
    children: { feedbacks: [{ feedback: expression, expression: "1 > 0" }] }
`,
  "a surface with every field": `kind: surface
surface: "skaarhoj:SK_1"
name: ""
enabled: false
brightness: 0
rotation: surface-90
xOffset: -1
yOffset: 2
transferInputs: { hwc_1: enc_1, hwc_2: "" }
transferOutputs: { hwc_3: "$(custom:a) + 1" }
plugin: { sleep: 300, nested: { a: [1, null] } }
config: { emulator_rows: 4, canChangePage: true }
`,
  "a surface with rotation 0 only": `kind: surface
surface: s
rotation: 0
`,
};

/** Descriptions both the schema and the parser refuse. */
const INVALID: Record<string, string> = {
  "a list at top level": "- kind: button\n",
  "missing kind": "variables: [{ name: a, default: 1 }]\n",
  "unknown kind": "kind: widget\n",
  "a surface without its id": "kind: surface\nname: S\n",
  "a surface brightness above 100":
    "kind: surface\nsurface: s\nbrightness: 101\n",
  "a surface rotation that is not a choice":
    "kind: surface\nsurface: s\nrotation: 90\n",
  "a surface fractional offset": "kind: surface\nsurface: s\nxOffset: 1.5\n",
  "a surface transfer input that is not a variable name":
    "kind: surface\nsurface: s\ntransferInputs: { a: my-var }\n",
  "a surface transfer output that is not a string":
    "kind: surface\nsurface: s\ntransferOutputs: { a: 1 }\n",
  "a surface config key with a named field":
    "kind: surface\nsurface: s\nconfig: { brightness: 1 }\n",
  "a surface config transfer key":
    "kind: surface\nsurface: s\nconfig: { transfer_input_a: v }\n",
  "a surface config groupId":
    "kind: surface\nsurface: s\nconfig: { groupId: g }\n",
  "an unknown surface field": "kind: surface\nsurface: s\ngroupConfig: {}\n",
  "a kind that is not a string": "kind: 1\n",
  "unknown top-level field": `${BUTTON}comment: hi\n`,
  "an unknown progression": `${BUTTON}progression: random\n`,
  "stepExpression without progression": `${BUTTON}stepExpression: "1"\n`,
  "stepExpression with manual progression": `${BUTTON}progression: manual\nstepExpression: "1"\n`,
  "expression progression without stepExpression": `${BUTTON}progression: expression\n`,
  "an empty stepExpression": `${BUTTON}progression: expression\nstepExpression: ""\n`,
  "a non-string notes": `${BUTTON}notes: 1\n`,
  "a string apiStyle": `${BUTTON}apiStyle: "true"\n`,
  "hold after 0": `${BUTTON}hold: [{ after: 0 }]\n`,
  "a fractional hold after": `${BUTTON}hold: [{ after: 1.5 }]\n`,
  "hold without after": `${BUTTON}hold: [{ actions: [] }]\n`,
  "unknown hold field": `${BUTTON}hold: [{ after: 1, down: [] }]\n`,
  "a string whileHeld": `${BUTTON}hold: [{ after: 1, whileHeld: "yes" }]\n`,
  "steps with top-level hold": `${BUTTON}hold: []\nsteps: [{}]\n`,
  "unknown feedback field": `${BUTTON}feedbacks:
  - { feedback: expression, expression: "1", style: { text: B }, x: 1 }
`,
  "unknown page button field": `kind: page
page: 1
name: P
buttons:
  - { location: { row: 0, column: 0 }, text: A, background: "#000000", x: 1 }
`,
  "unknown variables field":
    "kind: variables\nvariables: [{ name: a, default: 1, x: 1 }]\n",
  "empty variables": "kind: variables\nvariables: []\n",
  "a variable name with a dash":
    "kind: variables\nvariables: [{ name: my-var, default: 1 }]\n",
  "a numeric variable name":
    "kind: variables\nvariables: [{ name: '007', default: 1 }]\n",
  "a reserved variable name":
    "kind: variables\nvariables: [{ name: constructor, default: 1 }]\n",
  "a null default":
    "kind: variables\nvariables: [{ name: a, default: null }]\n",
  "a mapping default":
    "kind: variables\nvariables: [{ name: a, default: {} }]\n",
  "a non-boolean persist":
    "kind: variables\nvariables: [{ name: a, default: 1, persist: 'yes' }]\n",
  "bad colour": `kind: button
location: { page: 1, row: 0, column: 0 }
text: A
background: "#12345"
`,
  "unquoted colour": `kind: button
location: { page: 1, row: 0, column: 0 }
text: A
background: #000000
`,
  "missing text": `kind: button
location: { page: 1, row: 0, column: 0 }
background: "#000000"
`,
  "text that is a number": `kind: button
location: { page: 1, row: 0, column: 0 }
text: 1
background: "#000000"
`,
  "page 0 in a location": `kind: button
location: { page: 0, row: 0, column: 0 }
text: A
background: "#000000"
`,
  "a fractional row": `kind: button
location: { page: 1, row: 1.5, column: 0 }
text: A
background: "#000000"
`,
  "an unsafe integer column": `kind: button
location: { page: 1, row: 0, column: 1152921504606846976 }
text: A
background: "#000000"
`,
  "unknown location field": `kind: button
location: { page: 1, row: 0, column: 0, layer: 1 }
text: A
background: "#000000"
`,
  "wrong action": `${BUTTON}down: [{ action: toggle, variable: v }]\n`,
  "missing action": `${BUTTON}down: [{ variable: v }]\n`,
  "unknown action field": `${BUTTON}down: [{ action: decrement, variable: v, value: 1 }]\n`,
  "by 0": `${BUTTON}down: [{ action: increment, variable: v, by: 0 }]\n`,
  "an empty expression": `${BUTTON}down: [{ action: expression, variable: v, expression: "" }]\n`,
  "a null set value": `${BUTTON}down: [{ action: set, variable: v, value: null }]\n`,
  "an infinite set value": `${BUTTON}down: [{ action: set, variable: v, value: .inf }]\n`,
  "pass-through options as a list": `${BUTTON}down: [{ action: passthrough, connection: c, definition: d, options: [] }]\n`,
  "a nested infinite pass-through option": `${BUTTON}down: [{ action: passthrough, connection: c, definition: d, options: { a: [1, .inf] } }]\n`,
  "pass-through without connection": `${BUTTON}down: [{ action: passthrough, definition: d }]\n`,
  "an action list that is a mapping": `${BUTTON}up: { action: set }\n`,
  "steps with top-level down": `${BUTTON}down: []\nsteps: [{}]\n`,
  "steps with top-level rotate_right": `${BUTTON}rotate_right: []\nsteps: [{}]\n`,
  "empty steps": `${BUTTON}steps: []\n`,
  "unknown step field": `${BUTTON}steps: [{ feedbacks: [] }]\n`,
  "empty style": `${BUTTON}feedbacks: [{ feedback: expression, expression: "1", style: {} }]\n`,
  "unknown style field": `${BUTTON}feedbacks: [{ feedback: expression, expression: "1", style: { size: 1 } }]\n`,
  "wrong feedback": `${BUTTON}feedbacks: [{ feedback: toggle, style: { text: x } }]\n`,
  "step 0": `${BUTTON}feedbacks: [{ feedback: step, step: 0, style: { text: x } }]\n`,
  "a string invert": `${BUTTON}feedbacks: [{ feedback: step, step: 1, style: { text: x }, invert: "yes" }]\n`,
  "an invert expression that is not a string": `${BUTTON}feedbacks: [{ feedback: step, step: 1, invert: { expr: 1 } }]\n`,
  "an expression option that is not a string": `${BUTTON}down: [{ action: passthrough, connection: c, definition: d, options: { a: { expr: 1 } } }]\n`,
  "children on a module action": `${BUTTON}down: [{ action: passthrough, connection: c, definition: d, children: {} }]\n`,
  "children on a module feedback": `${BUTTON}feedbacks: [{ feedback: passthrough, connection: c, definition: d, children: {} }]\n`,
  "children on a named action": `${BUTTON}down: [{ action: set, variable: v, value: 1, children: {} }]\n`,
  "an empty child group name": `${BUTTON}down: [{ action: passthrough, connection: internal, definition: d, children: { "": [] } }]\n`,
  "a child that is neither action nor feedback": `${BUTTON}down: [{ action: passthrough, connection: internal, definition: d, children: { a: [{ event: startup }] } }]\n`,
  "a child group that is a mapping": `${BUTTON}down: [{ action: passthrough, connection: internal, definition: d, children: { a: {} } }]\n`,
  "an unknown store type": `${BUTTON}down: [{ action: passthrough, connection: c, definition: d, store: { type: trigger, variable: v } }]\n`,
  "a local store without location": `${BUTTON}down: [{ action: passthrough, connection: c, definition: d, store: { type: local, variable: v } }]\n`,
  "a page store with create": `${BUTTON}down: [{ action: passthrough, connection: c, definition: d, store: { type: page, variable: v, page: "1", create: true } }]\n`,
  "a custom store with a bad name": `${BUTTON}down: [{ action: passthrough, connection: c, definition: d, store: { type: custom, variable: "a b" } }]\n`,
  "a store on a named action": `${BUTTON}down: [{ action: set, variable: v, value: 1, store: { type: custom, variable: v } }]\n`,
  "a fractional upgradeIndex": `${BUTTON}down: [{ action: decrement, variable: v, upgradeIndex: 1.5 }]\n`,
  "a numeric headline": `${BUTTON}down: [{ action: decrement, variable: v, headline: 1 }]\n`,
  "a string disabled": `${BUTTON}feedbacks: [{ feedback: step, step: 1, disabled: "no" }]\n`,
  "a style override without property": `${BUTTON}feedbacks: [{ feedback: step, step: 1, style: [{ element: text0, value: 1 }] }]\n`,
  "a style override with an empty element": `${BUTTON}feedbacks: [{ feedback: step, step: 1, style: [{ element: "", property: size, value: 1 }] }]\n`,
  "a style override with an unknown field": `${BUTTON}feedbacks: [{ feedback: step, step: 1, style: [{ element: text0, property: size, value: 1, x: 1 }] }]\n`,
  "a numeric variableName": `${BUTTON}feedbacks: [{ feedback: step, step: 1, variableName: 1 }]\n`,
  "a page without buttons": "kind: page\npage: 1\nname: P\n",
  "an empty page name": "kind: page\npage: 1\nname: ''\nbuttons: []\n",
  "a page button with a full location": `kind: page
page: 1
name: P
buttons:
  - { location: { page: 1, row: 0, column: 0 }, text: A, background: "#000000" }
`,
  "a page button with steps and up": `kind: page
page: 1
name: P
buttons:
  - { location: { row: 0, column: 0 }, text: A, background: "#000000", up: [], steps: [{}] }
`,
  "a trigger without events": "kind: trigger\nname: t\nevents: []\n",
  "a trigger with a string enabled":
    "kind: trigger\nname: t\nenabled: 'true'\nevents: [{ event: startup }]\n",
  "unknown event":
    "kind: trigger\nname: t\nevents: [{ event: condition_maybe }]\n",
  "a condition with a style":
    "kind: trigger\nname: t\nevents: [{ event: startup }]\nconditions: [{ condition: expression, expression: '1', style: { text: x } }]\n",
  "a step condition":
    "kind: trigger\nname: t\nevents: [{ event: startup }]\nconditions: [{ condition: step, step: 1 }]\n",
  "a condition with a variableName":
    "kind: trigger\nname: t\nevents: [{ event: startup }]\nconditions: [{ condition: passthrough, connection: c, definition: d, variableName: v }]\n",
  "a trigger with numeric notes":
    "kind: trigger\nname: t\nnotes: 1\nevents: [{ event: startup }]\n",
  "a time of day without seconds":
    "kind: trigger\nname: t\nevents: [{ event: timeofday, time: '08:30' }]\n",
  "an unknown day name":
    "kind: trigger\nname: t\nevents: [{ event: timeofday, time: '08:30:00', days: [monday] }]\n",
  "duplicate days":
    "kind: trigger\nname: t\nevents: [{ event: timeofday, time: '08:00:00', days: [mon, mon] }]\n",
  "a specific date without a time":
    "kind: trigger\nname: t\nevents: [{ event: specificDate, date: '2026-12-31' }]\n",
  "a latitude beyond the pole":
    "kind: trigger\nname: t\nevents: [{ event: sun_event, latitude: 91 }]\n",
  "an unknown sun event":
    "kind: trigger\nname: t\nevents: [{ event: sun_event, sun: noon }]\n",
  "a random interval of zero seconds":
    "kind: trigger\nname: t\nevents: [{ event: intervalRandom, min: 0 }]\n",
  "an event enabled flag as text":
    "kind: trigger\nname: t\nevents: [{ event: button_press, enabled: 'no' }]\n",
  "both variable and variableId":
    "kind: trigger\nname: t\nevents: [{ event: variable_changed, variable: a, variableId: 'internal:a' }]\n",
  "interval 0":
    "kind: trigger\nname: t\nevents: [{ event: interval, seconds: 0 }]\n",
  "a negative startup delay":
    "kind: trigger\nname: t\nevents: [{ event: startup, delay: -1 }]\n",
  "unknown event field":
    "kind: trigger\nname: t\nevents: [{ event: startup, seconds: 1 }]\n",
  "a trigger with a bad variable":
    "kind: trigger\nname: t\nevents: [{ event: variable_changed, variable: 'a b' }]\n",
};

/**
 * Cross-field rules JSON Schema cannot express: the parser refuses these and
 * the schema accepts them, and the schema says so in a `$comment`.
 */
const EXCEPTIONS: Record<string, string> = {
  "a variable_changed event naming no variable":
    "kind: trigger\nname: t\nevents: [{ event: variable_changed }]\n",
  "a variableId on a custom variable":
    "kind: trigger\nname: t\nevents: [{ event: variable_changed, variableId: 'custom:a' }]\n",
  "a condition event without conditions":
    "kind: trigger\nname: t\nevents: [{ event: condition_true }]\n",
  "a random interval with max below min":
    "kind: trigger\nname: t\nevents: [{ event: intervalRandom, min: 5, max: 2 }]\n",
  "a date that is not on the calendar":
    "kind: trigger\nname: t\nevents: [{ event: specificDate, date: '2026-02-30', time: '10:00' }]\n",
  "a step feedback beyond the button's steps": `${BUTTON}feedbacks: [{ feedback: step, step: 2, style: { text: x } }]\n`,
  "duplicate hold durations in a step": `${BUTTON}steps: [{ hold: [{ after: 1 }, { after: 1 }] }]\n`,
  "duplicate variable names":
    "kind: variables\nvariables: [{ name: a, default: 1 }, { name: a, default: 2 }]\n",
  "duplicate page locations": `kind: page
page: 1
name: P
buttons:
  - { location: { row: 0, column: 0 }, text: A, background: "#000000" }
  - { location: { row: 0, column: 0 }, text: B, background: "#000000" }
`,
};

/** The schema's fields in the support matrix's notation (see src/support-matrix.ts). */
function schemaFields(schema: Json): Set<string> {
  const defs = schema["$defs"] as Record<string, Json>;
  const resolve = (node: Json): Json => {
    const target = node["$ref"];
    return typeof target === "string"
      ? (defs[target.replace("#/$defs/", "")] as Json)
      : node;
  };
  const props = (node: Json) =>
    Object.keys((resolve(node)["properties"] as Json | undefined) ?? {});
  const under = (prefix: string, names: readonly string[]) =>
    names.map((name) => `${prefix}.${name}`);
  const tagged = (tag: string, common: readonly string[] = []) =>
    ((defs[tag] as Json)["oneOf"] as Json[]).flatMap((branch) => {
      const kind = ((branch["properties"] as Json)[tag] as Json)["const"];
      const own = props(branch).filter(
        (name) => name !== tag && !common.includes(name),
      );
      return [
        `${tag}: ${kind}`,
        ...own.map((name) => `${tag}: ${kind}.${name}`),
      ];
    });
  /** Fields every branch of a tagged list has besides its tag. */
  const commonTo = (tag: string) => {
    const branches = (defs[tag] as Json)["oneOf"] as Json[];
    return props(branches[0] as Json).filter(
      (name) =>
        name !== tag &&
        branches.every((branch) => props(branch).includes(name)),
    );
  };
  const actionCommon = commonTo("action");
  const feedbackCommon = commonTo("feedback");
  const eventCommon = commonTo("event");
  const conditionCommon = commonTo("condition");
  return new Set([
    ...(schema["oneOf"] as Json[]).flatMap((branch) => {
      const kind = ((branch["properties"] as Json)["kind"] as Json)["const"];
      return [
        `kind: ${kind}`,
        ...under(
          String(kind),
          props(branch).filter((name) => name !== "kind"),
        ),
      ];
    }),
    ...under("variables[]", props(defs["variable"] as Json)),
    ...under("steps[]", props(defs["step"] as Json)),
    ...under("hold[]", props(defs["hold"] as Json)),
    ...tagged("action", actionCommon),
    ...under("action", actionCommon),
    ...tagged("feedback", feedbackCommon),
    ...under("feedback", feedbackCommon),
    ...under("feedback.style", props(defs["styleShortcuts"] as Json)),
    ...under("feedback.style[]", props(defs["styleOverride"] as Json)),
    ...tagged("condition", conditionCommon),
    ...under("condition", conditionCommon),
    ...tagged("event", eventCommon),
    ...under("event", eventCommon),
  ]);
}

/** Every property, kind branch and `$defs` entry without a non-empty `description`. */
function undocumented(node: unknown, path = ""): string[] {
  if (Array.isArray(node))
    return node.flatMap((item, index) =>
      undocumented(item, `${path}[${index}]`),
    );
  if (node === null || typeof node !== "object") return [];
  const object = node as Json;
  const missing: string[] = [];
  const check = (child: unknown, at: string) => {
    const description = (child as Json)["description"];
    if (typeof description !== "string" || description.trim() === "")
      missing.push(at);
  };
  for (const [key, value] of Object.entries(object)) {
    // Examples are data; dependentSchemas only forbid fields.
    if (key === "examples" || key === "dependentSchemas") continue;
    if (key === "properties" || key === "$defs")
      for (const [name, child] of Object.entries(value as Json))
        check(child, `${path}.${key}.${name}`);
    if (key === "oneOf")
      (value as unknown[]).forEach((child, index) =>
        check(child, `${path}.oneOf[${index}]`),
      );
    missing.push(...undocumented(value, `${path}.${key}`));
  }
  return missing;
}

const parsed = (yaml: string) => parseYaml(yaml) as unknown;

describe("schema", () => {
  const schema = descriptionSchema();

  it("is a valid draft 2020-12 schema", () => {
    const ajv = newAjv();
    assert.equal(ajv.validateSchema(schema), true, ajv.errorsText());
    ajv.compile(schema);
    assert.equal(
      schema["$schema"],
      "https://json-schema.org/draft/2020-12/schema",
    );
  });

  it("has one branch per registered kind, in registry order", () => {
    const kinds = (schema["oneOf"] as Json[]).map(
      (branch) => ((branch["properties"] as Json)["kind"] as Json)["const"],
    );
    assert.deepEqual(kinds, Object.keys(writers));
    assert.deepEqual(Object.keys(KIND_SCHEMAS), [...DESCRIPTION_KINDS]);
  });

  it("names every writer field and nothing else", () => {
    assert.deepEqual(
      [...schemaFields(schema)].sort(),
      [...writerFields(WRITER_TABLES)].sort(),
    );
  });

  it("gives a page's buttons every button field", () => {
    const defs = schema["$defs"] as Record<string, Json>;
    const button = (schema["oneOf"] as Json[]).find(
      (branch) => branch["title"] === "kind: button",
    ) as Json;
    const { kind: _kind, ...fields } = button["properties"] as Json;
    assert.deepEqual(
      Object.keys(defs["pageButton"]?.["properties"] as Json),
      Object.keys(fields),
    );
  });

  it("agrees with the support matrix's supported rows", () => {
    const supported = new Set(
      SUPPORT_MATRIX.flatMap((row) =>
        row.status === "supported" ? row.field : [],
      ),
    );
    assert.deepEqual([...schemaFields(schema)].sort(), [...supported].sort());
  });

  it("documents every field, kind and definition", () => {
    assert.deepEqual(undocumented(schema), []);
  });

  it("fails when a field or kind loses its doc", () => {
    const stripped = structuredClone(schema) as Json;
    const defs = stripped["$defs"] as Record<string, Json>;
    const action = (defs["action"]?.["oneOf"] as Json[])[0] as Json;
    delete action["description"];
    const variable = (defs["variable"]?.["properties"] as Json)["name"] as Json;
    variable["description"] = "";
    assert.deepEqual(undocumented(stripped), [
      ".$defs.variable.properties.name",
      ".$defs.action.oneOf[0]",
    ]);
  });

  it("gives every tagged kind a doc and documents exactly its fields", () => {
    for (const table of [ACTION_KINDS, FEEDBACK_KINDS, EVENT_KINDS]) {
      for (const [name, kind] of Object.entries(table)) {
        assert.notEqual(kind.doc.trim(), "", name);
        assert.deepEqual(Object.keys(kind.fieldSchemas), kind.fields, name);
        for (const field of kind.fields)
          assert.notEqual(
            kind.fieldSchemas[field]?.doc.trim() ?? "",
            "",
            `${name}.${field}`,
          );
      }
    }
  });

  it("names the Companion entity each named action and feedback writes", () => {
    for (const name of ["set", "expression", "increment", "decrement"])
      assert.match(
        ACTION_KINDS[name as keyof typeof ACTION_KINDS].doc,
        /`custom_variable_set_value`/,
      );
    assert.match(FEEDBACK_KINDS.step.doc, /`bank_current_step`/);
    assert.match(FEEDBACK_KINDS.expression.doc, /`check_expression`/);
  });

  it("matches the committed schema/description.schema.json", () => {
    assert.equal(
      readFileSync(SCHEMA_FILE, "utf8"),
      renderSchema(),
      "run npm run gen:schema",
    );
  });

  it("renders byte-identically on every run", () => {
    assert.equal(renderSchema(), renderSchema());
  });
});

describe("schema and parser agree", () => {
  for (const [kind, { examples }] of Object.entries(KIND_SCHEMAS)) {
    examples.forEach((yaml, index) => {
      it(`accepts the ${kind} example ${index + 1}`, () => {
        assert.deepEqual(agreement(parsed(yaml)), {
          schema: true,
          parser: true,
        });
      });
    });
  }

  it("finds the repository's example files", () => {
    assert.ok(exampleFiles().length >= 2);
  });

  for (const file of exampleFiles()) {
    it(`accepts ${file.slice(file.indexOf("examples/"))}`, () => {
      assert.deepEqual(agreement(readDescriptionFile(file)), {
        schema: true,
        parser: true,
      });
    });
  }

  for (const [name, yaml] of Object.entries(VALID)) {
    it(`accepts ${name}`, () => {
      assert.deepEqual(agreement(parsed(yaml)), { schema: true, parser: true });
    });
  }

  for (const [name, yaml] of Object.entries(INVALID)) {
    it(`refuses ${name}`, () => {
      assert.deepEqual(agreement(parsed(yaml)), {
        schema: false,
        parser: false,
      });
    });
  }

  for (const [name, yaml] of Object.entries(EXCEPTIONS)) {
    it(`documented exception: ${name} (parser only)`, () => {
      assert.deepEqual(agreement(parsed(yaml)), {
        schema: true,
        parser: false,
      });
    });
  }

  it("states each exception in a $comment", () => {
    const comments = JSON.stringify(descriptionSchema())
      .match(/"\$comment":"[^"]*"/g)
      ?.join("\n");
    assert.match(comments ?? "", /number of the button's steps/);
    assert.match(comments ?? "", /names must be distinct/);
    assert.match(comments ?? "", /locations must be distinct/);
    assert.match(comments ?? "", /durations must be distinct/);
  });
});

describe("companion-cli schema", () => {
  it("prints the schema, pretty-printed, and exits 0", async () => {
    const result = await runCli(["schema"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stderr, []);
    assert.equal(`${result.stdout.join("\n")}\n`, renderSchema());
  });

  it("prints the same document with --json", async () => {
    const result = await runCli(["schema", "--json"]);
    assert.equal(result.code, 0);
    assert.equal(`${result.stdout.join("\n")}\n`, renderSchema());
  });

  it("refuses --db as a usage error", async () => {
    const result = await runCli(["schema", "--db", "x.sqlite"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr.join("\n"), /schema reads no database/);
  });

  it("reports usage errors as JSON under --json", async () => {
    const result = await runCli(["schema", "--json", "extra"]);
    assert.equal(result.code, 2);
    assert.deepEqual(result.stderr, []);
    const error = JSON.parse(result.stdout.join("\n")) as Json;
    assert.equal((error["error"] as Json)["code"], "usage");
  });

  it("refuses unknown options", async () => {
    const result = await runCli(["schema", "--dry-run"]);
    assert.equal(result.code, 2);
  });
});
