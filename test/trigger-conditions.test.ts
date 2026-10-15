/**
 * Trigger notes, conditions and the condition events (#26), in apply and
 * export. Conditions are boolean feedback entities stored in `condition`,
 * each with `isInverted` and `styleOverrides: []` as Companion's entity
 * factory creates them (Instance/Definitions.ts); the condition events fire
 * when the conditions taken together change (Triggers/Trigger.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { SCHEMA_MODELINE } from "../src/schema.ts";
import { assertRefused, exportRoundTrip, insert } from "./export-helpers.ts";
import {
  applyTo,
  applyYaml,
  dumpDatabase,
  fileState,
  type Json,
  prop,
  rows,
  runCli,
  setup,
  stripIds,
} from "./helpers.ts";

const INVERT_FALSE = prop(false);

/** The one control a dump has that `before` did not, ids replaced by `<id>`. */
function addedControl(
  before: ReturnType<typeof dumpDatabase>,
  dbPath: string,
): Json {
  const old = rows(before, "controls");
  const added = [...rows(dumpDatabase(dbPath), "controls")].filter(
    ([id]) => !old.has(id),
  );
  assert.equal(added.length, 1);
  return stripIds((added[0] as [string, Json])[1]) as Json;
}

const TRIGGER = `kind: trigger
name: Guarded
notes: |
  First line
  Second line
events:
  - { event: interval, seconds: 5 }
  - { event: condition_true }
  - { event: condition_false, enabled: false }
conditions:
  - condition: expression
    expression: "$(custom:fx_counter) > 2"
    invert: true
  - condition: passthrough
    connection: FixtureConnectionAAAA
    definition: tally
    options: { bus: program }
    headline: On air
actions:
  - { action: increment, variable: fx_counter }
`;

