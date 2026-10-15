import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  FIXTURE_CONTROL_A,
  FIXTURE_CONTROL_B,
} from "./fixtures/companion-db.ts";
import { type CliRun, type FixtureEnv, setup } from "./helpers.ts";
import {
  ALPHA,
  BETA,
  button,
  insert,
  ok,
  readOnly,
  seedConnections,
  TWIN_A,
  TWIN_Z,
} from "./list-fixture.ts";

const find = (env: FixtureEnv, args: string[]): Promise<CliRun> =>
  readOnly(env, ["find", "--db", env.dbPath, ...args]);

const json = async (env: FixtureEnv, args: string[]) => {
  const stdout = ok(await find(env, [...args, "--json"]));
  assert.equal(stdout.length, 1);
  return JSON.parse(stdout[0] ?? "");
};

const id = (name: string) => name.padEnd(22, "A");
const SET = `bank:${id("FindSet")}`;
const STEPS = `bank:${id("FindSteps")}`;
const FEEDBACK = `bank:${id("FindFeedback")}`;
const OSC = `bank:${id("FindOsc")}`;
const LAYER = `bank:${id("FindLayer")}`;
const UNPLACED = `bank:${id("FindUnplaced")}`;
const TRIGGER = `trigger:${id("FindTrig")}`;
const CAMERA = id("ConnCamera");
const FIXTURE_CONNECTION = "FixtureConnectionAAAA";

const wrap = (value: unknown, isExpression = false) => ({
  value,
  isExpression,
});

/** An internal `custom_variable_set_value` action. */
function setAction(variable: string, value: string, isExpression = false) {
  return {
    type: "action",
    id: id(`Act${variable}${value.length}`),
    definitionId: "custom_variable_set_value",
    connectionId: "internal",
    options: { name: wrap(variable), value: wrap(value, isExpression) },
  };
}

function passthrough(
  type: string,
  connectionId: string,
  definitionId: string,
  options: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    type,
    id: id(`Ent${definitionId}`),
    definitionId,
    connectionId,
    options: Object.fromEntries(
      Object.entries(options).map(([key, value]) => [key, wrap(value)]),
    ),
    ...extra,
  };
}

const oneStep = (down: unknown[]) => ({
  steps: { "0": { action_sets: { down, up: [] }, options: {} } },
});

/**
 * Page 2 "Show Control": a set action, a two-step button with a
 * `rotate_left` expression action, an expression feedback with a text
 * override beside a pass-through feedback with a nested child, an OSC
 * pass-through action and a Companion-shaped extra text layer. A control on
 * no page, a camera connection and the "Reset counter" trigger.
 */
function seedFind(db: DatabaseSync): void {
  insert(db, "instances", CAMERA, {
    moduleInstanceType: "connection",
    moduleId: "camera-module",
    label: "camera",
    config: {},
    secrets: {},
    enabled: true,
    sortOrder: 1,
  });
  insert(
    db,
    "controls",
    SET,
    button("Set", oneStep([setAction("fx_label", "$(custom:fx_counter) on")])),
  );
  insert(
    db,
    "controls",
    STEPS,
    button("Steps", {
      steps: {
        "0": { action_sets: { down: [] }, options: {} },
        "1": {
          action_sets: {
            down: [],
            rotate_left: [
              setAction("fx_gap", "$(custom:fx_counter) * 2", true),
            ],
          },
          options: {},
        },
      },
    }),
  );
  insert(
    db,
    "controls",
    FEEDBACK,
    button("Tally", {
      feedbacks: [
        {
          type: "feedback",
          id: id("FbExpression"),
          definitionId: "check_expression",
          connectionId: "internal",
          options: { expression: wrap("$(custom:fx_counter) > 42", true) },
          isInverted: wrap(false),
          styleOverrides: [
            {
              overrideId: id("Override"),
              elementId: "text0",
              elementProperty: "text",
              override: wrap("ON AIR\\n$(custom:fx_label)"),
            },
          ],
          children: {},
        },
        passthrough(
          "feedback",
          FIXTURE_CONNECTION,
          "tally_state",
          { input: 42 },
          {
            isInverted: wrap(false),
            styleOverrides: [],
            children: {
              group: [
                passthrough("feedback", CAMERA, "source", {
                  source: "Camera Nine",
                }),
              ],
            },
          },
        ),
      ],
    }),
  );
  insert(
    db,
    "controls",
    OSC,
    button(
      "Go",
      oneStep([
        passthrough("action", FIXTURE_CONNECTION, "send_osc", {
          path: "/cue/Go/start",
          args: "$(custom:fx_counter)",
        }),
      ]),
    ),
  );
  insert(
    db,
    "controls",
    LAYER,
    button("$(custom:fx_counter2)", {
      style: {
        layers: [
          { id: "canvas", type: "canvas" },
          { id: "text0", type: "text", text: wrap("$(custom:fx_counter2)") },
          { id: "text1", type: "text", text: wrap("$(custom:fx_old)") },
        ],
      },
    }),
  );
  insert(db, "controls", UNPLACED, button("$(custom:fx_counter) stray"));
  insert(db, "pages", "2", {
    id: "FindPageAAAAAAAAAAAAA",
    name: "Show Control",
    controls: {
      "0": { "0": SET, "1": STEPS, "2": FEEDBACK },
      "1": { "0": OSC, "1": LAYER },
    },
  });
  insert(db, "controls", TRIGGER, {
    type: "trigger",
    options: { name: "Reset counter", enabled: true, sortOrder: 0 },
    events: [
      { id: "E1", type: "startup", enabled: true, options: { delay: 0 } },
      { id: "E2", type: "interval", enabled: true, options: { seconds: 5 } },
      {
        id: "E3",
        type: "variable_changed",
        enabled: true,
        options: { variableId: "custom:fx_counter" },
      },
    ],
    actions: [
      setAction("fx_label", "reset"),
      setAction("fx_counter", "$(this:current) + 1", true),
      setAction("fx_gap", "$(custom:fx_label)"),
    ],
    condition: [
      passthrough("feedback", FIXTURE_CONNECTION, "bus_state", {
        bus: "Program Bus",
      }),
    ],
  });
}

