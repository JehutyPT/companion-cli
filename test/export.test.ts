/**
 * `export variables`, `export trigger`, `export triggers` and
 * `export connection` (ADR 0006).
 * The oracle is the round trip: every exported file, YAML and JSON, applied
 * to its own database reports no changes in a dry run, and a real apply to a
 * copy leaves the copy equal to the original but for generated ids.
 */
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { parse, parseDocument } from "yaml";
import { USAGE } from "../src/cli.ts";
import { SCHEMA_MODELINE } from "../src/schema.ts";
import {
  assertRefused,
  exportFrom,
  exportRoundTrip,
  insert,
  mutate,
  ok,
} from "./export-helpers.ts";
import {
  applyTo,
  dumpDatabase,
  type FixtureEnv,
  type Json,
  rows,
  runCli,
  setup,
  writeDescription,
} from "./helpers.ts";

describe("export variables", () => {
  it("exports the fixture's three, with the persisted value and the sortOrder gap", async () => {
    const env = setup();
    const yaml = await exportRoundTrip(env, ["variables"]);
    assert.equal(
      yaml,
      `${SCHEMA_MODELINE}
# companion-cli export: variables (3)
kind: variables
variables:
  - name: fx_counter
    default: 0
    description: Counter
    persist: false
  - name: fx_label
    default: idle
    description: Label
    persist: true
  - name: fx_gap
    default: ""
    description: A custom variable
    persist: false
`,
    );
  });

  it("exports strings that look like other values, booleans and odd descriptions", async () => {
    const env = setup({}, (db) => {
      const variable = (
        defaultValue: unknown,
        sortOrder: number,
        description = "d",
      ) => ({
        description,
        defaultValue,
        persistCurrentValue: false,
        sortOrder,
      });
      insert(db, "custom_variables", "s_zero", variable("0", 10));
      insert(db, "custom_variables", "n_zero", variable(0, 11));
      insert(db, "custom_variables", "b_true", variable(true, 12));
      insert(db, "custom_variables", "b_false", variable(false, 13));
      insert(db, "custom_variables", "s_empty", variable("", 14));
      insert(db, "custom_variables", "s_null", variable("null", 15));
      insert(
        db,
        "custom_variables",
        "s_hash",
        variable("a: b # c", 16, "has # and\na newline"),
      );
    });
    const yaml = await exportRoundTrip(env, [
      "variables",
      "s_*",
      "?_zero",
      "b_*",
    ]);
    assert.ok(
      yaml.startsWith(
        `${SCHEMA_MODELINE}\n# companion-cli export: variables (7)\n`,
      ),
    );
    assert.match(yaml, /name: s_zero\n {4}default: "0"\n/);
    assert.match(yaml, /name: n_zero\n {4}default: 0\n/);
    assert.match(yaml, /default: "null"/);
    assert.match(yaml, /description: "has # and\\na newline"/);
  });

  it("exports a pattern subset in sortOrder, not argument order", async () => {
    const env = setup();
    const yaml = await exportRoundTrip(env, ["variables", "fx_label", "fx_c*"]);
    assert.deepEqual(
      [...yaml.matchAll(/name: (\w+)/g)].map((match) => match[1]),
      ["fx_counter", "fx_label"],
    );
  });

  it("refuses an exact name that matches nothing, unmatched globs and no variables", async () => {
    const env = setup();
    await assertRefused(
      env,
      ["variables", "fx_*", "nope"],
      'no custom variable named "nope"',
      undefined as unknown as string,
    );
    await assertRefused(
      env,
      ["variables", "zz*"],
      'no custom variables match "zz*"',
      undefined as unknown as string,
    );
    const empty = setup({}, (db) => db.exec("DELETE FROM custom_variables"));
    const error = await assertRefused(
      empty,
      ["variables"],
      "no custom variables to export",
      undefined as unknown as string,
    );
    assert.equal(error.code, "not_found");
  });

  const refusals: [string, (db: DatabaseSync) => void, string, string][] = [
    [
      "a null defaultValue",
      (db) =>
        mutate(db, "custom_variables", "fx_counter", (value) => ({
          ...value,
          defaultValue: null,
        })),
      'cannot export custom variable "fx_counter": defaultValue is null; only a string, number or boolean can be exported (see docs/support-matrix.md, custom variable)',
      "defaultValue",
    ],
    [
      "an object defaultValue",
      (db) =>
        mutate(db, "custom_variables", "fx_counter", (value) => ({
          ...value,
          defaultValue: { a: 1 },
        })),
      'cannot export custom variable "fx_counter": defaultValue is a mapping; only a string, number or boolean can be exported (see docs/support-matrix.md, custom variable)',
      "defaultValue",
    ],
    [
      "a name the variable rule refuses",
      (db) =>
        insert(db, "custom_variables", "bad-name", {
          description: "",
          defaultValue: "",
          persistCurrentValue: false,
          sortOrder: 9,
        }),
      'cannot export custom variable "bad-name": id cannot be expressed: invalid variable name "bad-name": use only letters A-Z/a-z, digits and _ (Companion\'s rule for $(custom:<name>)) (see docs/support-matrix.md, custom variable)',
      "id",
    ],
    [
      "a row that is not an object",
      (db) => insert(db, "custom_variables", "not_object", "[1]"),
      'cannot export custom variable "not_object": value is a list, not a JSON object (see docs/support-matrix.md, custom variable)',
      "value",
    ],
    [
      "an extra key",
      (db) =>
        mutate(db, "custom_variables", "fx_counter", (value) => ({
          ...value,
          collectionId: "c1",
        })),
      'cannot export custom variable "fx_counter": collectionId is set, which the description format does not support yet (see docs/support-matrix.md, custom variable)',
      "collectionId",
    ],
    [
      "a missing sortOrder",
      (db) =>
        mutate(db, "custom_variables", "fx_counter", (value) => {
          const { sortOrder: _sortOrder, ...rest } = value;
          return rest;
        }),
      'cannot export custom variable "fx_counter": sortOrder is missing, not an integer (see docs/support-matrix.md, custom variable)',
      "sortOrder",
    ],
    [
      "a non-integer sortOrder",
      (db) =>
        mutate(db, "custom_variables", "fx_counter", (value) => ({
          ...value,
          sortOrder: 1.5,
        })),
      'cannot export custom variable "fx_counter": sortOrder is 1.5, not an integer (see docs/support-matrix.md, custom variable)',
      "sortOrder",
    ],
    [
      "a list defaultValue",
      (db) =>
        mutate(db, "custom_variables", "fx_counter", (value) => ({
          ...value,
          defaultValue: [1],
        })),
      'cannot export custom variable "fx_counter": defaultValue is a list; only a string, number or boolean can be exported (see docs/support-matrix.md, custom variable)',
      "defaultValue",
    ],
  ];
  for (const [label, change, line, path] of refusals) {
    it(`refuses ${label}`, async () => {
      const env = setup({}, change);
      const error = await assertRefused(
        env,
        ["variables"],
        line,
        path,
        "see docs/support-matrix.md (custom variable)",
      );
      assert.equal(error.code, "export_unsupported");
    });
  }
});

