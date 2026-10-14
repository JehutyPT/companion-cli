import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  buildFixtureDb,
  FIXTURE_CONTROL_A,
  FIXTURE_CONTROL_B,
  type FixtureOptions,
} from "./fixtures/companion-db.ts";
import {
  dumpDatabase,
  fileState,
  printedBackupDir,
  runCli,
  type TableDump,
  tempDir,
  writeDescription,
} from "./helpers.ts";

const ID = /^[A-Za-z0-9_-]{21}$/;
const CONTROL_ID = /^bank:[A-Za-z0-9_-]{21}$/;

function setup(options: FixtureOptions = {}) {
  const dir = tempDir();
  const dbPath = buildFixtureDb(join(dir, "install"), options);
  const backupRoot = join(dir, "backups");
  return { dir, dbPath, backupRoot };
}

function applyYaml(yaml: string, options: FixtureOptions = {}) {
  const env = setup(options);
  const before = dumpDatabase(env.dbPath);
  const result = runCli(
    ["apply", writeDescription(env.dir, yaml), "--db", env.dbPath],
    { backupRoot: env.backupRoot },
  );
  return { ...env, before, result };
}

type Json = Record<string, unknown>;

function rows(dump: TableDump, table: string): Map<string, Json> {
  return new Map(
    (dump[table] ?? []).map((row) => [row.id, JSON.parse(row.value) as Json]),
  );
}

function page(dump: TableDump, id = "1"): Json {
  const value = rows(dump, "pages").get(id);
  assert.ok(value, `pages row ${id}`);
  return value;
}

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

function withoutTables(dump: TableDump, ...tables: string[]): TableDump {
  return Object.fromEntries(
    Object.entries(dump).filter(([table]) => !tables.includes(table)),
  );
}

/** Replaces generated control and action ids so two applies can be compared. */
function normaliseIds(dump: TableDump): TableDump {
  const generated = new Set<string>();
  for (const row of dump["controls"] ?? []) {
    if (row.id.startsWith("bank:Fixture")) continue;
    generated.add(row.id);
    for (const match of row.value.matchAll(/"id":"([A-Za-z0-9_-]{21})"/g))
      generated.add(match[1] ?? "");
  }
  const replace = (text: string) => {
    let out = text;
    for (const id of generated) out = out.split(id).join("<id>");
    return out;
  };
  return Object.fromEntries(
    Object.entries(dump).map(([table, tableRows]) => [
      table,
      tableRows
        .map((row) => ({ id: replace(row.id), value: replace(row.value) }))
        .sort((a, b) => (a.id + a.value).localeCompare(b.id + b.value, "en")),
    ]),
  );
}

const prop = (value: unknown) => ({ value, isExpression: false });
const geometry = {
  enabled: prop(true),
  opacity: prop(100),
  x: prop(0),
  y: prop(0),
  width: prop(100),
  height: prop(100),
  rotation: prop(0),
};

const SIMPLE_YAML = `kind: button
location: { page: 1, row: 0, column: 2 }
text: "Count\\n$(custom:fx_counter)"
background: "#000080"
`;