describe("trigger conditions and notes: apply", () => {
  it("stores notes, conditions as boolean feedbacks, and the condition events", async () => {
    const { dbPath, before, result } = await applyYaml(TRIGGER);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    const control = addedControl(before, dbPath);
    assert.deepEqual(control["options"], {
      name: "Guarded",
      enabled: true,
      sortOrder: 0,
      notes: "First line\nSecond line\n",
    });
    assert.deepEqual(control["condition"], [
      {
        type: "feedback",
        id: "<id>",
        definitionId: "check_expression",
        connectionId: "internal",
        options: { expression: prop("$(custom:fx_counter) > 2", true) },
        children: {},
        isInverted: prop(true),
        styleOverrides: [],
      },
      {
        type: "feedback",
        id: "<id>",
        definitionId: "tally",
        connectionId: "FixtureConnectionAAAA",
        options: { bus: prop("program") },
        headline: "On air",
        isInverted: INVERT_FALSE,
        styleOverrides: [],
      },
    ]);
    assert.deepEqual(
      (control["events"] as Json[]).map(({ type, enabled, options }) => ({
        type,
        enabled,
        options,
      })),
      [
        { type: "interval", enabled: true, options: { seconds: 5 } },
        { type: "condition_true", enabled: true, options: {} },
        { type: "condition_false", enabled: false, options: {} },
      ],
    );
  });

  it("keeps notes empty and the condition list empty by default", async () => {
    const { dbPath, before, result } = await applyYaml(
      "kind: trigger\nname: Plain\nevents: [{ event: startup }]\n",
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    const control = addedControl(before, dbPath);
    assert.equal((control["options"] as Json)["notes"], "");
    assert.deepEqual(control["condition"], []);
  });

  const refusals: Array<[string, string, string]> = [
    [
      "a condition with a style",
      `conditions:\n  - { condition: expression, expression: "1 > 0", style: { text: x } }\n`,
      "triggers[0].conditions[0].style: unknown field",
    ],
    [
      "a step condition",
      `conditions:\n  - { condition: step, step: 1 }\n`,
      'triggers[0].conditions[0].condition: unknown condition "step" (expected one of: expression, passthrough)',
    ],
    [
      "a condition with a variableName",
      `conditions:\n  - { condition: passthrough, connection: c, definition: d, variableName: v }\n`,
      "triggers[0].conditions[0].variableName: unknown field",
    ],
    [
      "notes that are not a string",
      "notes: 3\n",
      "triggers[0].notes: must be a string",
    ],
  ];
  for (const [name, extra, message] of refusals) {
    it(`refuses ${name} with its path`, async () => {
      const env = setup();
      const before = fileState(env.dbPath);
      const result = await applyTo(
        env,
        `kind: triggers\ntriggers:\n  - name: T\n    events: [{ event: startup }]\n${extra.replace(/^/gm, "    ")}`,
      );
      assert.equal(result.code, 1);
      assert.ok(
        result.stderr.some((line) => line.includes(`: ${message}`)),
        result.stderr.join("\n"),
      );
      assert.deepEqual(fileState(env.dbPath), before);
    });
  }

  it("refuses an unknown custom variable in a condition expression, and in a condition's children", async () => {
    for (const [conditions, path] of [
      [
        '[{ condition: expression, expression: "$(custom:fx_nope) > 0" }]',
        "conditions[0].expression",
      ],
      [
        '[{ condition: passthrough, connection: internal, definition: logic_and, children: { feedbacks: [{ feedback: expression, expression: "$(custom:fx_nope)" }] } }]',
        "conditions[0].children.feedbacks[0].expression",
      ],
    ] as const) {
      const env = setup();
      const before = fileState(env.dbPath);
      const result = await applyTo(
        env,
        `kind: trigger\nname: T\nevents: [{ event: startup }]\nconditions: ${conditions}\n`,
      );
      assert.equal(result.code, 1);
      assert.match(
        result.stderr.join("\n"),
        new RegExp(`${path.replace(/[[\].]/g, "\\$&")}: .*fx_nope`),
      );
      assert.deepEqual(fileState(env.dbPath), before);
    }
  });

  it("refuses a condition event on a trigger without conditions", async () => {
    const env = setup();
    const result = await applyTo(
      env,
      "kind: trigger\nname: T\nevents:\n  - { event: startup }\n  - { event: condition_false }\n",
    );
    assert.equal(result.code, 1);
    assert.match(
      result.stderr.join("\n"),
      /: events\[1\]\.event: condition_false needs at least one condition: without conditions it never fires$/m,
    );
  });
});

describe("trigger conditions and notes: export", () => {
  it("exports notes, conditions and condition events, round-tripping", async () => {
    const env = setup();
    const applied = await applyTo(env, TRIGGER);
    assert.equal(applied.code, 0, applied.stderr.join("\n"));
    const yaml = await exportRoundTrip(env, ["trigger", "Guarded"]);
    assert.equal(
      yaml,
      `${SCHEMA_MODELINE}
# companion-cli export: trigger (1)
kind: trigger
name: Guarded
enabled: true
notes: "First line\\nSecond line\\n"
events:
  - event: interval
    seconds: 5
  - event: condition_true
  - event: condition_false
    enabled: false
conditions:
  - condition: expression
    expression: $(custom:fx_counter) > 2
    invert: true
  - condition: passthrough
    connection: FixtureConnectionAAAA
    definition: tally
    options:
      bus: program
    headline: On air
actions:
  - action: increment
    variable: fx_counter
`,
    );
    const { kind: _kind, ...single } = parse(yaml) as Json;
    const many = parse(await exportRoundTrip(env, ["triggers"])) as Json;
    assert.deepEqual((many["triggers"] as Json[])[0], single);
  });

  it("round-trips one condition, an expression invert, and notes without a final newline", async () => {
    const env = setup();
    const applied = await applyTo(
      env,
      `kind: triggers
triggers:
  - name: One
    notes: "single line, no newline"
    events: [{ event: startup }]
    conditions:
      - condition: passthrough
        connection: internal
        definition: logic_and
        invert: { expr: "$(custom:fx_label) == 'on'" }
        disabled: true
        upgradeIndex: 3
        children:
          feedbacks:
            - { feedback: expression, expression: "$(custom:fx_counter) > 0" }
`,
    );
    assert.equal(applied.code, 0, applied.stderr.join("\n"));
    const body = (
      (parse(await exportRoundTrip(env, ["triggers", "One"])) as Json)[
        "triggers"
      ] as Json[]
    )[0] as Json;
    assert.equal(body["notes"], "single line, no newline");
    assert.deepEqual(body["conditions"], [
      {
        condition: "passthrough",
        connection: "internal",
        definition: "logic_and",
        invert: { expr: "$(custom:fx_label) == 'on'" },
        disabled: true,
        upgradeIndex: 3,
        children: {
          feedbacks: [
            { feedback: "expression", expression: "$(custom:fx_counter) > 0" },
          ],
        },
      },
    ]);
  });

  /** A trigger with conditions as Companion 5.1 stores one made in its UI. */
  const companionShaped = {
    type: "trigger",
    options: {
      name: "From the UI",
      enabled: true,
      sortOrder: 0,
      notes: "Made in Companion",
    },
    actions: [],
    condition: [
      {
        type: "feedback",
        id: "UiConditionAAAAAAAAAA",
        definitionId: "check_expression",
        connectionId: "internal",
        options: { expression: prop("$(custom:fx_counter) > 1", true) },
        upgradeIndex: -1,
        isInverted: prop(false),
        styleOverrides: [],
        children: {},
      },
      {
        type: "feedback",
        id: "UiConditionBBBBBBBBBB",
        definitionId: "bank_current_step",
        connectionId: "internal",
        options: {
          step: prop(1),
          location: prop("$(this:location)"),
        },
        isInverted: prop(true),
        styleOverrides: [],
        children: {},
      },
    ],
    events: [
      {
        id: "UiEventAAAAAAAAAAAAAA",
        type: "condition_true",
        enabled: true,
        options: {},
      },
    ],
    localVariables: [],
  };

  it("round-trips a Companion-shaped trigger with conditions, a stored step condition as pass-through", async () => {
    const env = setup({}, (db) =>
      insert(db, "controls", "trigger:UiTriggerAAAAAAAAAAAA", companionShaped),
    );
    const body = parse(
      await exportRoundTrip(env, ["trigger", "From the UI"]),
    ) as Json;
    assert.equal(body["notes"], "Made in Companion");
    assert.deepEqual(body["conditions"], [
      {
        condition: "expression",
        expression: "$(custom:fx_counter) > 1",
        upgradeIndex: -1,
      },
      {
        condition: "passthrough",
        connection: "internal",
        definition: "bank_current_step",
        options: { step: 1, location: "$(this:location)" },
        invert: true,
      },
    ]);
    const { kind: _kind, ...single } = body;
    const many = parse(
      await exportRoundTrip(env, ["triggers", "From the UI"]),
    ) as Json;
    assert.deepEqual(many["triggers"], [single]);
  });

  it("lists the trigger with +cond and finds its condition option values", async () => {
    const env = setup();
    const applied = await applyTo(env, TRIGGER);
    assert.equal(applied.code, 0, applied.stderr.join("\n"));
    const list = await runCli(["list", "triggers", "--db", env.dbPath], {
      tmpdir: env.tmpdir,
    });
    assert.equal(list.code, 0, list.stderr.join("\n"));
    assert.ok(
      list.stdout.some(
        (line) => line.startsWith("Guarded") && line.includes("1 +cond"),
      ),
      list.stdout.join("\n"),
    );
    const found = await runCli(["find", "program", "--db", env.dbPath], {
      tmpdir: env.tmpdir,
    });
    assert.equal(found.code, 0, found.stderr.join("\n"));
    assert.match(
      found.stdout.join("\n"),
      /trigger "Guarded" .* conditions\[1\]\.options\.bus/,
    );
  });

  it("refuses a condition with style overrides or a variableName, naming the stored path", async () => {
    for (const [extra, path] of [
      [
        {
          styleOverrides: [
            {
              overrideId: "UiOverrideAAAAAAAAAAA",
              elementId: "text0",
              elementProperty: "text",
              override: prop("x"),
            },
          ],
        },
        "condition[0].styleOverrides",
      ],
      [{ variableName: "v" }, "condition[0].variableName"],
    ] as const) {
      const env = setup({}, (db) =>
        insert(db, "controls", "trigger:UiTriggerAAAAAAAAAAAA", {
          ...companionShaped,
          condition: [
            { ...(companionShaped.condition[0] as object), ...extra },
          ],
        }),
      );
      const error = await assertRefused(
        env,
        ["trigger", "From the UI"],
        `cannot export trigger "From the UI" (trigger:UiTriggerAAAAAAAAAAAA): ${path} is set, which a trigger condition cannot carry (see docs/support-matrix.md, condition)`,
        path,
        "see docs/support-matrix.md (condition)",
      );
      assert.equal(error.code, "export_unsupported");
    }
  });
});
