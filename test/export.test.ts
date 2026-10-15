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
        "non-empty notes",
        COLLECTED,
        (value) => ({
          ...value,
          options: { ...(value["options"] as Json), notes: "hello" },
        }),
        'options.notes is "hello", which apply would store as ""',
        "trigger option",
      ],
      [
        "a condition",
        COLLECTED,
        (value) => ({ ...value, condition: [{ type: "feedback" }] }),
        "condition is set, which the description format does not support yet",
        "condition",
      ],
      [
        "local variables",
        COLLECTED,
        (value) => ({ ...value, localVariables: [{ type: "feedback" }] }),
        "localVariables is set, which the description format does not support yet",
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
              type: "timeofday",
              enabled: true,
              options: {},
            },
          ],
        }),
        'events[0].type is "timeofday", which the description format does not support yet',
        "event",
      ],
      [
        "a disabled event",
        COLLECTED,
        (value) => ({
          ...value,
          events: (value["events"] as Json[]).map((event) => ({
            ...event,
            enabled: false,
          })),
        }),
        "events[0].enabled is false; disabled events are not supported yet",
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
        "a variable_changed event on another variable",
        'Var "quoted" # hash',
        (value) => ({
          ...value,
          events: (value["events"] as Json[]).map((event) => ({
            ...event,
            options: { variableId: "internal:time_hms" },
          })),
        }),
        'events[0].options.variableId is "internal:time_hms"; only custom variables are supported yet',
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
            disabled: true,
          })),
        }),
        "actions[0].disabled is set, which the description format does not support yet",
        "action",
      ],
      [
        "an expression option outside the variable actions",
        'Var "quoted" # hash',
        (value) => ({
          ...value,
          actions: (value["actions"] as Json[]).map((action, index) =>
            index === 1
              ? {
                  ...action,
                  options: {
                    ...(action["options"] as Json),
                    path: { value: "$(custom:fx_label)", isExpression: true },
                  },
                }
              : action,
          ),
        }),
        "actions[1].options.path is an expression, which the description format supports only in set, expression, increment and decrement actions",
        "action",
      ],
    ];
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
      options: { ...(value["options"] as Json), notes: "n" },
    }));
    db.close();
    const line =
      '2 triggers cannot be exported: "Startup set" (condition); "In a collection" (options.notes)';
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
      path: "condition",
      hint: "see docs/support-matrix.md (condition)",
      items: [
        {
          message: `cannot export trigger "Startup set" (${startup}): condition is set, which the description format does not support yet (see docs/support-matrix.md, condition)`,
          path: "condition",
        },
        {
          message: `cannot export trigger "In a collection" (${collected}): options.notes is "n", which apply would store as "" (see docs/support-matrix.md, trigger option)`,
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

describe("export command line", () => {
  const cases: [string[], string][] = [
    [
      ["export"],
      "export needs a kind (variables or trigger or triggers or page or connection)",
    ],
    [
      ["export", "pages"],
      'unknown export kind "pages" (expected variables or trigger or triggers or page or connection)',
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
