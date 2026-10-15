/**
 * Local variables on buttons and triggers (#25), in apply and export. Each is
 * a feedback entity in the control's `localVariables` with `variableName`,
 * created by Companion's entity factory with `isInverted`, `styleOverrides: []`
 * and, on connection internal, `children: {}` (Instance/Definitions.ts); the
 * shortcuts are the internal `user_value` and `expression_value` definitions
 * (Internal/Variables.ts). `$(local:…)` references are checked against the
 * control's own names (docs/companion-internals.md, "Local variables").
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { parseDescription } from "../src/core/description.ts";
import { ValidationError } from "../src/core/errors.ts";
import { writers } from "../src/writers/index.ts";
import {
  assertRefused,
  exportRoundTrip,
  insert,
  mutate,
} from "./export-helpers.ts";
import { FIXTURE_CONTROL_A } from "./fixtures/companion-db.ts";
import {
  applyTo,
  applyYaml,
  dumpDatabase,
  fileState,
  type Json,
  page,
  prop,
  rows,
  runCli,
  setup,
  stripIds,
  writeDescription,
} from "./helpers.ts";

const BUTTON = `kind: button
location: { page: 1, row: 0, column: 2 }
text: "$(local:count)"
background: "#000080"
`;

const LOCALS = `localVariables:
  - { name: count, value: 0 }
  - name: my-var.2
    value: { expr: "1 + 1" }
    persist: true
    headline: Kept
    disabled: true
    upgradeIndex: 2
  - { name: double, expression: "$(local:count) * 2" }
  - name: level
    feedback: passthrough
    connection: FixtureConnectionAAAA
    definition: level_value
    options: { channel: 3 }
  - { name: on, feedback: expression, expression: "$(local:double) > 2" }
`;

const internal = (definitionId: string, options: Json, extra: Json = {}) => ({
  type: "feedback",
  id: "<id>",
  definitionId,
  connectionId: "internal",
  options,
  isInverted: prop(false),
  styleOverrides: [],
  children: {},
  ...extra,
});

/** What the writer stores for LOCALS. */
const STORED_LOCALS = [
  internal(
    "user_value",
    { persist_value: prop(false), startup_value: prop(0) },
    { variableName: "count" },
  ),
  internal(
    "user_value",
    { persist_value: prop(true), startup_value: prop("1 + 1", true) },
    {
      variableName: "my-var.2",
      headline: "Kept",
      disabled: true,
      upgradeIndex: 2,
    },
  ),
  internal(
    "expression_value",
    { expression: prop("$(local:count) * 2", true) },
    { variableName: "double" },
  ),
  {
    type: "feedback",
    id: "<id>",
    definitionId: "level_value",
    connectionId: "FixtureConnectionAAAA",
    options: { channel: prop(3) },
    isInverted: prop(false),
    styleOverrides: [],
    variableName: "level",
  },
  internal(
    "check_expression",
    { expression: prop("$(local:double) > 2", true) },
    { variableName: "on" },
  ),
];

/** The control at page 1, row 0, column 2 after applying `yaml`. */
async function buttonAt02(yaml: string): Promise<Json> {
  const { dbPath, result } = await applyYaml(yaml);
  assert.equal(result.code, 0, result.stderr.join("\n"));
  const dump = dumpDatabase(dbPath);
  const controls = page(dump)["controls"] as Record<
    string,
    Record<string, string>
  >;
  const id = controls["0"]?.["2"];
  assert.ok(id);
  return stripIds(rows(dump, "controls").get(id)) as Json;
}

/** The one trigger a dump has that the fixture did not, ids stripped. */
async function appliedTrigger(yaml: string): Promise<Json> {
  const { dbPath, before, result } = await applyYaml(yaml);
  assert.equal(result.code, 0, result.stderr.join("\n"));
  const old = rows(before, "controls");
  const added = [...rows(dumpDatabase(dbPath), "controls")].filter(
    ([id]) => !old.has(id),
  );
  assert.equal(added.length, 1);
  return stripIds((added[0] as [string, Json])[1]) as Json;
}

/** The validation message for a description, or a failure when it is accepted. */
function refusal(description: Json): string {
  try {
    parseDescription(description, writers);
  } catch (error) {
    if (error instanceof ValidationError) return error.message;
    throw error;
  }
  assert.fail("accepted");
}

const button = (extra: Json): Json => ({
  kind: "button",
  location: { page: 1, row: 0, column: 2 },
  text: "",
  background: "#000000",
  ...extra,
});