const TRIGGERS_YAML = `kind: triggers
triggers:
  - name: Startup set
    events:
      - { event: startup, delay: 0 }
      - { event: startup }
    actions:
      - { action: set, variable: fx_label, value: "0" }
      - { action: expression, variable: fx_counter, expression: "$(custom:fx_counter) * 2" }
  - name: Interval step
    enabled: false
    events: [ { event: interval, seconds: 5 } ]
    actions:
      - { action: increment, variable: fx_counter, by: 3 }
      - { action: decrement, variable: fx_counter }
  - name: 'Var "quoted" # hash'
    events: [ { event: variable_changed, variable: fx_counter } ]
    actions:
      - action: passthrough
        connection: internal
        definition: button_pressrelease
        options: { page: 1, bank: 2 }
      - action: passthrough
        connection: FixtureConnectionAAAA
        definition: send_message
        options:
          path: "/a: b"
          args: [ { type: i, value: 1 }, { type: s, value: "true" } ]
          nested: { deep: { flag: true, none: null } }
      - { action: passthrough, connection: FixtureConnectionAAAA, definition: no_options }
  - name: In a collection
    events: [ { event: interval, seconds: 60 } ]
`;

const COLLECTED = "In a collection";

/** The fixture with the four triggers above, one moved into a collection. */
async function triggerFixture(): Promise<FixtureEnv> {
  const env = setup();
  const result = await applyTo(env, TRIGGERS_YAML);
  assert.equal(result.code, 0, result.stderr.join("\n"));
  const db = await import("node:sqlite").then(
    ({ DatabaseSync }) => new DatabaseSync(env.dbPath),
  );
  try {
    mutate(db, "controls", triggerId(env, COLLECTED), (value) => ({
      ...value,
      options: { ...(value["options"] as Json), collectionId: "coll1" },
    }));
  } finally {
    db.close();
  }
  return env;
}

function triggerId(env: FixtureEnv, name: string): string {
  const found = [...rows(dumpDatabase(env.dbPath), "controls")].find(
    ([id, value]) =>
      id.startsWith("trigger:") &&
      (value["options"] as Json | undefined)?.["name"] === name,
  );
  assert.ok(found, name);
  return found[0];
}

/** The trigger fixture with `change` applied to the named trigger's control. */
async function changedTrigger(
  name: string,
  change: (value: Json) => unknown,
): Promise<{ env: FixtureEnv; id: string }> {
  const env = await triggerFixture();
  const id = triggerId(env, name);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(env.dbPath);
  try {
    mutate(db, "controls", id, change);
  } finally {
    db.close();
  }
  return { env, id };
}

