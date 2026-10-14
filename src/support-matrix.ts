import { fileURLToPath } from "node:url";

/**
 * The support matrix (ADR 0006): for each part of what Companion 5.1 stores,
 * whether the description format supports it, plans to, or does not.
 * docs/support-matrix.md is generated from this table by
 * `npm run gen:support-matrix`, and test/support-matrix.test.ts checks it
 * against the writers' tables and Companion's own lists.
 *
 * `item` is the Companion name: an option key (`options.notes`), an entity
 * field (`action.disabled`), an event or control type (`timeofday`), with a
 * qualifier after a space when one name has rows of different status.
 *
 * `field` lists the description fields a supported row covers, in this
 * notation (the test derives the same set from the writers):
 *
 *   kind: button              a description kind
 *   button.text               a top-level field of a kind's description
 *   steps[].down              a field of each entry of a list
 *   action: set               a tagged kind (action, feedback, event)
 *   action: set.value         a field of that kind
 *   feedback.style.text       a field common to every entry of a tagged list
 *
 * A supported row with no field is stored by the writers without a
 * description field (a value they keep or always write).
 */

export const AREAS = [
  "control type",
  "page",
  "button",
  "button option",
  "step",
  "style",
  "action",
  "feedback",
  "local variable",
  "trigger",
  "trigger option",
  "event",
  "condition",
  "custom variable",
  "connection",
  "surface",
] as const;

export type Area = (typeof AREAS)[number];

export type Status = "supported" | "planned" | "unsupported";

export interface MatrixRow {
  area: Area;
  /** The Companion name. */
  item: string;
  status: Status;
  /** The description fields, when supported; otherwise empty. */
  field: readonly string[];
  /** The planned ticket (`#24`), when planned. */
  ticket?: string;
  /** One line. */
  note: string;
}

const supported = (
  area: Area,
  item: string,
  field: readonly string[],
  note = "",
): MatrixRow => ({ area, item, status: "supported", field, note });

const planned = (
  area: Area,
  item: string,
  ticket: string,
  note = "",
): MatrixRow => ({ area, item, status: "planned", field: [], ticket, note });

const unsupported = (area: Area, item: string, note = ""): MatrixRow => ({
  area,
  item,
  status: "unsupported",
  field: [],
  note,
});

/** A tagged kind and its fields, in the field notation. */
export const tagged = (
  tag: string,
  kind: string,
  fields: readonly string[],
) => [`${tag}: ${kind}`, ...fields.map((field) => `${tag}: ${kind}.${field}`)];

const PASSTHROUGH = ["connection", "definition", "options"];

