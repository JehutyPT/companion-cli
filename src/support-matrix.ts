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
  unsupported(
    "page",
    "pages.name (empty or missing)",
    "a page description needs a name; set one in Companion",
  ),
  unsupported(
    "page",
    "pages.controls (missing, shared, null or non-button cells)",
    "a cell whose control has no row, is held by another cell or page, is null, or is not a `bank:` control",
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
  unsupported(
    "button option",
    "options.rotaryActions = false with rotate actions",
    "rotate actions Companion ignores; apply would turn them on",
  ),
  supported(
    "button option",
    'options.stepProgression = "auto"',
    ["button.progression"],
    "the default",
  ),
  supported("button option", 'options.stepProgression = "manual"', [
    "button.progression",
  ]),
  supported("button option", 'options.stepProgression = "expression"', [
    "button.progression",
  ]),
  supported(
    "button option",
    "options.stepExpression",
    ["button.stepExpression"],
    'with `progression: expression`; `""` otherwise',
  ),
  unsupported(
    "button option",
    "options.stepExpression (without expression progression)",
    "Companion keeps a stale expression after the progression changes; apply would clear it",
  ),
  unsupported(
    "button option",
    "options.stepExpression (empty, with expression progression)",
    "Companion allows it after switching to expression progression; a description requires an expression",
  ),
  supported(
    "button option",
    "options.canModifyStyleInApis",
    ["button.apiStyle"],
    "Companion's default `false` unless `apiStyle: true`; the CLI never uses the style API",
  ),
  supported("button option", "options.notes", ["button.notes"]),

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
  supported(
    "step",
    "action_sets.<duration>",
    ["button.hold", "steps[].hold", "hold[].after", "hold[].actions"],
    "hold action sets, keyed by a positive whole number of milliseconds",
  ),
  unsupported(
    "step",
    "action_sets.<duration> (other keys)",
    "any other key, such as `1.5` or `1e3`, which Companion reads as a number but is not a positive whole number",
  ),
  supported(
    "step",
    "options.runWhileHeld",
    ["hold[].whileHeld"],
    "the while-held durations, in hold-entry order",
  ),
  unsupported(
    "step",
    "options.runWhileHeld (without its hold set)",
    "a duration with no hold set in the step, or listed twice",
  ),
  unsupported("step", "options (other keys)", "such as a step `name`"),

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
  unsupported(
    "style",
    "text0.text (trailing or raw line break)",
    "a text ending in `\\n`, or holding a line-feed character, does not round-trip",
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
  unsupported(
    "feedback",
    "feedback.styleOverrides (empty)",
    "a boolean feedback that overrides no style",
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
  supported(
    "trigger",
    "several triggers in one file",
    ["kind: triggers", "triggers.triggers"],
    "each entry is a `kind: trigger` body; `export triggers` writes one",
  ),

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
    "intervalRandom",
    tagged("event", "intervalRandom", ["min", "max"]),
    "`minimum` and `maximum`",
  ),
  supported(
    "event",
    "timeofday",
    tagged("event", "timeofday", ["time", "days"]),
    'time "HH:MM:SS"; day names in the file, numbers 0–6 (Sunday 0) stored',
  ),
  supported(
    "event",
    "specificDate",
    tagged("event", "specificDate", ["date", "time"]),
    'date "YYYY-MM-DD", time "HH:MM:SS" or "HH:MM"',
  ),
  supported(
    "event",
    "sun_event",
    tagged("event", "sun_event", ["sun", "latitude", "longitude", "offset"]),
    "`sun` is stored as `type`",
  ),
  supported(
    "event",
    "client_connect",
    tagged("event", "client_connect", ["delay"]),
  ),
  supported("event", "button_press", tagged("event", "button_press", [])),
  supported("event", "button_release", tagged("event", "button_release", [])),
  supported(
    "event",
    "variable_changed (custom: variables)",
    tagged("event", "variable_changed", ["variable"]),
  ),
  supported(
    "event",
    "variable_changed (other variables)",
    ["event: variable_changed.variableId"],
    "any `<label>:<name>`, including `local:`; not checked against the database",
  ),
  planned(
    "event",
    "condition_true",
    "#26",
    "fires when the trigger's conditions change",
  ),
  planned(
    "event",
    "condition_false",
    "#26",
    "fires when the trigger's conditions change",
  ),
  supported(
    "event",
    "computer_locked",
    tagged("event", "computer_locked", []),
    "Companion registers it on macOS and Windows only; Companion on Linux ignores it",
  ),
  supported(
    "event",
    "computer_unlocked",
    tagged("event", "computer_unlocked", []),
    "Companion registers it on macOS and Windows only; Companion on Linux ignores it",
  ),
  supported(
    "event",
    "enabled = false",
    ["event.enabled"],
    "on any event; enabled by default",
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
  supported(
    "connection",
    "label",
    ["kind: connection", "connection.connection", "connection.label"],
    "a rename is refused while controls reference the old label",
  ),
  supported("connection", "enabled", ["connection.enabled"]),
  supported(
    "connection",
    "config keys",
    ["connection.config"],
    "merged; checked against the module's fields when Companion runs",
  ),
  supported(
    "connection",
    "secrets",
    ["connection.secrets"],
    "from the environment, write only; never exported",
  ),
  supported(
    "connection",
    "isFirstInit",
    [],
    "set to false with a config, as Companion does",
  ),
  unsupported(
    "connection",
    "rename while referenced",
    "Companion rewrites references on its own rename; a database write cannot. Planned only with an ADR",
  ),
  unsupported("connection", "create"),
  unsupported("connection", "delete"),
  unsupported("connection", "module"),
  unsupported("connection", "version"),
  unsupported("connection", "update policy"),
  unsupported("connection", "removing config keys", "planned only with an ADR"),
  unsupported("connection", "sortOrder"),
  unsupported("connection", "collectionId"),

  // Surfaces
  supported(
    "surface",
    "name",
    ["kind: surface", "surface.surface", "surface.name"],
    "an existing surface, by its stored id",
  ),
  supported("surface", "enabled", ["surface.enabled"]),
  supported(
    "surface",
    "Companion-owned config",
    [
      "surface.brightness",
      "surface.rotation",
      "surface.xOffset",
      "surface.yOffset",
    ],
    "merged",
  ),
  supported(
    "surface",
    "transfer_input_*",
    ["surface.transferInputs"],
    "a custom variable, checked",
  ),
  supported(
    "surface",
    "transfer_output_*",
    ["surface.transferOutputs"],
    "an expression; $(custom:…) references checked",
  ),
  supported("surface", "plugin_cfg_*", ["surface.plugin"]),
  supported(
    "surface",
    "other config keys",
    ["surface.config"],
    "merged; checked against the surface's config fields when it is connected",
  ),
  unsupported(
    "surface",
    "groupId",
    "a surface in a manual group is refused on export",
  ),
  unsupported("surface", "groupConfig", "kept as stored, never exported"),
  unsupported("surface", "removing config keys"),
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

- **supported**: apply writes it, and export reads it back (custom variables, triggers, pages and buttons). *Field* is the description field (\`action: set.value\` is the \`value\` field of an \`action: set\` entry); a supported row without one is a value the writers keep or always write.
- **planned**: not in the format yet; the ticket adds it.
- **unsupported**: not planned. Apply never writes it, export refuses content that has it, and \`list\` and \`find\` still show it.

An export refusal names the stored field it cannot express; this file says whether that field is planned.
`;

/**
 * The usage census note (#15), rendered as the last section. The user records
 * it after running \`companion-cli census\` on a copy of their database: the
 * date, the summary counts per area and the order of #23–#27 it led to. No
 * module or definition lists: this file is public.
 */
export const CENSUS_NOTE = `Not yet run. The user runs \`companion-cli census\` on a copy of their database (see the README) and records here the date, the summary counts per area and the order of tickets #23–#27 it leads to, without module or definition lists.`;

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
  const census = `## Census\n\n${CENSUS_NOTE}\n`;
  return [HEADER, ...sections, census].join("\n");
}