describe("export triggers", () => {
  it("exports every trigger as one kind: triggers file that round-trips", async () => {
    const env = await triggerFixture();
    const yaml = await exportRoundTrip(env, ["triggers"]);
    assert.equal(
      yaml,
      `${SCHEMA_MODELINE}
# companion-cli export: triggers (4)
kind: triggers
triggers:
  - name: Startup set
    enabled: true
    events:
      - event: startup
        delay: 0
      - event: startup
        delay: 10000
    actions:
      - action: set
        variable: fx_label
        value: "0"
      - action: expression
        variable: fx_counter
        expression: $(custom:fx_counter) * 2
  - name: Interval step
    enabled: false
    events:
      - event: interval
        seconds: 5
    actions:
      - action: increment
        variable: fx_counter
        by: 3
      - action: decrement
        variable: fx_counter
  - name: "Var \\"quoted\\" # hash"
    enabled: true
    events:
      - event: variable_changed
        variable: fx_counter
    actions:
      - action: passthrough
        connection: internal
        definition: button_pressrelease
        options:
          page: 1
          bank: 2
      - action: passthrough
        connection: FixtureConnectionAAAA
        definition: send_message
        options:
          path: "/a: b"
          args:
            - type: i
              value: 1
            - type: s
              value: "true"
          nested:
            deep:
              flag: true
              none: null
      - action: passthrough
        connection: FixtureConnectionAAAA
        definition: no_options
  - name: In a collection
    enabled: true
    events:
      - event: interval
        seconds: 60
`,
    );
  });

  it("exports a pattern subset in sortOrder", async () => {
    const env = await triggerFixture();
    const yaml = await exportRoundTrip(env, [
      "triggers",
      "In a*",
      "Startup set",
    ]);
    assert.deepEqual(
      [...yaml.matchAll(/^ {2}- name: (.*)$/gm)].map((match) => match[1]),
      ["Startup set", "In a collection"],
    );
  });

  it("exports each trigger singly as kind: trigger", async () => {
    const env = await triggerFixture();
    for (const name of [
      "Startup set",
      "Interval step",
      'Var "quoted" # hash',
      COLLECTED,
    ]) {
      const yaml = await exportRoundTrip(env, ["trigger", name]);
      assert.match(
        yaml,
        /^# yaml-language-server: \$schema=\S+\n# companion-cli export: trigger \(1\)\nkind: trigger\n/,
      );
    }
  });

  it("refuses an unknown trigger, no triggers and no match", async () => {
    const env = await triggerFixture();
    for (const [args, line] of [
      [["trigger", "Nope"], 'no trigger named "Nope"'],
      [["triggers", "Nope*"], 'no triggers match "Nope*"'],
      [["triggers", "Nope"], 'no trigger named "Nope"'],
    ] as const) {
      const error = await assertRefused(
        env,
        [...args],
        line,
        undefined as unknown as string,
      );
      assert.equal(error.code, "not_found");
    }
    const error = await assertRefused(
      setup(),
      ["triggers"],
      "no triggers to export",
      undefined as unknown as string,
    );
    assert.equal(error.code, "not_found");
  });

  it("refuses a name two triggers share, listing their ids", async () => {
    const { env, id } = await changedTrigger(COLLECTED, (value) => ({
      ...value,
      options: { ...(value["options"] as Json), name: "Startup set" },
    }));
    const other = triggerId(env, "Interval step");
    assert.ok(other);
    const first = [id, "x"].length > 0;
    assert.ok(first);
    const text = await exportFrom(env, ["trigger", "Startup set"]);
    assert.equal(text.code, 1);
    assert.deepEqual(text.stdout, []);
    assert.match(
      text.stderr[0] ?? "",
      /^error: 2 triggers with the same name "Startup set" \(trigger:.+, trigger:.+\); apply would refuse to choose one$/,
    );
    assert.ok(text.stderr[0]?.includes(id));

    const many = await exportFrom(env, ["triggers"]);
    assert.equal(many.code, 1);
    assert.deepEqual(many.stdout, []);
    assert.match(
      many.stderr[0] ?? "",
      /^error: 2 triggers cannot be exported: "Startup set" \(options\.name\); "Startup set" \(options\.name\)$/,
    );
  });

  const refusals: [string, string, (value: Json) => unknown, string, string][] =
    [
      [
        "notes that are not a string",
        COLLECTED,
        (value) => ({
          ...value,
          options: { ...(value["options"] as Json), notes: 5 },
        }),
        "options.notes cannot be expressed: must be a string, got a number",
        "trigger option",
      ],
      [
        "a condition without options",
        COLLECTED,
        (value) => ({ ...value, condition: [{ type: "feedback" }] }),
        "condition[0].options is missing, not a mapping",
        "condition",
      ],
      [
        "a local variable without a name",
        COLLECTED,
        (value) => ({ ...value, localVariables: [{ type: "feedback" }] }),
        "localVariables[0].variableName is missing, not a local variable name (letters A-Z/a-z, digits, _, - and .)",
        "local variable",
      ],
      [
        "another event type",
        COLLECTED,
        (value) => ({
          ...value,
          events: [
            {
              id: "SeedEventAAAAAAAAAAAA",
              type: "condition_maybe",
              enabled: true,
              options: {},
            },
          ],
        }),
        'events[0].type is "condition_maybe", which the description format does not support yet',
        "event",
      ],
      [
        "an event option of the wrong type",
        COLLECTED,
        (value) => ({
          ...value,
          events: (value["events"] as Json[]).map((event) => ({
            ...event,
            options: { seconds: "60" },
          })),
        }),
        "events[0].options.seconds is a string, not an integer of at least 1",
        "event",
      ],
      [
        "an extra event option",
        COLLECTED,
        (value) => ({
          ...value,
          events: (value["events"] as Json[]).map((event) => ({
            ...event,
            options: { seconds: 60, jitter: 1 },
          })),
        }),
        "events[0].options.jitter is set, which the description format does not support yet",
        "event",
      ],
      [
        "a key the writer does not write",
        "Interval step",
        (value) => ({
          ...value,
          actions: (value["actions"] as Json[]).map((action) => ({
            ...action,
            foo: true,
          })),
        }),
        "actions[0].foo is set, which the description format does not support yet",
        "action",
      ],
    ];
  it("round-trips trigger actions with expression options, disabled, headline, upgradeIndex, children and a store (#23)", async () => {
    const { env } = await changedTrigger('Var "quoted" # hash', (value) => ({
      ...value,
      actions: [
        ...(value["actions"] as Json[]).map((action) => ({
          ...action,
          disabled: true,
          headline: "Kept",
          upgradeIndex: 2,
        })),
        {
          type: "action",
          id: "TriggerActionModule01",
          definitionId: "some_action",
          connectionId: "FixtureConnectionAAAA",
          options: {
            path: { value: "$(custom:fx_label)", isExpression: true },
          },
          storeResult: {
            type: "page-variable",
            page: { value: "1", isExpression: false },
            variableName: { value: "result", isExpression: false },
          },
        },
        {
          type: "action",
          id: "TriggerActionLogicIf1",
          definitionId: "logic_if",
          connectionId: "internal",
          options: {},
          children: {
            condition: [],
            actions: [
              {
                type: "action",
                id: "TriggerActionLogicIf2",
                definitionId: "logic_if",
                connectionId: "internal",
                options: {},
                children: {
                  condition: [
                    {
                      type: "feedback",
                      id: "TriggerFeedbackDepth2",
                      definitionId: "tally",
                      connectionId: "FixtureConnectionAAAA",
                      options: {},
                      isInverted: {
                        value: "$(custom:fx_counter) > 0",
                        isExpression: true,
                      },
                      styleOverrides: [
                        {
                          overrideId: "TriggerOverrideDepth2",
                          elementId: "text0",
                          elementProperty: "size",
                          override: { value: 12, isExpression: false },
                        },
                      ],
                      variableName: "tally_value",
                    },
                  ],
                  actions: [
                    {
                      type: "action",
                      id: "TriggerActionModule02",
                      definitionId: "some_action",
                      connectionId: "FixtureConnectionAAAA",
                      options: {},
                      storeResult: {
                        type: "custom-variable",
                        variableName: {
                          value: "fx_label",
                          isExpression: false,
                        },
                        createIfNotExists: false,
                      },
                    },
                  ],
                  else_actions: [],
                },
              },
            ],
            else_actions: [
              {
                type: "action",
                id: "TriggerActionModule03",
                definitionId: "some_action",
                connectionId: "FixtureConnectionAAAA",
                options: {},
                storeResult: {
                  type: "local-variable",
                  location: { value: "$(this:location)", isExpression: false },
                  variableName: { value: "result", isExpression: false },
                },
              },
            ],
          },
        },
      ],
    }));
    const yaml = await exportRoundTrip(env, ["trigger", 'Var "quoted" # hash']);
    const actions = (parse(yaml) as Json)["actions"] as Json[];
    assert.equal((actions[0] as Json)["disabled"], true);
    assert.deepEqual((actions.at(-2) as Json)["options"], {
      path: { expr: "$(custom:fx_label)" },
    });
    const children = (actions.at(-1) as Json)["children"] as Json;
    const depth2 = ((children["actions"] as Json[])[0] as Json)[
      "children"
    ] as Json;
    assert.deepEqual((depth2["condition"] as Json[])[0], {
      feedback: "passthrough",
      connection: "FixtureConnectionAAAA",
      definition: "tally",
      invert: { expr: "$(custom:fx_counter) > 0" },
      style: [{ element: "text0", property: "size", value: 12 }],
      variableName: "tally_value",
    });
    assert.deepEqual(((depth2["actions"] as Json[])[0] as Json)["store"], {
      type: "custom",
      variable: "fx_label",
    });
    assert.deepEqual(
      ((children["else_actions"] as Json[])[0] as Json)["store"],
      { type: "local", variable: "result", location: "$(this:location)" },
    );
  });

  it("exports trigger actions and conditions stored without children (pre-#23) like children: {} (#44)", async () => {
    const name = "Startup set";
    const strip = (list: unknown) =>
      (list as Json[] | undefined)?.map(({ children: _, ...entity }) => entity);
    const canonical = await triggerFixture();
    const { env } = await changedTrigger(name, (value) => ({
      ...value,
      actions: strip(value["actions"]),
      condition: strip(value["condition"]),
    }));
    const stored = JSON.stringify(
      rows(dumpDatabase(env.dbPath), "controls").get(triggerId(env, name)),
    );
    assert.ok(stored.includes('"connectionId":"internal"'));
    assert.equal(stored.includes('"children"'), false);
    const args = ["trigger", name];
    const yaml = ok(await exportFrom(env, args));
    assert.equal(yaml, ok(await exportFrom(canonical, args)));
    const dry = await runCli(
      [
        "apply",
        writeDescription(env.dir, yaml, "export.yaml"),
        "--db",
        env.dbPath,
        "--dry-run",
      ],
      { tmpdir: env.tmpdir },
    );
    assert.equal(dry.code, 0, dry.stderr.join("\n"));
    assert.equal(dry.stdout[1], "no changes", dry.stdout.join("\n"));
  });

  it("names a refused key's stored path inside a trigger action's children", async () => {
    const { env } = await changedTrigger('Var "quoted" # hash', (value) => ({
      ...value,
      actions: [
        {
          type: "action",
          id: "TriggerActionLogicIf1",
          definitionId: "logic_if",
          connectionId: "internal",
          options: {},
          children: {
            else_actions: [
              {
                type: "action",
                id: "TriggerActionModule01",
                definitionId: "d",
                connectionId: "FixtureConnectionAAAA",
                options: {},
                children: {},
              },
            ],
          },
        },
      ],
    }));
    const json = await exportFrom(env, [
      "trigger",
      'Var "quoted" # hash',
      "--json",
    ]);
    assert.equal(json.code, 1);
    const { error } = JSON.parse(json.stdout[0] as string);
    assert.equal(error.path, "actions[0].children.else_actions[0].children");
  });
  for (const [label, name, change, reason, area] of refusals) {
    it(`refuses ${label}`, async () => {
      const { env, id } = await changedTrigger(name, change);
      const line = `cannot export trigger ${JSON.stringify(name)} (${id}): ${reason} (see docs/support-matrix.md, ${area})`;
      const path = reason.split(" ")[0] as string;
      const hint = `see docs/support-matrix.md (${area})`;
      const error = await assertRefused(
        env,
        ["trigger", name],
        line,
        path,
        hint,
      );
      assert.equal(error.code, "export_unsupported");
      assert.equal(error.items, undefined);
    });
  }

  it("refuses missing options, read as Companion's default name", async () => {
    const { env, id } = await changedTrigger(COLLECTED, (value) => {
      const { options: _options, ...rest } = value;
      return rest;
    });
    const error = await assertRefused(
      env,
      ["trigger", "New Trigger"],
      `cannot export trigger "New Trigger" (${id}): options is missing; a trigger without options takes Companion's defaults, which apply would store explicitly (see docs/support-matrix.md, trigger option)`,
      "options",
      "see docs/support-matrix.md (trigger option)",
    );
    assert.equal(error.code, "export_unsupported");
  });

  it("refuses an event on a variable that no longer exists, as apply would", async () => {
    const env = await triggerFixture();
    const id = triggerId(env, 'Var "quoted" # hash');
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(env.dbPath);
    db.prepare("DELETE FROM custom_variables WHERE id = 'fx_counter'").run();
    db.close();
    const text = await exportFrom(env, ["trigger", 'Var "quoted" # hash']);
    assert.equal(text.code, 1);
    assert.deepEqual(text.stdout, []);
    assert.deepEqual(text.stderr, [
      `error: cannot export trigger "Var \\"quoted\\" # hash" (${id}): events[0].options.variableId fails apply's check: unknown custom variable "fx_counter"`,
    ]);
  });

  it("export triggers names every refused trigger and prints no file", async () => {
    const env = await triggerFixture();
    const startup = triggerId(env, "Startup set");
    const collected = triggerId(env, COLLECTED);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(env.dbPath);
    mutate(db, "controls", startup, (value) => ({
      ...value,
      condition: [{ type: "feedback" }],
    }));
    mutate(db, "controls", collected, (value) => ({
      ...value,
      options: { ...(value["options"] as Json), notes: 5 },
    }));
    db.close();
    const line =
      '2 triggers cannot be exported: "Startup set" (condition[0].options); "In a collection" (options.notes)';
    const text = await exportFrom(env, ["triggers"]);
    assert.equal(text.code, 1);
    assert.deepEqual(text.stdout, []);
    assert.deepEqual(text.stderr, [`error: ${line}`]);
    const json = await exportFrom(env, ["triggers", "--json"]);
    assert.equal(json.code, 1);
    const { error } = JSON.parse(json.stdout[0] as string);
    assert.deepEqual(error, {
      code: "export_unsupported",
      message: line,
      path: "condition[0].options",
      hint: "see docs/support-matrix.md (condition)",
      items: [
        {
          message: `cannot export trigger "Startup set" (${startup}): condition[0].options is missing, not a mapping (see docs/support-matrix.md, condition)`,
          path: "condition[0].options",
        },
        {
          message: `cannot export trigger "In a collection" (${collected}): options.notes cannot be expressed: must be a string, got a number (see docs/support-matrix.md, trigger option)`,
          path: "options.notes",
        },
      ],
    });
  });
});