/** A find result line: where, control, then the rest, padded. */
const line = (
  where: string,
  control: string,
  rest: string,
  widths: [number, number],
) => `${where.padEnd(widths[0])}  ${control.padEnd(widths[1])}  ${rest}`;

describe("find --variable", () => {
  it("lists every control using a variable, with description paths", async () => {
    const env = setup({}, seedFind);
    const w: [number, number] = [23, 30];
    assert.deepEqual(ok(await find(env, ["--variable", "fx_counter"])), [
      line(
        "page 1 row 0 column 0",
        FIXTURE_CONTROL_A,
        "down[0].variable, text",
        w,
      ),
      line("page 2 row 0 column 0", SET, "down[0].value", w),
      line(
        "page 2 row 0 column 1",
        STEPS,
        "steps[1].rotate_left[0].expression",
        w,
      ),
      line("page 2 row 0 column 2", FEEDBACK, "feedbacks[0].expression", w),
      line("page 2 row 1 column 0", OSC, "down[0].options.args", w),
      line("unplaced", UNPLACED, "text", w),
      line(
        'trigger "Reset counter"',
        TRIGGER,
        "events[2].variable, actions[1].variable",
        w,
      ),
    ]);
  });

  it("applies a pattern to stored and referenced names", async () => {
    const env = setup({}, seedFind);
    const w: [number, number] = [23, 30];
    assert.deepEqual(ok(await find(env, ["--variable", "fx_*"])), [
      line(
        "page 1 row 0 column 0",
        FIXTURE_CONTROL_A,
        "down[0].variable, text",
        w,
      ),
      line("page 1 row 0 column 1", FIXTURE_CONTROL_B, "text", w),
      line("page 2 row 0 column 0", SET, "down[0].variable, down[0].value", w),
      line(
        "page 2 row 0 column 1",
        STEPS,
        "steps[1].rotate_left[0].variable, steps[1].rotate_left[0].expression",
        w,
      ),
      line(
        "page 2 row 0 column 2",
        FEEDBACK,
        "feedbacks[0].expression, feedbacks[0].style.text",
        w,
      ),
      line("page 2 row 1 column 0", OSC, "down[0].options.args", w),
      line("page 2 row 1 column 1", LAYER, "text, style.layers[2].text", w),
      line("unplaced", UNPLACED, "text", w),
      line(
        'trigger "Reset counter"',
        TRIGGER,
        "events[2].variable, actions[0].variable, actions[1].variable, +2 more",
        w,
      ),
    ]);
    const document = await json(env, ["--variable", "fx_*"]);
    assert.deepEqual(Object.keys(document), [
      "database",
      "databaseSource",
      "query",
      "variables",
      "exists",
      "matches",
    ]);
    assert.deepEqual(document.query, { variable: "fx_*" });
    assert.equal(document.exists, null);
    assert.deepEqual(document.variables, [
      { name: "fx_counter", exists: true },
      { name: "fx_counter2", exists: false },
      { name: "fx_gap", exists: true },
      { name: "fx_label", exists: true },
      { name: "fx_old", exists: false },
    ]);
    assert.deepEqual(document.matches.at(-1), {
      kind: "trigger",
      page: null,
      row: null,
      column: null,
      controlId: TRIGGER,
      triggerName: "Reset counter",
      paths: [
        "events[2].variable",
        "actions[0].variable",
        "actions[1].variable",
        "actions[2].variable",
        "actions[2].value",
      ],
    });
  });

  it("prints one JSON document with every match", async () => {
    const env = setup({}, seedFind);
    const document = await json(env, ["--variable", "fx_counter"]);
    assert.equal(document.database, env.dbPath);
    assert.equal(document.exists, true);
    assert.deepEqual(document.variables, [
      { name: "fx_counter", exists: true },
    ]);
    assert.deepEqual(
      document.matches.map(
        (match: { kind: string; controlId: string }) =>
          `${match.kind} ${match.controlId}`,
      ),
      [
        `button ${FIXTURE_CONTROL_A}`,
        `button ${SET}`,
        `button ${STEPS}`,
        `button ${FEEDBACK}`,
        `button ${OSC}`,
        `unplaced ${UNPLACED}`,
        `trigger ${TRIGGER}`,
      ],
    );
    assert.deepEqual(document.matches[0], {
      kind: "button",
      page: 1,
      row: 0,
      column: 0,
      controlId: FIXTURE_CONTROL_A,
      triggerName: null,
      paths: ["down[0].variable", "text"],
    });
    assert.deepEqual(document.matches[5], {
      kind: "unplaced",
      page: null,
      row: null,
      column: null,
      controlId: UNPLACED,
      triggerName: null,
      paths: ["text"],
    });
  });

  it("notes an exact name that names no variable", async () => {
    const env = setup({}, seedFind);
    assert.deepEqual(ok(await find(env, ["--variable", "fx_old"])), [
      `page 2 row 1 column 1  ${LAYER}  style.layers[2].text`,
      'note: no custom variable "fx_old" exists',
    ]);
    assert.deepEqual(ok(await find(env, ["--variable", "fx_nope"])), [
      'note: no custom variable "fx_nope" exists',
    ]);
    const document = await json(env, ["--variable", "fx_nope"]);
    assert.equal(document.exists, false);
    assert.deepEqual(document.variables, [{ name: "fx_nope", exists: false }]);
    assert.deepEqual(document.matches, []);
  });
});