export const SUPPORT_MATRIX: readonly MatrixRow[] = [
  // Control types
  supported(
    "control type",
    "button-layered",
    ["kind: button", "button.location"],
    "on a page cell",
  ),
  supported("control type", "trigger", ["kind: trigger"]),
  unsupported(
    "control type",
    "page",
    "the `page:<id>` control Companion creates for each page; never written",
  ),
  unsupported(
    "control type",
    "pageup",
    "page navigation button; a page apply deletes it with the rest",
  ),
  unsupported(
    "control type",
    "pagenum",
    "page navigation button; a page apply deletes it with the rest",
  ),
  unsupported(
    "control type",
    "pagedown",
    "page navigation button; a page apply deletes it with the rest",
  ),
  unsupported(
    "control type",
    "button",
    "pre-layered button type; Companion upgrades it to `button-layered` at load",
  ),
  unsupported("control type", "preset:button", "a module preset"),
  unsupported("control type", "preset-reference", "a button showing a preset"),
  unsupported("control type", "button-reference", "a button mirroring another"),
  unsupported("control type", "expression-variable"),

  // Pages
  supported("page", "pages.id", ["kind: page", "page.page"], "the page number"),
  supported(
    "page",
    "pages.name",
    ["page.name"],
    "a page beyond the last plus one also creates the pages in between (ADR 0004)",
  ),
  supported(
    "page",
    "pages.controls",
    ["page.buttons"],
    "every cell of the page; each entry is a button with a cell location",
  ),

  // Buttons
  supported(
    "button",
    "steps",
    ["button.steps"],
    "one step from the top-level action lists, or the `steps` list",
  ),
  supported("button", "feedbacks", ["button.feedbacks"]),

  // Button options
  supported(
    "button option",
    "options.rotaryActions",
    [],
    "set when any step lists rotate actions",
  ),
  supported(
    "button option",
    'options.stepProgression = "auto"',
    [],
    "always written",
  ),
  planned("button option", 'options.stepProgression = "manual"', "#24"),
  planned("button option", 'options.stepProgression = "expression"', "#24"),
  planned("button option", "options.stepExpression", "#24"),
  planned(
    "button option",
    "options.canModifyStyleInApis",
    "#24",
    "the writer stores `true` today; #24 adds opt-in `apiStyle` and Companion's default `false`; the CLI never uses the style API",
  ),
  planned("button option", "options.notes", "#24"),

  // Steps
  supported("step", "action_sets.down", ["button.down", "steps[].down"]),
  supported("step", "action_sets.up", ["button.up", "steps[].up"]),
  supported("step", "action_sets.rotate_left", [
    "button.rotate_left",
    "steps[].rotate_left",
  ]),
  supported("step", "action_sets.rotate_right", [
    "button.rotate_right",
    "steps[].rotate_right",
  ]),
  planned("step", "action_sets.<duration>", "#24", "hold-duration action sets"),
  planned("step", "options.runWhileHeld", "#24"),
  unsupported("step", "options (other keys)"),

  // Style
  supported(
    "style",
    "layers (four-layer template)",
    [],
    "`canvas`, `box0`, `image0`, `text0`, written from a template",
  ),
  supported(
    "style",
    "box0.color",
    ["button.background", "feedback.style.background"],
    "also as a feedback override",
  ),
  supported(
    "style",
    "text0.color",
    ["button.textColor", "feedback.style.textColor"],
    "also as a feedback override",
  ),
  supported(
    "style",
    "text0.text",
    ["button.text", "feedback.style.text"],
    "also as a feedback override",
  ),
  unsupported("style", "other layer properties"),
  unsupported("style", "extra layers"),
  unsupported("style", "images"),
  unsupported("style", "expression-valued properties"),

  // Actions
  supported(
    "action",
    "custom_variable_set_value (value)",
    tagged("action", "set", ["variable", "value"]),
  ),
  supported(
    "action",
    "custom_variable_set_value (expression)",
    tagged("action", "expression", ["variable", "expression"]),
  ),
  supported(
    "action",
    "custom_variable_set_value (increment)",
    tagged("action", "increment", ["variable", "by"]),
  ),
  supported(
    "action",
    "custom_variable_set_value (decrement)",
    tagged("action", "decrement", ["variable", "by"]),
  ),
  supported(
    "action",
    "module action",
    tagged("action", "passthrough", PASSTHROUGH),
    "any connection's action, with literal options",
  ),
  supported("action", "action.id", [], "generated"),
  supported("action", "action.type", [], "always `action`"),
  supported("action", "action.definitionId", [], "from the action kind"),
  supported("action", "action.connectionId", [], "from the action kind"),
  supported("action", "action.options", [], "literal values"),
  planned("action", "action.options (expression values)", "#23"),
  planned("action", "action.disabled", "#23"),
  planned("action", "action.headline", "#23"),
  planned("action", "action.upgradeIndex", "#23"),
  planned("action", "action.children", "#23"),
  planned("action", "action.storeResult", "#23"),

  // Feedbacks
  supported(
    "feedback",
    "bank_current_step",
    tagged("feedback", "step", ["step"]),
  ),
  supported(
    "feedback",
    "check_expression",
    tagged("feedback", "expression", ["expression"]),
  ),
  supported(
    "feedback",
    "module feedback",
    tagged("feedback", "passthrough", PASSTHROUGH),
    "any connection's boolean feedback, with literal options",
  ),
  supported("feedback", 'feedbackType = "boolean"', []),
  planned("feedback", 'feedbackType = "advanced"', "#23"),
  planned("feedback", 'feedbackType = "value"', "#23"),
  planned(
    "feedback",
    'feedbackType = "style-override"',
    "#23",
    "the feedback list type of a layered button's style list",
  ),
  supported("feedback", "feedback.id", [], "generated"),
  supported("feedback", "feedback.type", [], "always `feedback`"),
  supported("feedback", "feedback.definitionId", [], "from the feedback kind"),
  supported("feedback", "feedback.connectionId", [], "from the feedback kind"),
  supported("feedback", "feedback.options", [], "literal values"),
  planned("feedback", "feedback.options (expression values)", "#23"),
  supported("feedback", "feedback.isInverted", ["feedback.invert"]),
  planned("feedback", "feedback.isInverted (expression)", "#23"),
  supported(
    "feedback",
    "feedback.styleOverrides",
    [
      "feedback.style",
      "feedback.style.background",
      "feedback.style.textColor",
      "feedback.style.text",
    ],
    "on `box0.color`, `text0.color` and `text0.text`",
  ),
  planned(
    "feedback",
    "feedback.styleOverrides (other element properties)",
    "#23",
  ),
  planned("feedback", "feedback.disabled", "#23"),
  planned("feedback", "feedback.headline", "#23"),
  planned("feedback", "feedback.upgradeIndex", "#23"),
  planned("feedback", "feedback.children", "#23"),
  planned(
    "feedback",
    "feedback.variableName",
    "#25",
    "names a feedback's value in a local-variables list",
  ),

  // Local variables
  planned("local variable", "localVariables (button)", "#25"),
  planned("local variable", "localVariables (trigger)", "#25"),

  // Triggers
  supported("trigger", "events", ["trigger.events"]),
  supported("trigger", "actions", ["trigger.actions"]),

  // Trigger options
  supported("trigger option", "options.name", ["trigger.name"], "the identity"),
  supported("trigger option", "options.enabled", ["trigger.enabled"]),
  supported(
    "trigger option",
    "options.sortOrder",
    [],
    "kept; a new trigger goes after the highest",
  ),
  supported("trigger option", "options.collectionId", [], "kept"),
  planned("trigger option", "options.notes", "#26", 'reset to "" today'),

  // Conditions
  planned("condition", "condition", "#26", "boolean feedback entities"),

  // Events
  supported("event", "startup", tagged("event", "startup", ["delay"])),
  supported("event", "interval", tagged("event", "interval", ["seconds"])),
  supported(
    "event",
    "variable_changed (custom: variables)",
    tagged("event", "variable_changed", ["variable"]),
  ),
  planned("event", "variable_changed (other variables)", "#27"),
  planned("event", "intervalRandom", "#27"),
  planned("event", "timeofday", "#27"),
  planned("event", "specificDate", "#27"),
  planned("event", "sun_event", "#27"),
  planned("event", "client_connect", "#27"),
  planned("event", "button_press", "#27"),
  planned("event", "button_release", "#27"),
  planned("event", "condition_true", "#27"),
  planned("event", "condition_false", "#27"),
  planned("event", "computer_locked", "#27", "macOS and Windows only"),
  planned("event", "computer_unlocked", "#27", "macOS and Windows only"),
  planned(
    "event",
    "enabled = false",
    "#27",
    "disabled events; the writer stores every event enabled",
  ),

  // Custom variables
  supported("custom variable", "name", [
    "kind: variables",
    "variables.variables",
    "variables[].name",
  ]),
  supported(
    "custom variable",
    "defaultValue (string, number, boolean)",
    ["variables[].default"],
    "a persisted variable keeps its stored value",
  ),
  supported("custom variable", "description", ["variables[].description"]),
  supported("custom variable", "persistCurrentValue", ["variables[].persist"]),
  supported(
    "custom variable",
    "sortOrder",
    [],
    "kept; a new variable goes after the highest",
  ),
  unsupported("custom variable", "defaultValue (null, object or list)"),

  // Connections
  planned("connection", "label", "#31"),
  planned("connection", "enabled", "#31"),
  planned("connection", "config keys", "#31", "merged"),
  planned("connection", "secrets", "#31", "from the environment, write only"),
  unsupported("connection", "create"),
  unsupported("connection", "delete"),
  unsupported("connection", "module"),
  unsupported("connection", "version"),
  unsupported("connection", "update policy"),
  unsupported("connection", "removing config keys"),

  // Surfaces
  planned("surface", "name", "#32"),
  planned("surface", "enabled", "#32"),
  planned("surface", "Companion-owned config", "#32", "merged"),
  planned("surface", "transfer_input_*", "#32"),
  planned("surface", "transfer_output_*", "#32"),
  planned("surface", "plugin_cfg_*", "#32"),
  planned("surface", "other config keys", "#32", "merged"),
  unsupported("surface", "groupId"),
  unsupported("surface", "groupConfig"),
  unsupported("surface", "surface groups"),
  unsupported("surface", "outbound surfaces"),
  unsupported("surface", "creating or forgetting surfaces"),
];