describe("export connection", () => {
  const SECRET = "SEEDED-SECRET-VALUE-0d9b";
  const CAM = "ConnCamAAAAAAAAAAAAAA";
  const connection = (label: string, extra: Json = {}): Json => ({
    moduleInstanceType: "connection",
    moduleId: `${label}-module`,
    moduleVersionId: "1.2.0",
    label,
    config: {},
    isFirstInit: false,
    lastUpgradeIndex: 0,
    enabled: true,
    sortOrder: 1,
    updatePolicy: "stable",
    ...extra,
  });
  const insertRow = (db: DatabaseSync, id: string, value: Json) =>
    db
      .prepare("INSERT INTO instances (id, value) VALUES (?, ?)")
      .run(id, JSON.stringify(value));

  it("exports the fixture connection", async () => {
    const env = setup();
    const yaml = await exportRoundTrip(env, ["connection", "fixture"]);
    assert.equal(
      yaml,
      `${SCHEMA_MODELINE}\n# companion-cli export: connection (1)\nkind: connection\nconnection: fixture\nenabled: false\nconfig: {}\n`,
    );
  });

  it("exports nested config and names secrets only by key", async () => {
    const env = setup({}, (db) =>
      insertRow(
        db,
        CAM,
        connection("cam", {
          config: {
            host: "10.0.0.1",
            port: 9910,
            nested: { list: [1, { deep: null }], on: true },
          },
          secrets: { password: SECRET, token: SECRET },
          collectionId: "abc",
        }),
      ),
    );
    const yaml = await exportRoundTrip(env, ["connection", "cam"]);
    assert.ok(!yaml.includes(SECRET));
    assert.deepEqual(yaml.split("\n").slice(1, 3), [
      "# companion-cli export: connection (1)",
      "# secrets not exported: password, token (set each as secrets: {<key>: {env: NAME}})",
    ]);
    const json = ok(await exportFrom(env, ["connection", "cam", "--json"]));
    assert.ok(!json.includes(SECRET) && !json.includes("password"));
    assert.deepEqual(JSON.parse(json), {
      kind: "connection",
      connection: "cam",
      enabled: true,
      config: {
        host: "10.0.0.1",
        port: 9910,
        nested: { list: [1, { deep: null }], on: true },
      },
    });
  });

  it("names a connection that shares its label by id", async () => {
    const env = setup({}, (db) => insertRow(db, CAM, connection("fixture")));
    const yaml = await exportRoundTrip(env, ["connection", `id:${CAM}`]);
    assert.match(yaml, new RegExp(`^connection: id:${CAM}$`, "m"));
    await assertRefused(
      env,
      ["connection", "fixture"],
      `connection: 2 connections are labelled "fixture" (FixtureConnectionAAAA, ${CAM}); name one as id:<id>`,
      "connection",
      "run companion-cli list connections",
    );
  });

  it("refuses a connection never configured", async () => {
    const env = setup({}, (db) =>
      insertRow(db, CAM, connection("cam", { isFirstInit: true })),
    );
    const error = await assertRefused(
      env,
      ["connection", "cam"],
      `cannot export connection "cam" (${CAM}): isFirstInit is true: the connection has never been configured, and apply would set it to false (see docs/support-matrix.md, connection)`,
      "isFirstInit",
      "see docs/support-matrix.md (connection)",
    );
    assert.equal(error.code, "export_unsupported");
  });

  it("refuses a surface instance and an unknown connection", async () => {
    const env = setup({}, (db) =>
      insertRow(db, "SurfaceInstanceAAAAAA", {
        ...connection("surf"),
        moduleInstanceType: "surface",
      }),
    );
    await assertRefused(
      env,
      ["connection", "surf"],
      'connection: no connection labelled "surf"',
      "connection",
      "run companion-cli list connections",
    );
  });
});