describe("find --connection", () => {
  it("finds pass-through entities, conditions and label references", async () => {
    const env = setup({}, seedConnections);
    const via = (label: string, connection: string) =>
      `${label} (${connection})`;
    assert.deepEqual(ok(await find(env, ["--connection", "alpha"])), [
      `page 2 row 0 column 0  bank:SeedAlphaAAAAAAAAAAAA  ${via("alpha", ALPHA)}  steps[1].rotate_right[0].connection`,
      `unplaced               bank:SeedStrayAAAAAAAAAAAA  ${via("alpha", ALPHA)}  down[0].connection`,
    ]);
    assert.deepEqual(ok(await find(env, ["--connection", "beta"])), [
      `page 2 row 0 column 1  bank:SeedBetaAAAAAAAAAAAAA  ${via("beta", BETA)}  localVariables[0].connection, feedbacks[0].connection`,
    ]);
    assert.deepEqual(ok(await find(env, ["--connection", "twin"])), [
      `page 2 row 0 column 2  bank:SeedEchoAAAAAAAAAAAAA  ${via("twin", TWIN_Z)}, ${via("twin", TWIN_A)}  text`,
    ]);
    assert.deepEqual(ok(await find(env, ["--connection", "gamma"])), [
      `trigger "Uses gamma"  trigger:SeedTrigGammaAAAAAAA  ${via("gamma", "ConnGammaAAAAAAAAAAAA")}  actions[0].connection`,
    ]);
    assert.deepEqual(ok(await find(env, ["--connection", "delta"])), [
      `trigger "Uses delta"  trigger:SeedTrigDeltaAAAAAAA  ${via("delta", "ConnDeltaAAAAAAAAAAAA")}  conditions[0].connection`,
    ]);
  });

  it("names the connections a duplicate label resolves to", async () => {
    const env = setup({}, seedConnections);
    const document = await json(env, ["--connection", "twin"]);
    assert.deepEqual(Object.keys(document), [
      "database",
      "databaseSource",
      "query",
      "connections",
      "matches",
    ]);
    assert.deepEqual(document.query, { connection: "twin" });
    const twins = [
      { id: TWIN_Z, label: "twin" },
      { id: TWIN_A, label: "twin" },
    ];
    assert.deepEqual(document.connections, twins);
    assert.deepEqual(document.matches, [
      {
        kind: "button",
        page: 2,
        row: 0,
        column: 2,
        controlId: "bank:SeedEchoAAAAAAAAAAAAA",
        triggerName: null,
        paths: ["text"],
        connections: twins,
      },
    ]);
  });

  it("searches nested feedback children", async () => {
    const env = setup({}, seedFind);
    assert.deepEqual(ok(await find(env, ["--connection", "camera"])), [
      `page 2 row 0 column 2  ${FEEDBACK}  camera (${CAMERA})  feedbacks[1].children.group[0].connection`,
    ]);
  });

  it("searches every connection a pattern matches, internal included", async () => {
    const env = setup({}, seedFind);
    const via = `fixture (${FIXTURE_CONNECTION})`;
    const w: [number, number] = [23, 30];
    assert.deepEqual(ok(await find(env, ["--connection", "fix*"])), [
      line(
        "page 2 row 0 column 2",
        FEEDBACK,
        `${via}  feedbacks[1].connection`,
        w,
      ),
      line("page 2 row 1 column 0", OSC, `${via}  down[0].connection`, w),
      line(
        'trigger "Reset counter"',
        TRIGGER,
        `${via}  conditions[0].connection`,
        w,
      ),
    ]);
    const plain = setup();
    assert.deepEqual(ok(await find(plain, ["--connection", "int*"])), [
      `page 1 row 0 column 0  ${FIXTURE_CONTROL_A}  internal  down[0].connectionId`,
    ]);
    const document = await json(plain, ["--connection", "*"]);
    assert.deepEqual(document.connections, [
      { id: "internal", label: "internal" },
      { id: FIXTURE_CONNECTION, label: "fixture" },
    ]);
  });

  it("finds nothing for a pattern matching no label", async () => {
    const env = setup({}, seedConnections);
    assert.deepEqual(ok(await find(env, ["--connection", "zz*"])), []);
    const document = await json(env, ["--connection", "zz*"]);
    assert.deepEqual(document.connections, []);
    assert.deepEqual(document.matches, []);
  });

  it("refuses an exact label that names no connection", async () => {
    const env = setup({}, seedConnections);
    const result = await find(env, ["--connection", "nope"]);
    assert.equal(result.code, 1);
    assert.deepEqual(result.stdout, []);
    assert.deepEqual(result.stderr, ['error: no connection labelled "nope"']);
    const failed = await find(env, ["--connection", "nope", "--json"]);
    assert.equal(failed.code, 1);
    assert.deepEqual(JSON.parse(failed.stdout[0] ?? ""), {
      error: {
        code: "not_found",
        message: 'no connection labelled "nope"',
        hint: "run companion-cli list connections",
      },
    });
  });
});