describe("apply button: success", () => {
  it("writes a button-layered control at an empty cell of an existing row", () => {
    const { dbPath, before, result } = applyYaml(SIMPLE_YAML);

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
    assert.deepEqual(
      withoutTables(after, "pages", "controls"),
      withoutTables(before, "pages", "controls"),
    );
  });

  it("matches the key paths of the fixture's documented controls", () => {
    const { dbPath, before, result } = applyYaml(`kind: button
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

  it("replaces the control at an occupied cell and deletes the old one", () => {
    const { dbPath, before, result } = applyYaml(`kind: button
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

  it("creates the row key for an empty cell in a missing row and deletes nothing", () => {
    const { dbPath, before, result } = applyYaml(`kind: button
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
    assert.deepEqual(
      withoutTables(after, "pages", "controls"),
      withoutTables(before, "pages", "controls"),
    );
  });

  it("accepts negative rows and columns within the grid", () => {
    const env = setup();
    const db = new DatabaseSync(env.dbPath);
    db.prepare("UPDATE main SET value = ? WHERE id = 'userconfig'").run(
      JSON.stringify({
        gridSize: { minColumn: -2, maxColumn: 7, minRow: -1, maxRow: 3 },
        setup_wizard: 0,
      }),
    );
    db.close();
    const result = runCli(
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

  it("stores colors as integers and picks the text color by background brightness", () => {
    const cases: Array<[string, string, number, number]> = [
      ['background: "#FFFFFF"', "", 0xffffff, 0x000000],
      ['background: "#000080"', "", 0x000080, 0xffffff],
      // luma of #8C8C8C is exactly 140: not greater, so white text.
      ['background: "#8c8c8c"', "", 0x8c8c8c, 0xffffff],
      ['background: "#8D8D8D"', "", 0x8d8d8d, 0x000000],
      ['background: "#ffff00"', 'textColor: "#Ff0000"', 0xffff00, 0xff0000],
    ];
    for (const [bg, fg, expectedBg, expectedFg] of cases) {
      const { dbPath, result } = applyYaml(`kind: button
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

  it("is idempotent apart from ids, and the first control is gone after the second apply", () => {
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
      runCli(["apply", file, "--db", dbPath], { backupRoot, now }).code,
      0,
    );
    const first = dumpDatabase(dbPath);
    const firstId = controlAt(first, 0, 0).id;
    const second = runCli(["apply", file, "--db", dbPath], { backupRoot, now });
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

  const internal = (name: string, value: unknown, isExpression: boolean) => ({
    type: "action",
    definitionId: "custom_variable_set_value",
    connectionId: "internal",
    options: { name: prop(name), value: { value, isExpression } },
  });

  function withoutIds(actions: Json[]): Json[] {
    return actions.map(({ id, ...rest }) => {
      assert.match(String(id), ID);
      return rest;
    });
  }

  it("writes internal and pass-through actions in file order", () => {
    const { dbPath, result } = applyYaml(ACTIONS_YAML);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    const { control } = controlAt(dumpDatabase(dbPath), 3, 7);

    assert.deepEqual(withoutIds(downActions(control, "down")), [
      internal("fx_label", "pressed", false),
      internal("fx_counter", "42", false),
      internal("fx_gap", "true", false),
      internal("fx_label", "$(custom:fx_counter) * 2", true),
      internal("fx_counter", "$(this:current) + 1", true),
      internal("fx_counter", "$(this:current) - 3", true),
    ]);
    assert.deepEqual(withoutIds(downActions(control, "up")), [
      internal("fx_counter", "$(this:current) + 5", true),
      {
        type: "action",
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
        definitionId: "bare",
        connectionId: "other",
        options: {},
      },
    ]);
    assert.deepEqual(downActions(control, "rotate_left"), []);
    assert.deepEqual(downActions(control, "rotate_right"), []);
  });

  it("generates distinct action ids", () => {
    const { dbPath, result } = applyYaml(ACTIONS_YAML);
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
  const textOf = (yamlText: string) => {
    const { dbPath, result } = applyYaml(`kind: button
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

  it("stores a block scalar's lines with literal backslash-n and no trailing newline", () => {
    assert.equal(
      textOf("text: |\n  Line one\n  Line two\n"),
      "Line one\\nLine two",
    );
  });

  it("removes exactly one trailing newline", () => {
    assert.equal(textOf('text: "a\\n\\n"\n'), "a\\n");
  });

  it("keeps a literal backslash-n unchanged", () => {
    assert.equal(textOf("text: Line\\nTwo\n"), "Line\\nTwo");
  });

  it("allows empty text", () => {
    assert.equal(textOf('text: ""\n'), "");
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
    ["steps field", base({ steps: "[]" }), /^error: .*: steps: unknown field$/],
    [
      "feedbacks field",
      base({ feedbacks: "[]" }),
      /: feedbacks: unknown field$/,
    ],
    [
      "rotate_left field",
      base({ rotate_left: "[]" }),
      /: rotate_left: unknown field$/,
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
    it(name, () => {
      const { dir, dbPath, backupRoot } = setup({ wal: true });
      const before = fileState(dbPath);
      const result = runCli(
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

  it("does not check pass-through connections or options against the database", () => {
    const { result } = applyYaml(
      down(
        '{ action: passthrough, connection: NoSuchConnection, definition: d, options: { x: "$(custom:not_checked)" } }',
      ),
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
  });

  it("re-checks under the write lock: a variable removed after the snapshot is refused", () => {
    const { dir, dbPath, backupRoot } = setup();
    const result = runCli(
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

  function refuse(env: ReturnType<typeof setup>, expected: RegExp) {
    const before = fileState(env.dbPath);
    const result = runCli(
      ["apply", writeDescription(env.dir, CELL_YAML), "--db", env.dbPath],
      { backupRoot: env.backupRoot },
    );
    assert.equal(result.code, 1, result.stdout.join("\n"));
    assert.equal(result.stderr.length, 1);
    assert.match(result.stderr[0] ?? "", expected);
    assert.deepEqual(fileState(env.dbPath), before);
    assert.equal(existsSync(env.backupRoot), false, "no backup for a refusal");
  }

  it("reports a cell pointing at a missing control row as replaced", () => {
    const missing = "bank:MissingCtrlXXXXXXXXXX";
    const env = setupWithCell(missing);
    const before = dumpDatabase(env.dbPath);
    const result = runCli(
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

  it("refuses a target cell holding a non-button control id and keeps that row", () => {
    const triggerId = "trigger:FixtureTrigAAAAAAAAAAA";
    const env = setupWithCell(triggerId, (db) =>
      db
        .prepare("INSERT INTO controls (id, value) VALUES (?, ?)")
        .run(triggerId, JSON.stringify({ type: "trigger" })),
    );
    refuse(
      env,
      /^error: location: page 1, row 0, column 2 holds "trigger:FixtureTrigAAAAAAAAAAA", which is not a button control/,
    );
  });

  it("refuses a grid size with non-integer bounds", () => {
    const env = setup();
    setGrid(env.dbPath, {
      minColumn: 0,
      maxColumn: 7.5,
      minRow: 0,
      maxRow: 3,
    });
    refuse(env, /^error: cannot read the grid size/);
  });

  it("refuses a grid size whose minimum exceeds its maximum", () => {
    const env = setup();
    setGrid(env.dbPath, { minColumn: 8, maxColumn: 7, minRow: 0, maxRow: 3 });
    refuse(env, /^error: cannot read the grid size/);
  });
});