/** One trigger with every supported event kind, some disabled (#27). */
const EVERY_EVENT_YAML = `kind: trigger
name: Every event
events:
  - { event: startup, delay: 0, enabled: false }
  - { event: interval, seconds: 5 }
  - { event: intervalRandom, min: 2, max: 9 }
  - { event: timeofday, time: "08:30:00", days: [mon, tue, wed, thu, fri] }
  - { event: specificDate, date: "2026-12-31", time: "23:00" }
  - { event: sun_event, sun: sunset, latitude: 38.72, longitude: -9.14, offset: 10 }
  - { event: client_connect }
  - { event: button_press }
  - { event: button_release, enabled: false }
  - { event: variable_changed, variable: fx_counter }
  - { event: variable_changed, variableId: "internal:time_hms" }
  - { event: variable_changed, variableId: "local:counter", enabled: false }
  - { event: computer_locked }
  - { event: computer_unlocked }
localVariables:
  - { name: counter, value: 0 }
`;

/**
 * A trigger as Companion 5.1's UI stores one: `createEventItem`'s key order
 * (`id, type, enabled, options`), options in event-definition order, and
 * nanoid ids. One per event type, so each round-trips on its own.
 */
function companionTrigger(name: string, sortOrder: number, event: Json): Json {
  return {
    type: "trigger",
    options: { name, enabled: true, sortOrder, notes: "" },
    actions: [],
    condition: [],
    events: [{ id: `SeedEvent${name.padEnd(12, "x")}`, ...event }],
    localVariables: [],
  };
}