describe("find <text>", () => {
  const texts = async (env: FixtureEnv, text: string) =>
    ok(await find(env, [text]));

  it("matches button text and text overrides across a line break, ignoring case", async () => {
    const env = setup({}, seedFind);
    assert.deepEqual(await texts(env, "count\n$("), [
      `page 1 row 0 column 0  ${FIXTURE_CONTROL_A}  text`,
    ]);
    assert.deepEqual(await texts(env, "AIR\n$(CUSTOM:FX_LABEL"), [
      `page 2 row 0 column 2  ${FEEDBACK}  feedbacks[0].style.text`,
    ]);
  });

  it("matches trigger names and page names", async () => {
    const env = setup({}, seedFind);
    assert.deepEqual(await texts(env, "RESET"), [
      `trigger "Reset counter"  ${TRIGGER}  name, actions[0].value`,
    ]);
    assert.deepEqual(await texts(env, "show"), ["page 2 name"]);
    const document = await json(env, ["show"]);
    assert.deepEqual(document.query, { text: "show" });
    assert.deepEqual(document.matches, [
      {
        kind: "page",
        page: 2,
        row: null,
        column: null,
        controlId: null,
        triggerName: null,
        paths: ["name"],
      },
    ]);
  });

  it("matches option values by their option path", async () => {
    const env = setup({}, seedFind);
    assert.deepEqual(await texts(env, "/cue/go"), [
      `page 2 row 1 column 0  ${OSC}  down[0].options.path`,
    ]);
    assert.deepEqual(await texts(env, "camera nine"), [
      `page 2 row 0 column 2  ${FEEDBACK}  feedbacks[1].children.group[0].options.source`,
    ]);
    assert.deepEqual(await texts(env, "program"), [
      `trigger "Reset counter"  ${TRIGGER}  conditions[0].options.bus`,
    ]);
    assert.deepEqual(await texts(env, "> 4"), [
      `page 2 row 0 column 2  ${FEEDBACK}  feedbacks[0].expression`,
    ]);
    assert.deepEqual(await texts(env, "42"), [
      `page 2 row 0 column 2  ${FEEDBACK}  feedbacks[0].expression, feedbacks[1].options.input`,
    ]);
  });

  it("names event options by their description fields (#27)", async () => {
    const events = `trigger:${id("FindEvts")}`;
    const env = setup({}, (db) =>
      insert(db, "controls", events, {
        type: "trigger",
        options: { name: "Events", enabled: true, sortOrder: 0, notes: "" },
        actions: [],
        condition: [],
        events: [
          {
            id: id("EvA"),
            type: "variable_changed",
            enabled: true,
            options: { variableId: "internal:time_hms" },
          },
          {
            id: id("EvB"),
            type: "timeofday",
            enabled: true,
            options: { time: "08:30:00", days: [5] },
          },
          {
            id: id("EvC"),
            type: "specificDate",
            enabled: true,
            options: { date: "2026-08-30", time: "10:00" },
          },
          {
            id: id("EvD"),
            type: "sun_event",
            enabled: true,
            options: { type: "sunset", latitude: 0, longitude: 0, offset: 0 },
          },
        ],
        localVariables: [],
      }),
    );
    assert.deepEqual(await texts(env, "time_hms"), [
      `trigger "Events"  ${events}  events[0].variableId`,
    ]);
    assert.deepEqual(await texts(env, "08:30"), [
      `trigger "Events"  ${events}  events[1].time`,
    ]);
    assert.deepEqual(await texts(env, "2026-08"), [
      `trigger "Events"  ${events}  events[2].date`,
    ]);
    assert.deepEqual(await texts(env, "sunset"), [
      `trigger "Events"  ${events}  events[3].sun`,
    ]);
    assert.deepEqual(await texts(env, "5"), [
      `trigger "Events"  ${events}  events[1].days[0]`,
    ]);
  });

  it("never matches option keys, ids, definitions or connections", async () => {
    const env = setup({}, seedFind);
    for (const text of [
      "send_osc",
      "custom_variable_set_value",
      "input",
      "FixtureAction",
      "FixtureConnection",
      CAMERA,
      "internal",
      // Every wrapper's isExpression flag: not an option value.
      "false",
      "true",
    ]) {
      assert.deepEqual(await texts(env, text), [], text);
    }
  });
});