/** Where the generated doc is committed. */
export const SUPPORT_MATRIX_DOC = fileURLToPath(
  new URL("../docs/support-matrix.md", import.meta.url),
);

const HEADER = `# Support matrix

<!-- Generated from src/support-matrix.ts by \`npm run gen:support-matrix\`. Do not edit by hand. -->

What the description format covers of what Companion 5.1 stores. Export and apply cover the same surface ([ADR 0006](adr/0006-export-apply-symmetry.md)), and \`npm test\` fails when this file disagrees with the writers or omits an item from Companion's own lists.

- **supported**: apply writes it, and export (#18, #19, not yet built) reads it back. *Field* is the description field (\`action: set.value\` is the \`value\` field of an \`action: set\` entry); a supported row without one is a value the writers keep or always write.
- **planned**: not in the format yet; the ticket adds it.
- **unsupported**: not planned. Apply never writes it, export (once built) refuses content that has it, and \`list\` and \`find\` still show it.

An export refusal names the stored field it cannot express; this file says whether that field is planned.
`;

const code = (text: string) => `\`${text}\``;

/** A cell's text, safe inside a Markdown table row. */
const cell = (text: string) => text.replaceAll("|", "\\|");

function statusText(row: MatrixRow): string {
  return row.status === "planned" ? `planned (${row.ticket})` : row.status;
}

/** docs/support-matrix.md for `rows`: one section per area, rows in table order. */
export function renderSupportMatrix(rows: readonly MatrixRow[]): string {
  const sections = AREAS.flatMap((area) => {
    const inArea = rows.filter((row) => row.area === area);
    if (inArea.length === 0) return [];
    const title = area[0]!.toUpperCase() + area.slice(1);
    return [
      [
        `## ${title}`,
        "",
        "| Item | Status | Field | Note |",
        "| --- | --- | --- | --- |",
        ...inArea.map(
          (row) =>
            `| ${cell(code(row.item))} | ${statusText(row)} | ${cell(row.field.map(code).join(", "))} | ${cell(row.note)} |`,
        ),
      ].join("\n") + "\n",
    ];
  });
  return [HEADER, ...sections].join("\n");
}