const COMPANION_EVENTS: Array<[string, Json]> = [
  [
    "Random",
    {
      type: "intervalRandom",
      enabled: true,
      options: { minimum: 3, maximum: 10 },
    },
  ],
  [
    "Weekends",
    {
      type: "timeofday",
      enabled: true,
      options: { time: "07:00:00", days: [0, 6] },
    },
  ],
  [
    "Once",
    {
      type: "specificDate",
      enabled: false,
      options: { date: "2027-01-02", time: "10:20:30" },
    },
  ],
  [
    "Sunrise",
    {
      type: "sun_event",
      enabled: true,
      options: { type: "sunrise", latitude: 0, longitude: 0, offset: -15 },
    },
  ],
  ["Connect", { type: "client_connect", enabled: true, options: { delay: 0 } }],
  ["Press", { type: "button_press", enabled: true, options: {} }],
  ["Release", { type: "button_release", enabled: true, options: {} }],
  ["Locked", { type: "computer_locked", enabled: true, options: {} }],
  ["Unlocked", { type: "computer_unlocked", enabled: false, options: {} }],
  [
    "Watch",
    {
      type: "variable_changed",
      enabled: true,
      options: { variableId: "internal:time_hms" },
    },
  ],
];

/** The fixture with Companion-shaped triggers seeded directly. */
function companionTriggerFixture(): FixtureEnv {
  return setup({}, (db) =>
    COMPANION_EVENTS.forEach(([name, event], index) =>
      insert(
        db,
        "controls",
        `trigger:Seed${name.padEnd(17, "x")}`,
        companionTrigger(name, index, event),
      ),
    ),
  );
}