describe("find", () => {
  it("refuses a command line without exactly one valid query", async () => {
    const env = setup();
    for (const args of [
      [],
      ["--variable", "fx_counter", "--connection", "fixture"],
      ["--variable", "fx_counter", "--variable", "fx_label"],
      ["--variable", "fx_counter", "text"],
      ["one", "two"],
      ["--variable", ""],
      ["--connection", ""],
      [""],
      ["--variable", "fx-counter"],
      ["--variable", "fx-*"],
      ["--variable", "constructor"],
      ["--bogus", "x"],
    ]) {
      const result = await find(env, args);
      assert.equal(result.code, 2, args.join(" "));
      assert.match(result.stderr[0] ?? "", /^error: .*usage: companion-cli/);
      const failed = await find(env, [...args, "--json"]);
      assert.equal(failed.code, 2, args.join(" "));
      assert.equal(JSON.parse(failed.stdout[0] ?? "").error.code, "usage");
    }
  });

  it("skips option values when it finds the command word", async () => {
    const env = setup();
    const result = await readOnly(env, [
      "--variable",
      "list",
      "find",
      "--db",
      env.dbPath,
    ]);
    assert.deepEqual(ok(result), ['note: no custom variable "list" exists']);
  });

  it("gives byte-identical output on every run", async () => {
    const env = setup({}, seedFind);
    for (const args of [["--variable", "fx_*"], ["--connection", "*"], ["a"]]) {
      for (const extra of [[], ["--json"]]) {
        const first = ok(await find(env, [...args, ...extra]));
        assert.deepEqual(ok(await find(env, [...args, ...extra])), first);
      }
    }
  });
});