const trigger = (extra: Json): Json => ({
  kind: "trigger",
  name: "T",
  events: [{ event: "startup" }],
  ...extra,
});

describe("local variables: apply", () => {
  it("stores each kind of entry on a button, in order", async () => {
    const control = await buttonAt02(`${BUTTON}${LOCALS}`);
    assert.deepEqual(control["localVariables"], STORED_LOCALS);
  });

  it("still stores localVariables: [] when the description has none", async () => {
    const control = await buttonAt02(BUTTON.replace("$(local:count)", "plain"));
    assert.deepEqual(control["localVariables"], []);
  });

  it("stores them on a trigger, with a variable_changed event on one", async () => {
    const control = await appliedTrigger(`kind: trigger
name: Locals
events:
  - { event: variable_changed, variableId: "local:count" }
actions:
  - { action: set, variable: fx_label, value: "$(local:double)" }
${LOCALS}`);
    assert.deepEqual(control["localVariables"], STORED_LOCALS);
    assert.deepEqual((control["events"] as Json[])[0], {
      id: "<id>",
      type: "variable_changed",
      enabled: true,
      options: { variableId: "local:count" },
    });
  });

  it("stores them on page buttons", async () => {
    const { dbPath, result } = await applyYaml(`kind: page
page: 1
name: P
buttons:
  - location: { row: 0, column: 0 }
    text: "$(local:count)"
    background: "#000000"
    localVariables: [{ name: count, value: 5 }]
`);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    const dump = dumpDatabase(dbPath);
    const id = (
      page(dump)["controls"] as Record<string, Record<string, string>>
    )["0"]?.["0"] as string;
    const control = stripIds(rows(dump, "controls").get(id)) as Json;
    assert.deepEqual(control["localVariables"], [
      internal(
        "user_value",
        { persist_value: prop(false), startup_value: prop(5) },
        { variableName: "count" },
      ),
    ]);
  });

  const cases: Array<[string, Json, string]> = [
    [
      "a duplicate name",
      button({
        localVariables: [
          { name: "a", value: 1 },
          { name: "a", expression: "1", disabled: true },
        ],
      }),
      'localVariables[1].name: duplicate local variable name "a" (also at localVariables[0])',
    ],
    [
      "an invalid name",
      button({ localVariables: [{ name: "a b", value: 1 }] }),
      'localVariables[0].name: invalid local variable name "a b"',
    ],
    [
      "variableName in an entry",
      button({
        localVariables: [
          { name: "a", feedback: "step", step: 1, variableName: "a" },
        ],
      }),
      "localVariables[0].variableName: is not allowed in a local variable",
    ],
    [
      "both value and expression",
      button({ localVariables: [{ name: "a", value: 1, expression: "1" }] }),
      "localVariables[0].expression: give either value or expression, not both",
    ],
    [
      "an entry with neither value, expression nor feedback",
      button({ localVariables: [{ name: "a" }] }),
      "localVariables[0].value: is required",
    ],
    [
      "an unknown reference in the text",
      button({ text: "$(local:nope)" }),
      'text: unknown local variable "nope" (the control has no localVariables)',
    ],
    [
      "an unknown reference in an action",
      button({
        localVariables: [{ name: "a", value: 1 }],
        steps: [
          {},
          {
            down: [
              { action: "set", variable: "fx_label", value: "$(local:b)" },
            ],
          },
        ],
      }),
      'steps[1].down[0].value: unknown local variable "b" (the control\'s localVariables are a)',
    ],
    [
      "an unknown reference in a feedback",
      button({
        feedbacks: [{ feedback: "expression", expression: "$(local:x) > 1" }],
      }),
      'feedbacks[0].expression: unknown local variable "x"',
    ],
    [
      "an unknown reference in another local variable's expression",
      button({
        localVariables: [
          { name: "a", value: 1 },
          { name: "b", expression: "$(local:a) + $(local:c)" },
        ],
      }),
      'localVariables[1].expression: unknown local variable "c" (the control\'s localVariables are a, b)',
    ],
    [
      "an unknown reference in a trigger action",
      trigger({
        actions: [{ action: "set", variable: "fx_label", value: "$(local:x)" }],
      }),
      'actions[0].value: unknown local variable "x" (the control has no localVariables)',
    ],
    [
      "a variable_changed event on an unknown local variable",
      trigger({
        events: [{ event: "variable_changed", variableId: "local:x" }],
        localVariables: [{ name: "y", value: 1 }],
      }),
      'events[0].variableId: unknown local variable "x" (the control\'s localVariables are y)',
    ],
  ];
  for (const [name, description, expected] of cases) {
    it(`refuses ${name}, naming the field`, () => {
      const message = refusal(description);
      assert.ok(
        message.startsWith(expected),
        `${message}\n  expected: ${expected}`,
      );
    });
  }

  it("refuses before touching the database", async () => {
    const env = setup();
    const before = fileState(env.dbPath);
    const result = await applyTo(env, `${BUTTON}`);
    assert.equal(result.code, 1);
    assert.match(result.stderr.join("\n"), /unknown local variable "count"/);
    assert.deepEqual(fileState(env.dbPath), before);
  });
});