describe("export triggers: every event kind", () => {
  it("exports a trigger with every event kind, disabled ones included, and round-trips", async () => {
    const env = setup();
    const applied = await applyTo(env, EVERY_EVENT_YAML);
    assert.equal(applied.code, 0, applied.stderr.join("\n"));
    const yaml = await exportRoundTrip(env, ["trigger", "Every event"]);
    assert.equal(
      yaml,
      `${SCHEMA_MODELINE}
# companion-cli export: trigger (1)
kind: trigger
name: Every event
enabled: true
events:
  - event: startup
    delay: 0
    enabled: false
  - event: interval
    seconds: 5
  - event: intervalRandom
    min: 2
    max: 9
  - event: timeofday
    time: 08:30:00
    days:
      - mon
      - tue
      - wed
      - thu
      - fri
  - event: specificDate
    date: 2026-12-31
    time: 23:00
  - event: sun_event
    sun: sunset
    latitude: 38.72
    longitude: -9.14
    offset: 10
  - event: client_connect
    delay: 0
  - event: button_press
  - event: button_release
    enabled: false
  - event: variable_changed
    variable: fx_counter
  - event: variable_changed
    variableId: internal:time_hms
  - event: variable_changed
    variableId: local:counter
    enabled: false
  - event: computer_locked
  - event: computer_unlocked
localVariables:
  - name: counter
    value: 0
`,
    );
  });

  it("exports Companion-shaped triggers of every event type, each round-tripping", async () => {
    const env = companionTriggerFixture();
    const yaml = await exportRoundTrip(env, ["triggers"]);
    const events = (parseDocument(yaml).toJS() as Json)["triggers"] as Json[];
    assert.deepEqual(
      events.map((trigger) => (trigger["events"] as Json[])[0]),
      [
        { event: "intervalRandom", min: 3, max: 10 },
        { event: "timeofday", time: "07:00:00", days: ["sun", "sat"] },
        {
          event: "specificDate",
          date: "2027-01-02",
          time: "10:20:30",
          enabled: false,
        },
        {
          event: "sun_event",
          sun: "sunrise",
          latitude: 0,
          longitude: 0,
          offset: -15,
        },
        { event: "client_connect", delay: 0 },
        { event: "button_press" },
        { event: "button_release" },
        { event: "computer_locked" },
        { event: "computer_unlocked", enabled: false },
        { event: "variable_changed", variableId: "internal:time_hms" },
      ],
    );
    for (const [name] of COMPANION_EVENTS)
      await exportRoundTrip(env, ["trigger", name]);
  });

  const refusals: Array<[string, Json, string]> = [
    [
      "a condition event on a trigger without conditions",
      { type: "condition_true", enabled: true, options: {} },
      "events[0].type cannot be expressed: condition_true needs at least one condition: without conditions it never fires",
    ],
    [
      "a time of day Companion would never run",
      {
        type: "timeofday",
        enabled: true,
        options: { time: "08:00", days: [1] },
      },
      'events[0].options.time cannot be expressed: must be a time "HH:MM:SS", got "08:00"',
    ],
    [
      "a time of day without a time, as Companion creates one",
      { type: "timeofday", enabled: true, options: { days: [1] } },
      "events[0].options.time cannot be expressed: is required",
    ],
    [
      "a day number beyond Saturday",
      {
        type: "timeofday",
        enabled: true,
        options: { time: "08:00:00", days: [1, 7] },
      },
      "events[0].options.days[1] is 7, not a day number from 0 to 6",
    ],
    [
      "a time of day without days",
      { type: "timeofday", enabled: true, options: { time: "08:00:00" } },
      "events[0].options.days is missing, where apply would store it",
    ],
    [
      "a numeric date",
      {
        type: "specificDate",
        enabled: true,
        options: { date: 1798761600000, time: "10:00" },
      },
      "events[0].options.date cannot be expressed: must be a string, got a number",
    ],
    [
      "a random interval with maximum below minimum",
      {
        type: "intervalRandom",
        enabled: true,
        options: { minimum: 5, maximum: 2 },
      },
      "events[0].options.maximum cannot be expressed: must be at least min (5), got 2",
    ],
    [
      "an event enabled flag that is not a boolean",
      { type: "button_press", enabled: 1, options: {} },
      "events[0].enabled is a number, not true or false",
    ],
    [
      "a variableId without a label",
      { type: "variable_changed", enabled: true, options: { variableId: "x" } },
      'events[0].options.variableId cannot be expressed: must be "<label>:<name>", got "x"',
    ],
  ];
  for (const [label, event, reason] of refusals) {
    it(`refuses ${label}`, async () => {
      const id = "trigger:SeedRefusedxxxxxxxxxxxxx";
      const env = setup({}, (db) =>
        insert(db, "controls", id, companionTrigger("Refused", 0, event)),
      );
      const path = reason.split(" ")[0] as string;
      const error = await assertRefused(
        env,
        ["trigger", "Refused"],
        `cannot export trigger "Refused" (${id}): ${reason} (see docs/support-matrix.md, event)`,
        path,
        "see docs/support-matrix.md (event)",
      );
      assert.equal(error.code, "export_unsupported");
    });
  }
});

