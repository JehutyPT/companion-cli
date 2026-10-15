import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  FIXTURE_CONTROL_A,
  FIXTURE_CONTROL_B,
} from "./fixtures/companion-db.ts";
import {
  applyTo,
  applyYaml,
  assertTablesUnchangedExcept,
  CONTROL_ID,
  dumpDatabase,
  fileState,
  generatedIds,
  ID,
  type Json,
  normaliseIds,
  page,
  printedBackupDir,
  prop,
  rows,
  runCli,
  setup,
  stripIds,
  type TableDump,
  writeDescription,
  assertJsonTwin,
  forbiddenProcessControl,
  assertRefusalCode,
} from "./helpers.ts";

/** The control referenced at a location, with its id. */
function controlAt(
  dump: TableDump,
  row: number,
  column: number,
): { id: string; control: Json } {
  const controls = page(dump)["controls"] as Record<
    string,
    Record<string, string>
  >;
  const id = controls[String(row)]?.[String(column)];
  assert.ok(id, `control at ${row}/${column}`);
  const control = rows(dump, "controls").get(id);
  assert.ok(control, `controls row ${id}`);
  return { id, control };
}

function downActions(control: Json, set = "down"): Json[] {
  const steps = control["steps"] as Record<
    string,
    { action_sets: Record<string, Json[]> }
  >;
  return steps["0"]?.action_sets[set] ?? [];
}

/** Every JSON key path in a value, with list indices and step keys collapsed. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => keyPaths(item, `${prefix}[]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => {
      const path = `${prefix}.${key}`;
      if (path.endsWith(".action_sets")) return [path];
      return [path, ...keyPaths(child, path)];
    });
  }
  return [];
}

const geometry = {
  enabled: prop(true),
  opacity: prop(100),
  x: prop(0),
  y: prop(0),
  width: prop(100),
  height: prop(100),
  rotation: prop(0),
};

/** The prototype's `layers(text, bg, fg)`, written out. */
function prototypeLayers(text: string, bg: number, fg: number): Json[] {
  return [
    {
      id: "canvas",
      name: "Canvas",
      usage: "auto",
      type: "canvas",
      decoration: prop("default"),
      showStatusIcons: prop("default"),
    },
    {
      id: "box0",
      name: "Background",
      usage: "auto",
      type: "box",
      ...geometry,
      color: prop(bg),
      borderWidth: prop(0),
      borderColor: prop(0),
      borderPosition: prop("inside"),
      pinnedProperties: ["color"],
    },
    {
      id: "image0",
      name: "Image",
      usage: "auto",
      type: "image",
      ...geometry,
      base64Image: prop(null),
      halign: prop("center"),
      valign: prop("center"),
      fillMode: prop("fit"),
      pinnedProperties: ["base64Image", "halign", "valign"],
    },
    {
      id: "text0",
      name: "Text",
      usage: "auto",
      type: "text",
      ...geometry,
      text: prop(text),
      color: prop(fg),
      halign: prop("center"),
      valign: prop("center"),
      fontsize: prop(100),
      fontsizeAllowShrink: prop(true),
      font: prop("companion-sans"),
      outlineColor: prop(4278190080),
      pinnedProperties: [
        "text",
        "fontsize",
        "fontsizeAllowShrink",
        "color",
        "halign",
        "valign",
      ],
    },
  ];
}

const setVar = (name: string, value: string, isExpression = false) => ({
  type: "action",
  id: "<id>",
  definitionId: "custom_variable_set_value",
  connectionId: "internal",
  options: { name: prop(name), value: { value, isExpression } },
});

const emptyStep = {
  action_sets: { down: [], up: [], rotate_left: [], rotate_right: [] },
  options: { runWhileHeld: [] },
};

async function appliedControl(yaml: string, row = 0, column = 2) {
  const { dbPath, result } = await applyYaml(yaml);
  assert.equal(result.code, 0, result.stderr.join("\n"));
  return controlAt(dumpDatabase(dbPath), row, column).control;
}

const SIMPLE_YAML = `kind: button
location: { page: 1, row: 0, column: 2 }
text: "Count\\n$(custom:fx_counter)"
background: "#000080"
`;