describe("local variables: export", () => {
  it("exports a tool-written button's local variables, round-tripping", async () => {
    const env = setup();
    const applied = await applyTo(env, `${BUTTON}${LOCALS}`);
    assert.equal(applied.code, 0, applied.stderr.join("\n"));
    const yaml = await exportRoundTrip(env, ["page", "1", "--button", "0/2"]);
    assert.deepEqual((parse(yaml) as Json)["localVariables"], [
      { name: "count", value: 0 },
      {
        name: "my-var.2",
        value: { expr: "1 + 1" },
        persist: true,
        headline: "Kept",
        disabled: true,
        upgradeIndex: 2,
      },
      { name: "double", expression: "$(local:count) * 2" },
      {
        name: "level",
        feedback: "passthrough",
        connection: "FixtureConnectionAAAA",
        definition: "level_value",
        options: { channel: 3 },
      },
      { name: "on", feedback: "expression", expression: "$(local:double) > 2" },
    ]);
    await exportRoundTrip(env, ["page", "1"]);
  });

  it("exports a tool-written trigger's local variables, round-tripping", async () => {
    const env = setup();
    const applied = await applyTo(
      env,
      `kind: trigger
name: Locals
events:
  - { event: variable_changed, variableId: "local:count" }
${LOCALS}`,
    );
    assert.equal(applied.code, 0, applied.stderr.join("\n"));
    const yaml = await exportRoundTrip(env, ["trigger", "Locals"]);
    const locals = (parse(yaml) as Json)["localVariables"] as Json[];
    assert.deepEqual(
      locals.map((local) => local["name"]),
      ["count", "my-var.2", "double", "level", "on"],
    );
    await exportRoundTrip(env, ["triggers"]);
  });

  /** Local variables as Companion's UI creates them: factory key order, defaults. */
  const COMPANION_LOCALS = [
    {
      type: "feedback",
      id: "SeedLocalUserValue001",
      definitionId: "user_value",
      connectionId: "internal",
      options: {
        persist_value: { isExpression: false, value: false },
        startup_value: { isExpression: false, value: "1" },
      },
      isInverted: { isExpression: false, value: false },
      styleOverrides: [],
      children: {},
      variableName: "tally-1.state",
    },
    {
      type: "feedback",
      id: "SeedLocalPersisted001",
      definitionId: "user_value",
      connectionId: "internal",
      options: {
        persist_value: { isExpression: false, value: true },
        startup_value: { isExpression: false, value: 42 },
      },
      isInverted: { isExpression: false, value: false },
      styleOverrides: [],
      children: {},
      variableName: "kept",
    },
    {
      type: "feedback",
      id: "SeedLocalExpression01",
      definitionId: "expression_value",
      connectionId: "internal",
      options: {
        expression: { isExpression: true, value: "$(local:kept) + 1" },
      },
      isInverted: { isExpression: false, value: false },
      styleOverrides: [],
      children: {},
      variableName: "next",
    },
    {
      type: "feedback",
      id: "SeedLocalModule000001",
      definitionId: "level_value",
      connectionId: "FixtureConnectionAAAA",
      options: { channel: { isExpression: false, value: 3 } },
      upgradeIndex: 1,
      isInverted: { isExpression: false, value: false },
      styleOverrides: [],
      variableName: "level",
    },
    {
      // Not the shortcut: an extra option key makes it a feedback entry.
      type: "feedback",
      id: "SeedLocalOddValue0001",
      definitionId: "user_value",
      connectionId: "internal",
      options: {
        persist_value: { isExpression: false, value: false },
        startup_value: { isExpression: false, value: "" },
        extra: { isExpression: false, value: 1 },
      },
      isInverted: { isExpression: false, value: false },
      styleOverrides: [],
      children: {},
      variableName: "odd",
    },
  ];

  const EXPORTED_COMPANION_LOCALS = [
    { name: "tally-1.state", value: "1" },
    { name: "kept", value: 42, persist: true },
    { name: "next", expression: "$(local:kept) + 1" },
    {
      name: "level",
      feedback: "passthrough",
      connection: "FixtureConnectionAAAA",
      definition: "level_value",
      options: { channel: 3 },
      upgradeIndex: 1,
    },
    {
      name: "odd",
      feedback: "passthrough",
      connection: "internal",
      definition: "user_value",
      options: { persist_value: false, startup_value: "", extra: 1 },
    },
  ];

  it("round-trips a Companion-shaped button's local variables", async () => {
    const env = setup({}, (db) =>
      mutate(db, "controls", FIXTURE_CONTROL_A, (value) => ({
        ...value,
        localVariables: COMPANION_LOCALS,
      })),
    );
    const yaml = await exportRoundTrip(env, ["page", "1", "--button", "0/0"]);
    assert.deepEqual(
      (parse(yaml) as Json)["localVariables"],
      EXPORTED_COMPANION_LOCALS,
    );
    const pageYaml = await exportRoundTrip(env, ["page", "1"]);
    const buttons = (parse(pageYaml) as Json)["buttons"] as Json[];
    assert.deepEqual(
      (buttons[0] as Json)["localVariables"],
      EXPORTED_COMPANION_LOCALS,
    );
  });

  it("round-trips a Companion-shaped trigger's local variables", async () => {
    const env = setup({}, (db) =>
      insert(db, "controls", "trigger:SeedTriggerLocals0001", {
        type: "trigger",
        options: { name: "Seeded", enabled: true, sortOrder: 9, notes: "" },
        actions: [],
        condition: [],
        events: [
          {
            id: "SeedEventLocals000001",
            type: "variable_changed",
            enabled: true,
            options: { variableId: "local:kept" },
          },
        ],
        localVariables: COMPANION_LOCALS,
      }),
    );
    const yaml = await exportRoundTrip(env, ["trigger", "Seeded"]);
    assert.deepEqual(
      (parse(yaml) as Json)["localVariables"],
      EXPORTED_COMPANION_LOCALS,
    );
  });

  it("refuses an entry without a valid variableName, naming it", async () => {
    const env = setup({}, (db) =>
      mutate(db, "controls", FIXTURE_CONTROL_A, (value) => ({
        ...value,
        localVariables: [{ ...COMPANION_LOCALS[0], variableName: "has space" }],
      })),
    );
    await assertRefused(
      env,
      ["page", "1", "--button", "0/0"],
      `cannot export page 1, row 0, column 0 (${FIXTURE_CONTROL_A}): localVariables[0].variableName is "has space", not a local variable name (letters A-Z/a-z, digits, _, - and .) (see docs/support-matrix.md, local variable)`,
      "localVariables[0].variableName",
      "see docs/support-matrix.md (local variable)",
    );
  });

  it("refuses duplicate names, naming the stored field", async () => {
    const env = setup({}, (db) =>
      mutate(db, "controls", FIXTURE_CONTROL_A, (value) => ({
        ...value,
        localVariables: [COMPANION_LOCALS[0], COMPANION_LOCALS[0]],
      })),
    );
    const result = await runCli([
      "export",
      "page",
      "1",
      "--button",
      "0/0",
      "--db",
      env.dbPath,
      "--json",
    ]);
    assert.equal(result.code, 1);
    const { error } = JSON.parse(result.stdout[0] as string);
    assert.equal(error.path, "localVariables[1].variableName");
    assert.match(error.message, /duplicate local variable name/);
  });

  it("a description written before #25 still applies byte-identically", async () => {
    const env = setup();
    const file = writeDescription(
      env.dir,
      BUTTON.replace("$(local:count)", "plain"),
      "old.yaml",
    );
    const first = await runCli(["apply", file, "--db", env.dbPath], {
      backupRoot: env.backupRoot,
      tmpdir: env.tmpdir,
    });
    assert.equal(first.code, 0, first.stderr.join("\n"));
    const dry = await runCli(
      ["apply", file, "--db", env.dbPath, "--dry-run", "--json"],
      { tmpdir: env.tmpdir },
    );
    assert.equal(JSON.parse(dry.stdout.join("\n")).changed, false);
  });
});