describe("export command line", () => {
  const cases: [string[], string][] = [
    [
      ["export"],
      "export needs a kind (variables or trigger or triggers or page or connection or surface)",
    ],
    [
      ["export", "pages"],
      'unknown export kind "pages" (expected variables or trigger or triggers or page or connection or surface)',
    ],
    [["export", "trigger"], "export trigger takes exactly one trigger name"],
    [
      ["export", "trigger", "a", "b"],
      "export trigger takes exactly one trigger name",
    ],
    [["export", "variables", ""], "a name pattern must not be empty"],
    [
      ["export", "connection"],
      "export connection takes exactly one connection: its label or id:<id>",
    ],
    [
      ["export", "connection", "a", "b"],
      "export connection takes exactly one connection: its label or id:<id>",
    ],
    [["export", "surface"], "export surface takes exactly one surface id"],
    [
      ["export", "surface", "a", "b"],
      "export surface takes exactly one surface id",
    ],
  ];
  for (const [args, reason] of cases) {
    it(`exits 2: ${args.join(" ")}`, async () => {
      const env = setup();
      const text = await runCli([...args, "--db", env.dbPath]);
      assert.equal(text.code, 2);
      assert.deepEqual(text.stdout, []);
      assert.deepEqual(text.stderr, [`error: ${reason}. ${USAGE}`]);
      const json = await runCli([...args, "--db", env.dbPath, "--json"]);
      assert.equal(json.code, 2);
      assert.equal(JSON.parse(json.stdout[0] as string).error.code, "usage");
    });
  }

  it("prints help", async () => {
    const result = await runCli(["export", "--help"]);
    assert.equal(result.code, 0);
    assert.match(
      result.stdout.join("\n"),
      /export triggers \[<pattern>\.\.\.\]/,
    );
  });
});