describe("apply button: success", () => {
  it("writes a button-layered control at an empty cell of an existing row", async () => {
    const { dbPath, before, result } = await applyYaml(SIMPLE_YAML);

    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(result.stderr, []);
    assert.ok(printedBackupDir(result), "backup line printed");
    assert.match(result.stdout[0] ?? "", /^backup: /);
    assert.equal(result.stdout.length, 2);
    assert.match(result.stdout[1] ?? "", /page 1, row 0, column 2: created/);

    const after = dumpDatabase(dbPath);
    const { id, control } = controlAt(after, 0, 2);
    assert.match(id, CONTROL_ID);
    assert.deepEqual(control, {
      type: "button-layered",
      options: {
        stepProgression: "auto",
        stepExpression: "",
        rotaryActions: false,
        canModifyStyleInApis: true,
        notes: "",
      },
      localVariables: [],
      steps: {
        "0": {
          action_sets: { down: [], up: [], rotate_left: [], rotate_right: [] },
          options: { runWhileHeld: [] },
        },
      },
      feedbacks: [],
      style: {
        layers: [
          {
            id: "canvas",
            name: "Canvas",
            usage: "auto",
            type: "canvas",
            decoration: prop("default"),
            showStatusIcons: prop("default"),
          },
          {
            id: "box0",
            name: "Background",
            usage: "auto",
            type: "box",
            ...geometry,
            color: prop(0x000080),
            borderWidth: prop(0),
            borderColor: prop(0),
            borderPosition: prop("inside"),
            pinnedProperties: ["color"],
          },
          {
            id: "image0",
            name: "Image",
            usage: "auto",
            type: "image",
            ...geometry,
            base64Image: prop(null),
            halign: prop("center"),
            valign: prop("center"),
            fillMode: prop("fit"),
            pinnedProperties: ["base64Image", "halign", "valign"],
          },
          {
            id: "text0",
            name: "Text",
            usage: "auto",
            type: "text",
            ...geometry,
            text: prop("Count\\n$(custom:fx_counter)"),
            color: prop(0xffffff),
            halign: prop("center"),
            valign: prop("center"),
            fontsize: prop(100),
            fontsizeAllowShrink: prop(true),
            font: prop("companion-sans"),
            outlineColor: prop(4278190080),
            pinnedProperties: [
              "text",
              "fontsize",
              "fontsizeAllowShrink",
              "color",
              "halign",
              "valign",
            ],
          },
        ],
      },
    });

    // Only the target cell changed in the pages row; nothing deleted.
    const expectedPage = page(before);
    (expectedPage["controls"] as Record<string, Record<string, string>>)["0"]![
      "2"
    ] = id;
    assert.deepEqual(page(after), expectedPage);
    const controlsBefore = rows(before, "controls");
    const controlsAfter = rows(after, "controls");
    assert.deepEqual(
      [...controlsAfter.keys()].sort(),
      [...controlsBefore.keys(), id].sort(),
    );
    for (const [cid, value] of controlsBefore)
      assert.deepEqual(controlsAfter.get(cid), value);
    assertTablesUnchangedExcept(before, after, "pages", "controls");
  });

  it("matches the key paths of the fixture's documented controls", async () => {
    const { dbPath, before, result } = await applyYaml(`kind: button
location: { page: 1, row: 1, column: 1 }
text: ""
background: "#FFFFFF"
textColor: "#123456"
down:
  - { action: increment, variable: fx_counter }
`);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    const { control } = controlAt(dumpDatabase(dbPath), 1, 1);
    const fixture = rows(before, "controls").get(FIXTURE_CONTROL_A);
    assert.deepEqual(keyPaths(control), keyPaths(fixture));
  });

  it("replaces the control at an occupied cell and deletes the old one", async () => {
    const { dbPath, before, result } = await applyYaml(`kind: button
location: { page: 1, row: 0, column: 0 }
text: Replaced
background: "#202020"
`);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.match(
      result.stdout.at(-1) ?? "",
      /page 1, row 0, column 0: replaced/,
    );
    const after = dumpDatabase(dbPath);
    const { id } = controlAt(after, 0, 0);
    const controlsAfter = rows(after, "controls");
    assert.equal(controlsAfter.has(FIXTURE_CONTROL_A), false);
    assert.deepEqual(
      controlsAfter.get(FIXTURE_CONTROL_B),
      rows(before, "controls").get(FIXTURE_CONTROL_B),
    );
    assert.equal(controlsAfter.size, rows(before, "controls").size);
    const expectedPage = page(before);
    (expectedPage["controls"] as Record<string, Record<string, string>>)["0"]![
      "0"
    ] = id;
    assert.deepEqual(page(after), expectedPage);
  });

  it("creates the row key for an empty cell in a missing row and deletes nothing", async () => {
    const { dbPath, before, result } = await applyYaml(`kind: button
location: { page: 1, row: 2, column: 3 }
text: New row
background: "#000000"
`);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.match(result.stdout.at(-1) ?? "", /created/);
    const after = dumpDatabase(dbPath);
    const { id } = controlAt(after, 2, 3);
    const expectedPage = page(before);
    (expectedPage["controls"] as Record<string, Record<string, string>>)["2"] =
      { "3": id };
    assert.deepEqual(page(after), expectedPage);
    for (const [cid, value] of rows(before, "controls"))
      assert.deepEqual(rows(after, "controls").get(cid), value);
    assertTablesUnchangedExcept(before, after, "pages", "controls");
  });

  it("accepts negative rows and columns within the grid", async () => {
    const env = setup();
    const db = new DatabaseSync(env.dbPath);
    db.prepare("UPDATE main SET value = ? WHERE id = 'userconfig'").run(
      JSON.stringify({
        gridSize: { minColumn: -2, maxColumn: 7, minRow: -1, maxRow: 3 },
        setup_wizard: 0,
      }),
    );
    db.close();
    const result = await runCli(
      [
        "apply",
        writeDescription(
          env.dir,
          `kind: button
location: { page: 1, row: -1, column: -2 }
text: neg
background: "#000000"
`,
        ),
        "--db",
        env.dbPath,
      ],
      { backupRoot: env.backupRoot },
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.match(controlAt(dumpDatabase(env.dbPath), -1, -2).id, CONTROL_ID);
  });

  it("stores colors as integers and picks the text color by background brightness", async () => {
    const cases: Array<[string, string, number, number]> = [
      ['background: "#FFFFFF"', "", 0xffffff, 0x000000],
      ['background: "#000080"', "", 0x000080, 0xffffff],
      // luma of #8C8C8C is exactly 140: not greater, so white text.
      ['background: "#8c8c8c"', "", 0x8c8c8c, 0xffffff],
      ['background: "#8D8D8D"', "", 0x8d8d8d, 0x000000],
      ['background: "#ffff00"', 'textColor: "#Ff0000"', 0xffff00, 0xff0000],
    ];
    for (const [bg, fg, expectedBg, expectedFg] of cases) {
      const { dbPath, result } = await applyYaml(`kind: button
location: { page: 1, row: 0, column: 3 }
text: c
${bg}
${fg}
`);
      assert.equal(result.code, 0, result.stderr.join("\n"));
      const layers = (
        controlAt(dumpDatabase(dbPath), 0, 3).control["style"] as {
          layers: Json[];
        }
      ).layers;
      assert.deepEqual(layers[1]?.["color"], prop(expectedBg), bg);
      assert.deepEqual(layers[3]?.["color"], prop(expectedFg), `${bg} ${fg}`);
    }
  });

  it("is idempotent apart from ids, and the first control is gone after the second apply", async () => {
    const yaml = `kind: button
location: { page: 1, row: 0, column: 0 }
text: Twice
background: "#000080"
down:
  - { action: set, variable: fx_label, value: pressed }
up:
  - { action: decrement, variable: fx_counter, by: 2 }
`;
    const { dir, dbPath, backupRoot } = setup();
    const file = writeDescription(dir, yaml);
    const now = () => new Date("2026-10-14T00:00:00.000Z");

    assert.equal(
      (await runCli(["apply", file, "--db", dbPath], { backupRoot, now })).code,
      0,
    );
    const first = dumpDatabase(dbPath);
    const firstId = controlAt(first, 0, 0).id;
    const second = await runCli(["apply", file, "--db", dbPath], {
      backupRoot,
      now,
    });
    assert.equal(second.code, 0, second.stderr.join("\n"));
    assert.match(second.stdout.at(-1) ?? "", /replaced/);
    const secondDump = dumpDatabase(dbPath);
    assert.notEqual(controlAt(secondDump, 0, 0).id, firstId);
    assert.equal(rows(secondDump, "controls").has(firstId), false);
    assert.deepEqual(normaliseIds(secondDump), normaliseIds(first));
  });
});

describe("apply button: actions", () => {
  const ACTIONS_YAML = `kind: button
location: { page: 1, row: 3, column: 7 }
text: Actions
background: "#000000"
down:
  - { action: set, variable: fx_label, value: pressed }
  - { action: set, variable: fx_counter, value: 42 }
  - { action: set, variable: fx_gap, value: true }
  - { action: expression, variable: fx_label, expression: "$(custom:fx_counter) * 2" }
  - { action: increment, variable: fx_counter }
  - { action: decrement, variable: fx_counter, by: 3 }
up:
  - { action: increment, variable: fx_counter, by: 5 }
  - action: passthrough
    connection: FixtureConnectionAAAA
    definition: some_definition_id
    options: { mode: 1, label: "x", list: [1, "a"], nested: { on: true }, none: null }
  - { action: passthrough, connection: other, definition: bare }
`;

  it("writes internal and pass-through actions in file order", async () => {
    const { dbPath, result } = await applyYaml(ACTIONS_YAML);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    const { control } = controlAt(dumpDatabase(dbPath), 3, 7);

    assert.deepEqual(stripIds(downActions(control, "down")), [
      setVar("fx_label", "pressed"),
      setVar("fx_counter", "42"),
      setVar("fx_gap", "true"),
      setVar("fx_label", "$(custom:fx_counter) * 2", true),
      setVar("fx_counter", "$(this:current) + 1", true),
      setVar("fx_counter", "$(this:current) - 3", true),
    ]);
    assert.deepEqual(stripIds(downActions(control, "up")), [
      setVar("fx_counter", "$(this:current) + 5", true),
      {
        type: "action",
        id: "<id>",
        definitionId: "some_definition_id",
        connectionId: "FixtureConnectionAAAA",
        options: {
          mode: prop(1),
          label: prop("x"),
          list: prop([1, "a"]),
          nested: prop({ on: true }),
          none: prop(null),
        },
      },
      {
        type: "action",
        id: "<id>",
        definitionId: "bare",
        connectionId: "other",
        options: {},
      },
    ]);
    assert.deepEqual(downActions(control, "rotate_left"), []);
    assert.deepEqual(downActions(control, "rotate_right"), []);
  });

  it("generates distinct action ids", async () => {
    const { dbPath, result } = await applyYaml(ACTIONS_YAML);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    const { control } = controlAt(dumpDatabase(dbPath), 3, 7);
    const ids = [
      ...downActions(control, "down"),
      ...downActions(control, "up"),
    ].map((action) => String(action["id"]));
    assert.equal(ids.length, 9);
    for (const id of ids) assert.match(id, ID);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("apply button: text", () => {
  const textOf = async (yamlText: string) => {
    const { dbPath, result } = await applyYaml(`kind: button
location: { page: 1, row: 0, column: 4 }
background: "#000000"
${yamlText}`);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    const layers = (
      controlAt(dumpDatabase(dbPath), 0, 4).control["style"] as {
        layers: Json[];
      }
    ).layers;
    return (layers[3]?.["text"] as { value: string }).value;
  };

  it("stores a block scalar's lines with literal backslash-n and no trailing newline", async () => {
    assert.equal(
      await textOf("text: |\n  Line one\n  Line two\n"),
      "Line one\\nLine two",
    );
  });

  it("removes exactly one trailing newline", async () => {
    assert.equal(await textOf('text: "a\\n\\n"\n'), "a\\n");
  });

  it("keeps a literal backslash-n unchanged", async () => {
    assert.equal(await textOf("text: Line\\nTwo\n"), "Line\\nTwo");
  });

  it("allows empty text", async () => {
    assert.equal(await textOf('text: ""\n'), "");
  });
});

describe("apply button: refusals leave the database byte-identical", () => {
  const base = (overrides: Record<string, string> = {}) => {
    const fields: Record<string, string> = {
      location: "{ page: 1, row: 0, column: 2 }",
      text: "ok",
      background: '"#000080"',
      ...overrides,
    };
    return (
      "kind: button\n" +
      Object.entries(fields)
        .filter(([, value]) => value !== "")
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n") +
      "\n"
    );
  };
  const down = (entry: string) => base({ down: `\n  - ${entry}` });

  const cases: Array<[string, string, RegExp]> = [
    // Unknown fields.
    [
      "unknown top-level field",
      base({ rotate: "[]" }),
      /^error: .*: rotate: unknown field$/,
    ],
    [
      "top-level options field",
      base({ options: "{}" }),
      /: options: unknown field$/,
    ],
    [
      "unknown location field",
      base({ location: "{ page: 1, row: 0, column: 2, x: 1 }" }),
      /: location\.x: unknown field$/,
    ],
    [
      "unknown action field",
      down("{ action: increment, variable: fx_counter, value: 1 }"),
      /: down\[0\]\.value: unknown field$/,
    ],
    [
      "passthrough field on set",
      down("{ action: set, variable: fx_label, value: a, connection: x }"),
      /: down\[0\]\.connection: unknown field$/,
    ],
    // Required fields and location.
    ["missing location", base({ location: "" }), /: location: is required$/],
    ["missing text", base({ text: "" }), /: text: is required$/],
    [
      "missing background",
      base({ background: "" }),
      /: background: is required$/,
    ],
    [
      "location not a mapping",
      base({ location: "1" }),
      /: location: must be a mapping/,
    ],
    [
      "missing column",
      base({ location: "{ page: 1, row: 0 }" }),
      /: location\.column: is required$/,
    ],
    [
      "non-integer row",
      base({ location: "{ page: 1, row: 0.5, column: 2 }" }),
      /: location\.row: must be an integer/,
    ],
    [
      "string column",
      base({ location: '{ page: 1, row: 0, column: "2" }' }),
      /: location\.column: must be an integer/,
    ],
    [
      "page 0",
      base({ location: "{ page: 0, row: 0, column: 2 }" }),
      /: location\.page: must be at least 1/,
    ],
    // Text.
    ["non-string text", base({ text: "12" }), /: text: must be a string/],
    // Colors.
    [
      "unquoted color",
      base({ background: "#000080" }),
      /: background: .*quote/,
    ],
    [
      "unquoted text color",
      base({ textColor: "#FFFFFF" }),
      /: textColor: .*quote/,
    ],
    ["short color", base({ background: '"#FFF"' }), /: background: must be/],
    [
      "color without #",
      base({ background: '"000080"' }),
      /: background: must be/,
    ],
    [
      "numeric color",
      base({ background: "128" }),
      /: background: must be a string/,
    ],
    // Actions.
    ["down not a list", base({ down: "{}" }), /: down: must be a list/],
    [
      "action not a mapping",
      down("increment"),
      /: down\[0\]: must be a mapping/,
    ],
    [
      "missing action",
      down("{ variable: fx_counter }"),
      /: down\[0\]\.action: is required$/,
    ],
    [
      "unknown action",
      down("{ action: toggle, variable: fx_counter }"),
      /: down\[0\]\.action: unknown action "toggle"/,
    ],
    [
      "unknown up action",
      base({ up: "\n  - { action: rotate }" }),
      /: up\[0\]\.action: unknown action "rotate"/,
    ],
    [
      "missing variable",
      down("{ action: increment }"),
      /: down\[0\]\.variable: is required$/,
    ],
    [
      "invalid variable name",
      down("{ action: increment, variable: a-b }"),
      /: down\[0\]\.variable: invalid variable name "a-b"/,
    ],
    [
      "reserved variable name",
      down("{ action: increment, variable: constructor }"),
      /: down\[0\]\.variable: variable name "constructor" is reserved/,
    ],
    [
      "numeric variable name",
      down("{ action: increment, variable: '007' }"),
      /: down\[0\]\.variable: variable name "007" looks like a number/,
    ],
    [
      "set without value",
      down("{ action: set, variable: fx_label }"),
      /: down\[0\]\.value: is required$/,
    ],
    [
      "set with null value",
      down("{ action: set, variable: fx_label, value: null }"),
      /: down\[0\]\.value: must be a string, number or boolean/,
    ],
    [
      "empty expression",
      down('{ action: expression, variable: fx_label, expression: "" }'),
      /: down\[0\]\.expression: must not be empty/,
    ],
    [
      "zero by",
      down("{ action: increment, variable: fx_counter, by: 0 }"),
      /: down\[0\]\.by: must be a positive integer/,
    ],
    [
      "fractional by",
      down("{ action: decrement, variable: fx_counter, by: 1.5 }"),
      /: down\[0\]\.by: must be a positive integer/,
    ],
    [
      "passthrough without connection",
      down("{ action: passthrough, definition: d }"),
      /: down\[0\]\.connection: is required$/,
    ],
    [
      "passthrough empty definition",
      down('{ action: passthrough, connection: c, definition: "" }'),
      /: down\[0\]\.definition: must not be empty/,
    ],
    [
      "passthrough options not a mapping",
      down(
        "{ action: passthrough, connection: c, definition: d, options: [] }",
      ),
      /: down\[0\]\.options: must be a mapping/,
    ],
    // Database checks.
    [
      "column outside the grid",
      base({ location: "{ page: 1, row: 0, column: 8 }" }),
      /^error: location\.column: 8 is outside the grid \(0\.\.7\)/,
    ],
    [
      "row outside the grid",
      base({ location: "{ page: 1, row: 4, column: 0 }" }),
      /^error: location\.row: 4 is outside the grid \(0\.\.3\)/,
    ],
    [
      "negative row outside the grid",
      base({ location: "{ page: 1, row: -1, column: 0 }" }),
      /^error: location\.row: -1 is outside the grid/,
    ],
    [
      "missing page",
      base({ location: "{ page: 2, row: 0, column: 0 }" }),
      /^error: location\.page: page 2 does not exist/,
    ],
    [
      "unknown variable in an action",
      base({
        down: "\n  - { action: increment, variable: fx_counter }\n  - { action: set, variable: fx_label, value: a }\n  - { action: increment, variable: nope }",
      }),
      /^error: down\[2\]\.variable: unknown custom variable "nope"$/,
    ],
    [
      "unknown variable in text",
      base({ text: '"x $(custom:fx_counter) $(custom:missing_one)"' }),
      /^error: text: unknown custom variable "missing_one"$/,
    ],
    [
      "unknown variable in a set value",
      base({
        up: '\n  - { action: set, variable: fx_label, value: "$(custom:ghost)" }',
      }),
      /^error: up\[0\]\.value: unknown custom variable "ghost"$/,
    ],
    [
      "unknown variable in an expression",
      down(
        '{ action: expression, variable: fx_label, expression: "$(custom:ghost) + 1" }',
      ),
      /^error: down\[0\]\.expression: unknown custom variable "ghost"$/,
    ],
  ];

  for (const [name, yaml, expected] of cases) {
    it(name, async () => {
      const { dir, dbPath, backupRoot } = setup({ wal: true });
      const before = fileState(dbPath);
      const result = await runCli(
        ["apply", writeDescription(dir, yaml), "--db", dbPath],
        { backupRoot },
      );

      assert.equal(result.code, 1, result.stdout.join("\n"));
      assert.equal(result.stderr.length, 1);
      assert.match(result.stderr[0] ?? "", expected);
      assert.deepEqual(fileState(dbPath), before);
      assert.equal(existsSync(backupRoot), false, "no backup for a refusal");
    });
  }

  it("does not check pass-through connections or options against the database", async () => {
    const { result } = await applyYaml(
      down(
        '{ action: passthrough, connection: NoSuchConnection, definition: d, options: { x: "$(custom:not_checked)" } }',
      ),
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
  });

  it("re-checks under the write lock: a variable removed after the snapshot is refused", async () => {
    const { dir, dbPath, backupRoot } = setup();
    const result = await runCli(
      [
        "apply",
        writeDescription(dir, down("{ action: increment, variable: fx_gap }")),
        "--db",
        dbPath,
      ],
      {
        backupRoot,
        hooks: {
          afterBackup: (path) => {
            const db = new DatabaseSync(path);
            db.prepare(
              "DELETE FROM custom_variables WHERE id = 'fx_gap'",
            ).run();
            db.close();
          },
        },
      },
    );
    assert.equal(result.code, 1);
    assert.equal(result.stderr.length, 1);
    assert.match(
      result.stderr[0] ?? "",
      /down\[0\]\.variable: unknown custom variable "fx_gap" \(nothing written; backup kept/,
    );
    const after = dumpDatabase(dbPath);
    assert.equal(rows(after, "controls").size, 2);
  });
});

describe("apply button: pages Companion does not load", () => {
  const yaml = (pageNumber: number) =>
    `kind: button\nlocation: { page: ${pageNumber}, row: 0, column: 0 }\ntext: x\nbackground: "#000000"\n`;
  const setPage = (db: DatabaseSync, id: string, value: unknown) =>
    db
      .prepare("INSERT OR REPLACE INTO pages (id, value) VALUES (?, ?)")
      .run(id, JSON.stringify(value));

  async function refuse(
    pageNumber: number,
    change: (db: DatabaseSync) => void,
    expected: RegExp,
  ) {
    const env = setup({}, change);
    const before = fileState(env.dbPath);
    const result = await applyTo(env, yaml(pageNumber));
    assert.equal(result.code, 1, result.stdout.join("\n"));
    assert.equal(result.stderr.length, 1);
    assert.match(result.stderr[0] ?? "", expected);
    assert.deepEqual(fileState(env.dbPath), before);
    assert.equal(existsSync(env.backupRoot), false);
    const json = await applyTo(env, yaml(pageNumber), {}, ["--json"]);
    assertRefusalCode(assertJsonTwin(result, json));
    const dry = await applyTo(
      env,
      yaml(pageNumber),
      { processControl: forbiddenProcessControl().control },
      ["--dry-run", "--json"],
    );
    assert.deepEqual(dry, json, "the dry run refuses with the same document");
  }

  it("refuses a page row after a missing page", async () => {
    await refuse(
      3,
      (db) =>
        setPage(db, "3", {
          id: "StrayPageIdAAAAAAAAAA",
          name: "S",
          controls: {},
        }),
      /^error: location\.page: page 3 is not loaded by Companion \(pages 1 to 1 load\); this writer does not create pages/,
    );
  });

  it("refuses a page row holding null", async () => {
    await refuse(
      2,
      (db) => setPage(db, "2", null),
      /^error: location\.page: page 2 is not loaded by Companion \(pages 1 to 1 load\)/,
    );
  });
});

describe("apply button: target cell and grid checks", () => {
  const CELL_YAML = `kind: button
location: { page: 1, row: 0, column: 2 }
text: cell
background: "#000000"
`;

  /** A fixture whose page 1 cell (0,2) holds `cellId`, and optional extra rows. */
  function setupWithCell(cellId: string, extra?: (db: DatabaseSync) => void) {
    const env = setup();
    const db = new DatabaseSync(env.dbPath);
    const stored = JSON.parse(
      String(
        db.prepare("SELECT value FROM pages WHERE id = '1'").get()?.["value"],
      ),
    ) as { controls: Record<string, Record<string, string>> };
    stored.controls["0"]!["2"] = cellId;
    db.prepare("UPDATE pages SET value = ? WHERE id = '1'").run(
      JSON.stringify(stored),
    );
    extra?.(db);
    db.close();
    return env;
  }

  function setGrid(dbPath: string, gridSize: unknown) {
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE main SET value = ? WHERE id = 'userconfig'").run(
      JSON.stringify({ gridSize, setup_wizard: 0 }),
    );
    db.close();
  }

  async function refuse(env: ReturnType<typeof setup>, expected: RegExp) {
    const before = fileState(env.dbPath);
    const argv = [
      "apply",
      writeDescription(env.dir, CELL_YAML),
      "--db",
      env.dbPath,
    ];
    const options = { backupRoot: env.backupRoot };
    const result = await runCli(argv, options);
    assert.equal(result.code, 1, result.stdout.join("\n"));
    assert.equal(result.stderr.length, 1);
    assert.match(result.stderr[0] ?? "", expected);
    assert.deepEqual(fileState(env.dbPath), before);
    assert.equal(existsSync(env.backupRoot), false, "no backup for a refusal");
    const json = await runCli([...argv, "--json"], options);
    assertRefusalCode(assertJsonTwin(result, json));
    const dry = await runCli([...argv, "--dry-run", "--json"], {
      ...options,
      processControl: forbiddenProcessControl().control,
    });
    assert.deepEqual(dry, json, "the dry run refuses with the same document");
  }

  it("reports a cell pointing at a missing control row as replaced", async () => {
    const missing = "bank:MissingCtrlXXXXXXXXXX";
    const env = setupWithCell(missing);
    const before = dumpDatabase(env.dbPath);
    const result = await runCli(
      ["apply", writeDescription(env.dir, CELL_YAML), "--db", env.dbPath],
      { backupRoot: env.backupRoot },
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.match(
      result.stdout.at(-1) ?? "",
      /page 1, row 0, column 2: replaced/,
    );
    const after = dumpDatabase(env.dbPath);
    assert.equal(
      rows(after, "controls").size,
      rows(before, "controls").size + 1,
    );
    assert.notEqual(controlAt(after, 0, 2).id, missing);
  });

  it("refuses a target cell holding a non-button control id and keeps that row", async () => {
    const triggerId = "trigger:FixtureTrigAAAAAAAAAAA";
    const env = setupWithCell(triggerId, (db) =>
      db
        .prepare("INSERT INTO controls (id, value) VALUES (?, ?)")
        .run(triggerId, JSON.stringify({ type: "trigger" })),
    );
    await refuse(
      env,
      /^error: location: page 1, row 0, column 2 holds "trigger:FixtureTrigAAAAAAAAAAA", which is not a button control/,
    );
  });

  it("refuses a grid size with non-integer bounds", async () => {
    const env = setup();
    setGrid(env.dbPath, {
      minColumn: 0,
      maxColumn: 7.5,
      minRow: 0,
      maxRow: 3,
    });
    await refuse(env, /^error: cannot read the grid size/);
  });

  it("refuses a grid size whose minimum exceeds its maximum", async () => {
    const env = setup();
    setGrid(env.dbPath, { minColumn: 8, maxColumn: 7, minRow: 0, maxRow: 3 });
    await refuse(env, /^error: cannot read the grid size/);
  });
});

describe("apply button: encoders and steps", () => {
  it("writes the prototype's rotary() encoder", async () => {
    const control = await appliedControl(
      `kind: button
location: { page: 1, row: 0, column: 3 }
text: "E1 #46\\n$(custom:fx_counter)"
background: "#400000"
down:
  - { action: set, variable: fx_counter, value: "0" }
  - { action: set, variable: fx_label, value: E1 push }
rotate_left: [ { action: decrement, variable: fx_counter } ]
rotate_right: [ { action: increment, variable: fx_counter } ]
`,
      0,
      3,
    );
    // rotary("E1", 46, "sk_enc1", rgb("400000"), ...) with fixture variables.
    assert.deepEqual(stripIds(control), {
      type: "button-layered",
      options: {
        stepProgression: "auto",
        stepExpression: "",
        rotaryActions: true,
        canModifyStyleInApis: true,
        notes: "",
      },
      localVariables: [],
      steps: {
        "0": {
          action_sets: {
            down: [setVar("fx_counter", "0"), setVar("fx_label", "E1 push")],
            up: [],
            rotate_left: [setVar("fx_counter", "$(this:current) - 1", true)],
            rotate_right: [setVar("fx_counter", "$(this:current) + 1", true)],
          },
          options: { runWhileHeld: [] },
        },
      },
      feedbacks: [],
      style: {
        layers: prototypeLayers(
          "E1 #46\\n$(custom:fx_counter)",
          0x400000,
          0xffffff,
        ),
      },
    });
  });

  it("writes the prototype's latch() two-step button with a step feedback", async () => {
    const control = await appliedControl(`kind: button
location: { page: 1, row: 0, column: 2 }
text: "OFF"
background: "#FF0000"
steps:
  - down:
      - { action: increment, variable: fx_counter }
      - { action: set, variable: fx_label, value: S9 }
  - down:
      - { action: increment, variable: fx_counter }
      - { action: set, variable: fx_label, value: S9 }
feedbacks:
  - feedback: step
    step: 2
    style: { background: "#00FF00", textColor: "#000000", text: "ON" }
`);
    // latch("S9") with fx_counter for sk_presses and fx_label for sk_last.
    const press = {
      action_sets: {
        down: [
          setVar("fx_counter", "$(this:current) + 1", true),
          setVar("fx_label", "S9"),
        ],
        up: [],
        rotate_left: [],
        rotate_right: [],
      },
      options: { runWhileHeld: [] },
    };
    assert.deepEqual(stripIds(control), {
      type: "button-layered",
      options: {
        stepProgression: "auto",
        stepExpression: "",
        rotaryActions: false,
        canModifyStyleInApis: true,
        notes: "",
      },
      localVariables: [],
      steps: { "0": press, "1": press },
      feedbacks: [
        {
          type: "feedback",
          id: "<id>",
          definitionId: "bank_current_step",
          connectionId: "internal",
          options: { step: prop(2), location: prop("$(this:location)") },
          isInverted: prop(false),
          styleOverrides: [
            {
              overrideId: "<id>",
              elementId: "box0",
              elementProperty: "color",
              override: prop(0x00ff00),
            },
            {
              overrideId: "<id>",
              elementId: "text0",
              elementProperty: "color",
              override: prop(0x000000),
            },
            {
              overrideId: "<id>",
              elementId: "text0",
              elementProperty: "text",
              override: prop("ON"),
            },
          ],
          children: {},
        },
      ],
      style: { layers: prototypeLayers("OFF", 0xff0000, 0xffffff) },
    });
    const ids = generatedIds(control);
    assert.equal(ids.length, 4 + 1 + 3);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("stores steps in list order with every action set, an empty mapping as an empty step", async () => {
    const control = await appliedControl(`kind: button
location: { page: 1, row: 0, column: 2 }
text: steps
background: "#000000"
steps:
  - { up: [ { action: set, variable: fx_label, value: a } ] }
  - {}
  - { rotate_right: [ { action: increment, variable: fx_gap } ] }
`);
    assert.deepEqual(stripIds(control["steps"]), {
      "0": {
        action_sets: {
          down: [],
          up: [setVar("fx_label", "a")],
          rotate_left: [],
          rotate_right: [],
        },
        options: { runWhileHeld: [] },
      },
      "1": emptyStep,
      "2": {
        action_sets: {
          down: [],
          up: [],
          rotate_left: [],
          rotate_right: [setVar("fx_gap", "$(this:current) + 1", true)],
        },
        options: { runWhileHeld: [] },
      },
    });
    assert.equal(
      (control["options"] as Json)["rotaryActions"],
      true,
      "rotate_right in a step",
    );
  });

  it("sets rotaryActions for an empty rotate list, inside a step or at top level", async () => {
    const rotary = async (fields: string) =>
      (
        (
          await appliedControl(`kind: button
location: { page: 1, row: 0, column: 2 }
text: r
background: "#000000"
${fields}`)
        )["options"] as Json
      )["rotaryActions"];
    assert.equal(
      await rotary("steps:\n  - { rotate_left: [] }\n  - {}\n"),
      true,
    );
    assert.equal(await rotary("rotate_left: []\n"), true);
    assert.equal(await rotary("rotate_right: []\n"), true);
    assert.equal(await rotary("steps:\n  - { down: [] }\n"), false);
    assert.equal(await rotary("down: []\n"), false);
  });

  it("writes an empty feedbacks list like a description without it", async () => {
    const control = await appliedControl(SIMPLE_YAML + "feedbacks: []\n");
    assert.deepEqual(control["feedbacks"], []);
    assert.deepEqual(control["steps"], { "0": emptyStep });
  });
});

describe("apply button: feedbacks", () => {
  const withFeedbacks = (feedbacks: string, extra = "") => `kind: button
location: { page: 1, row: 0, column: 2 }
text: fb
background: "#000080"
${extra}feedbacks:
${feedbacks}`;

  async function feedbacksOf(yaml: string): Promise<Json[]> {
    const control = await appliedControl(yaml);
    return control["feedbacks"] as Json[];
  }

  it("writes an expression feedback as check_expression, inverted when asked", async () => {
    const feedbacks = await feedbacksOf(
      withFeedbacks(`  - feedback: expression
    expression: "$(custom:fx_label) == 'on'"
    style: { background: "#FFA500" }
    invert: true
  - feedback: expression
    expression: "$(custom:fx_counter) > 2"
    style: { text: "HI" }
    invert: false
  - feedback: expression
    expression: "true"
    style: { textColor: "#010203" }
`),
    );
    const expression = (
      text: string,
      inverted: boolean,
      overrides: Json[],
    ) => ({
      type: "feedback",
      id: "<id>",
      definitionId: "check_expression",
      connectionId: "internal",
      options: { expression: { value: text, isExpression: true } },
      isInverted: prop(inverted),
      styleOverrides: overrides,
      children: {},
    });
    assert.deepEqual(stripIds(feedbacks), [
      expression("$(custom:fx_label) == 'on'", true, [
        {
          overrideId: "<id>",
          elementId: "box0",
          elementProperty: "color",
          override: prop(0xffa500),
        },
      ]),
      expression("$(custom:fx_counter) > 2", false, [
        {
          overrideId: "<id>",
          elementId: "text0",
          elementProperty: "text",
          override: prop("HI"),
        },
      ]),
      expression("true", false, [
        {
          overrideId: "<id>",
          elementId: "text0",
          elementProperty: "color",
          override: prop(0x010203),
        },
      ]),
    ]);
  });

  it("writes a pass-through feedback with wrapped options", async () => {
    const feedbacks = await feedbacksOf(
      withFeedbacks(`  - feedback: passthrough
    connection: FixtureConnectionAAAA
    definition: some_feedback_id
    options: { input: 1, label: "x", list: [1, "a"], nested: { on: true }, none: null }
    style: { text: "LIVE" }
  - { feedback: passthrough, connection: other, definition: bare, style: { text: "" }, invert: true }
`),
    );
    assert.deepEqual(stripIds(feedbacks), [
      {
        type: "feedback",
        id: "<id>",
        definitionId: "some_feedback_id",
        connectionId: "FixtureConnectionAAAA",
        options: {
          input: prop(1),
          label: prop("x"),
          list: prop([1, "a"]),
          nested: prop({ on: true }),
          none: prop(null),
        },
        isInverted: prop(false),
        styleOverrides: [
          {
            overrideId: "<id>",
            elementId: "text0",
            elementProperty: "text",
            override: prop("LIVE"),
          },
        ],
        children: {},
      },
      {
        type: "feedback",
        id: "<id>",
        definitionId: "bare",
        connectionId: "other",
        options: {},
        isInverted: prop(true),
        styleOverrides: [
          {
            overrideId: "<id>",
            elementId: "text0",
            elementProperty: "text",
            override: prop(""),
          },
        ],
        children: {},
      },
    ]);
  });

  it("writes overrides in the order background, text color, text whatever the file order", async () => {
    const feedbacks = await feedbacksOf(
      withFeedbacks(`  - feedback: step
    step: 1
    style:
      text: |
        Two
        lines
      textColor: "#ffffff"
      background: "#123456"
`),
    );
    assert.deepEqual((stripIds(feedbacks) as Json[])[0]?.["styleOverrides"], [
      {
        overrideId: "<id>",
        elementId: "box0",
        elementProperty: "color",
        override: prop(0x123456),
      },
      {
        overrideId: "<id>",
        elementId: "text0",
        elementProperty: "color",
        override: prop(0xffffff),
      },
      {
        overrideId: "<id>",
        elementId: "text0",
        elementProperty: "text",
        override: prop("Two\\nlines"),
      },
    ]);
  });

  it("does not derive a text color from a feedback background", async () => {
    const feedbacks = await feedbacksOf(
      withFeedbacks(`  - { feedback: step, step: 1, style: { background: "#FFFFFF" } }
`),
    );
    const overrides = feedbacks[0]?.["styleOverrides"] as Json[];
    assert.equal(overrides.length, 1);
    assert.equal(overrides[0]?.["elementProperty"], "color");
    assert.equal(overrides[0]?.["elementId"], "box0");
  });

  it("accepts a step feedback up to the step count, keeps file order and fresh ids", async () => {
    const feedbacks = await feedbacksOf(
      withFeedbacks(
        `  - { feedback: step, step: 3, style: { text: three } }
  - { feedback: step, step: 1, style: { text: one } }
  - { feedback: expression, expression: "1 > 0", style: { text: e } }
`,
        "steps: [ {}, {}, {} ]\n",
      ),
    );
    assert.deepEqual(
      feedbacks.map((fb) => (fb["options"] as Json)["step"]),
      [prop(3), prop(1), undefined],
    );
    const ids = generatedIds(feedbacks);
    assert.equal(ids.length, 6);
    assert.equal(new Set(ids).size, 6);
  });

  it("does not check pass-through feedback connections or options against the database", async () => {
    const feedbacks = await feedbacksOf(
      withFeedbacks(`  - feedback: passthrough
    connection: NoSuchConnection
    definition: d
    options: { x: "$(custom:not_checked)" }
    style: { background: "#000000" }
`),
    );
    assert.equal(feedbacks.length, 1);
  });
});

describe("apply button: step and feedback refusals leave the database byte-identical", () => {
  const button = (fields: string) => `kind: button
location: { page: 1, row: 0, column: 2 }
text: ok
background: "#000080"
${fields}`;
  const feedback = (entry: string, extra = "") =>
    button(`${extra}feedbacks:\n  - ${entry}\n`);

  const cases: Array<[string, string, RegExp]> = [
    // Steps.
    [
      "empty steps",
      button("steps: []\n"),
      /^error: .*: steps: must not be empty$/,
    ],
    ["steps not a list", button("steps: {}\n"), /: steps: must be a list/],
    [
      "step not a mapping",
      button("steps: [ down ]\n"),
      /: steps\[0\]: must be a mapping/,
    ],
    [
      "unknown step field",
      button("steps:\n  - {}\n  - { text: x }\n"),
      /: steps\[1\]\.text: unknown field$/,
    ],
    [
      "bad action inside a step",
      button(
        "steps:\n  - {}\n  - { down: [ { action: increment, variable: a-b } ] }\n",
      ),
      /: steps\[1\]\.down\[0\]\.variable: invalid variable name "a-b"/,
    ],
    [
      "steps with top-level down",
      button("down: []\nsteps: [ {} ]\n"),
      /: down: cannot be combined with steps$/,
    ],
    [
      "steps with top-level up",
      button("steps: [ {} ]\nup: []\n"),
      /: up: cannot be combined with steps$/,
    ],
    [
      "steps with top-level rotate_left",
      button("rotate_left: []\nsteps: [ {} ]\n"),
      /: rotate_left: cannot be combined with steps$/,
    ],
    [
      "steps with top-level rotate_right",
      button("rotate_right: []\nsteps: [ {} ]\n"),
      /: rotate_right: cannot be combined with steps$/,
    ],
    [
      "rotate_left not a list",
      button("rotate_left: 1\n"),
      /: rotate_left: must be a list/,
    ],
    [
      "unknown action in rotate_right",
      button("rotate_right: [ { action: spin } ]\n"),
      /: rotate_right\[0\]\.action: unknown action "spin"/,
    ],
    // Feedback structure.
    [
      "feedbacks not a list",
      button("feedbacks: {}\n"),
      /: feedbacks: must be a list/,
    ],
    [
      "feedback not a mapping",
      button("feedbacks: [ step ]\n"),
      /: feedbacks\[0\]: must be a mapping/,
    ],
    [
      "non-string feedback tag",
      feedback("{ feedback: 5, style: { text: a } }"),
      /: feedbacks\[0\]\.feedback: must be a string, got a number$/,
    ],
    [
      "missing feedback tag",
      feedback("{ step: 1, style: { text: a } }"),
      /: feedbacks\[0\]\.feedback: is required$/,
    ],
    [
      "unknown feedback kind",
      feedback("{ feedback: bank_pushed, style: { text: a } }"),
      /: feedbacks\[0\]\.feedback: unknown feedback "bank_pushed" \(expected one of: step, expression, passthrough\)$/,
    ],
    [
      "unknown field in a feedback",
      feedback(
        "{ feedback: step, step: 1, expression: x, style: { text: a } }",
      ),
      /: feedbacks\[0\]\.expression: unknown field$/,
    ],
    [
      "options on an expression feedback",
      feedback(
        '{ feedback: expression, expression: "1", options: {}, style: { text: a } }',
      ),
      /: feedbacks\[0\]\.options: unknown field$/,
    ],
    // Step feedback.
    [
      "missing step",
      feedback("{ feedback: step, style: { text: a } }"),
      /: feedbacks\[0\]\.step: is required$/,
    ],
    [
      "step 0",
      feedback("{ feedback: step, step: 0, style: { text: a } }"),
      /: feedbacks\[0\]\.step: must be an integer between 1 and 1, got 0$/,
    ],
    [
      "step beyond a single-step button",
      feedback("{ feedback: step, step: 2, style: { text: a } }"),
      /: feedbacks\[0\]\.step: must be an integer between 1 and 1, got 2$/,
    ],
    [
      "step beyond the step count",
      feedback(
        "{ feedback: step, step: 3, style: { text: a } }",
        "steps: [ {}, {} ]\n",
      ),
      /: feedbacks\[0\]\.step: must be an integer between 1 and 2, got 3$/,
    ],
    [
      "fractional step",
      feedback("{ feedback: step, step: 1.5, style: { text: a } }"),
      /: feedbacks\[0\]\.step: must be an integer between 1 and 1, got 1\.5$/,
    ],
    [
      "string step",
      feedback('{ feedback: step, step: "1", style: { text: a } }'),
      /: feedbacks\[0\]\.step: must be an integer between 1 and 1, got a string$/,
    ],
    // Expression feedback.
    [
      "empty expression",
      feedback('{ feedback: expression, expression: "", style: { text: a } }'),
      /: feedbacks\[0\]\.expression: must not be empty$/,
    ],
    [
      "missing expression",
      feedback("{ feedback: expression, style: { text: a } }"),
      /: feedbacks\[0\]\.expression: is required$/,
    ],
    // Pass-through feedback.
    [
      "pass-through without definition",
      feedback("{ feedback: passthrough, connection: c, style: { text: a } }"),
      /: feedbacks\[0\]\.definition: is required$/,
    ],
    [
      "pass-through empty connection",
      feedback(
        '{ feedback: passthrough, connection: "", definition: d, style: { text: a } }',
      ),
      /: feedbacks\[0\]\.connection: must not be empty$/,
    ],
    [
      "pass-through options not a mapping",
      feedback(
        "{ feedback: passthrough, connection: c, definition: d, options: [], style: { text: a } }",
      ),
      /: feedbacks\[0\]\.options: must be a mapping/,
    ],
    // Style and invert.
    [
      "missing style",
      feedback("{ feedback: step, step: 1 }"),
      /: feedbacks\[0\]\.style: is required$/,
    ],
    [
      "empty style",
      feedback("{ feedback: step, step: 1, style: {} }"),
      /: feedbacks\[0\]\.style: must set at least one of background, textColor, text$/,
    ],
    [
      "style not a mapping",
      feedback("{ feedback: step, step: 1, style: red }"),
      /: feedbacks\[0\]\.style: must be a mapping/,
    ],
    [
      "unknown style field",
      feedback("{ feedback: step, step: 1, style: { fontsize: 10 } }"),
      /: feedbacks\[0\]\.style\.fontsize: unknown field$/,
    ],
    [
      "unquoted style color",
      button(
        "feedbacks:\n  - feedback: step\n    step: 1\n    style:\n      background: #00FF00\n",
      ),
      /: feedbacks\[0\]\.style\.background: .*quote/,
    ],
    [
      "bad style text color",
      feedback('{ feedback: step, step: 1, style: { textColor: "#12345" } }'),
      /: feedbacks\[0\]\.style\.textColor: must be a color/,
    ],
    [
      "non-string style text",
      feedback("{ feedback: step, step: 1, style: { text: 5 } }"),
      /: feedbacks\[0\]\.style\.text: must be a string/,
    ],
    [
      "null style text color",
      button(
        "feedbacks:\n  - feedback: step\n    step: 1\n    style:\n      textColor:\n",
      ),
      /: feedbacks\[0\]\.style\.textColor: is empty; quote the color/,
    ],
    [
      "non-boolean invert",
      feedback("{ feedback: step, step: 1, style: { text: a }, invert: yes }"),
      /: feedbacks\[0\]\.invert: must be true or false/,
    ],
    // Database checks.
    [
      "unknown variable in a single-entry steps list",
      button("steps:\n  - { up: [ { action: increment, variable: nope } ] }\n"),
      /^error: steps\[0\]\.up\[0\]\.variable: unknown custom variable "nope"$/,
    ],
    [
      "unknown variable in a step action",
      button(
        "steps:\n  - {}\n  - { down: [ { action: increment, variable: nope } ] }\n",
      ),
      /^error: steps\[1\]\.down\[0\]\.variable: unknown custom variable "nope"$/,
    ],
    [
      "unknown variable in a rotate action",
      button("rotate_left: [ { action: decrement, variable: nope } ]\n"),
      /^error: rotate_left\[0\]\.variable: unknown custom variable "nope"$/,
    ],
    [
      "unknown variable in an expression feedback",
      button(
        'feedbacks:\n  - { feedback: expression, expression: "$(custom:fx_label) == \'a\'", style: { text: a } }\n  - { feedback: expression, expression: "$(custom:nope) > 1", style: { text: a } }\n',
      ),
      /^error: feedbacks\[1\]\.expression: unknown custom variable "nope"$/,
    ],
    [
      "unknown variable in a style text",
      feedback(
        '{ feedback: step, step: 1, style: { text: "$(custom:ghost)" } }',
      ),
      /^error: feedbacks\[0\]\.style\.text: unknown custom variable "ghost"$/,
    ],
  ];

  for (const [name, yaml, expected] of cases) {
    it(name, async () => {
      const { dir, dbPath, backupRoot } = setup({ wal: true });
      const before = fileState(dbPath);
      const result = await runCli(
        ["apply", writeDescription(dir, yaml), "--db", dbPath],
        { backupRoot },
      );

      assert.equal(result.code, 1, result.stdout.join("\n"));
      assert.equal(result.stderr.length, 1, result.stderr.join("\n"));
      assert.match(result.stderr[0] ?? "", expected);
      assert.deepEqual(fileState(dbPath), before);
      assert.equal(existsSync(backupRoot), false, "no backup for a refusal");
    });
  }

  const lockCases: Array<[string, string, RegExp]> = [
    [
      "an expression",
      '{ feedback: expression, expression: "$(custom:fx_gap) > 0", style: { text: a } }',
      /feedbacks\[0\]\.expression: unknown custom variable "fx_gap" \(nothing written; backup kept/,
    ],
    [
      "a style text",
      '{ feedback: step, step: 1, style: { text: "$(custom:fx_gap)" } }',
      /feedbacks\[0\]\.style\.text: unknown custom variable "fx_gap" \(nothing written; backup kept/,
    ],
  ];
  for (const [name, entry, expected] of lockCases) {
    it(`re-checks references in ${name} under the write lock`, async () => {
      const { dir, dbPath, backupRoot } = setup();
      const result = await runCli(
        ["apply", writeDescription(dir, feedback(entry)), "--db", dbPath],
        {
          backupRoot,
          hooks: {
            afterBackup: (path) => {
              const db = new DatabaseSync(path);
              db.prepare(
                "DELETE FROM custom_variables WHERE id = 'fx_gap'",
              ).run();
              db.close();
            },
          },
        },
      );
      assert.equal(result.code, 1);
      assert.equal(result.stderr.length, 1);
      assert.match(result.stderr[0] ?? "", expected);
    });
  }
});
