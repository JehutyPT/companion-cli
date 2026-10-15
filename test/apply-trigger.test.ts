import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { parseDescription } from "../src/core/description.ts";
import { writers } from "../src/writers/index.ts";
import {
  applyTo,
  assertTablesUnchangedExcept,
  applyYaml,
  dumpDatabase,
  fileState,
  ID,
  type Json,
  normaliseIds,
  printedBackupDir,
  prop,
  rows,
  setup,
  stripIds,
  type TableDump,
  assertJsonTwin,
  forbiddenProcessControl,
  assertRefusalCode,
} from "./helpers.ts";

/** Seeded trigger ids: `trigger:` and 21 nanoid characters, as Companion makes them. */
const TRIGGER_A = "trigger:FixtureTrigAAAAAAAAAA";
const TRIGGER_B = "trigger:FixtureTrigBBBBBBBBBB";
const TRIGGER_C = "trigger:FixtureTrigCCCCCCCCCC";
const TRIGGER_ID = /^trigger:[A-Za-z0-9_-]{21}$/;

interface SeedOptions {
  name: string;
  sortOrder?: number;
  collectionId?: string;
}

/** A trigger as Companion 5.1 stores one made in its UI, with a condition and notes. */
function storedTrigger({ name, sortOrder = 0, collectionId }: SeedOptions) {
  return {
    type: "trigger",
    options: {
      name,
      enabled: false,
      sortOrder,
      notes: "old notes",
      ...(collectionId === undefined ? {} : { collectionId }),
    },
    actions: [
      {
        type: "action",
        id: "SeedActionAAAAAAAAAAA",
        definitionId: "custom_variable_set_value",
        connectionId: "internal",
        options: {
          name: { value: "fx_label", isExpression: false },
          value: { value: "old", isExpression: false },
        },
      },
    ],
    condition: [
      {
        type: "feedback",
        id: "SeedFeedbackAAAAAAAAA",
        definitionId: "check_expression",
        connectionId: "internal",
        options: { expression: { value: "true", isExpression: false } },
      },
    ],
    events: [
      {
        id: "SeedEventAAAAAAAAAAAA",
        type: "interval",
        enabled: true,
        options: { seconds: 30 },
      },
    ],
    localVariables: [],
  };
}

function seedTrigger(db: DatabaseSync, id: string, options: SeedOptions) {
  db.prepare("INSERT INTO controls (id, value) VALUES (?, ?)").run(
    id,
    JSON.stringify(storedTrigger(options)),
  );
}

/** The `trigger:` controls in a dump, by id. */
function triggers(dump: TableDump): Map<string, Json> {
  return new Map(
    [...rows(dump, "controls")].filter(([id]) => id.startsWith("trigger:")),
  );
}

/** The one trigger control a dump has that `before` did not. */
function newTrigger(before: TableDump, after: TableDump): [string, Json] {
  const old = triggers(before);
  const added = [...triggers(after)].filter(([id]) => !old.has(id));
  assert.equal(added.length, 1, "one new trigger control");
  return added[0] as [string, Json];
}

/** Every control except `except` is unchanged. */
function assertOtherControlsUnchanged(
  before: TableDump,
  after: TableDump,
  except: string,
) {
  const strip = (dump: TableDump) =>
    (dump["controls"] ?? []).filter((row) => row.id !== except);
  assert.deepEqual(strip(after), strip(before));
}

const FULL_YAML = `kind: trigger
name: Reset counter
events:
  - { event: variable_changed, variable: fx_counter }
  - { event: startup, delay: 0 }
  - { event: interval, seconds: 5 }
  - { event: startup }
actions:
  - { action: set, variable: fx_label, value: reset }
  - { action: increment, variable: fx_counter }
  - { action: expression, variable: fx_gap, expression: "$(custom:fx_counter) * 2" }
  - action: passthrough
    connection: FixtureConnectionAAAA
    definition: some_definition
    options: { mode: 1 }
`;

const FULL_ACTIONS = [
  {
    type: "action",
    id: "<id>",
    definitionId: "custom_variable_set_value",
    connectionId: "internal",
    options: { name: prop("fx_label"), value: prop("reset") },
  },
  {
    type: "action",
    id: "<id>",
    definitionId: "custom_variable_set_value",
    connectionId: "internal",
    options: {
      name: prop("fx_counter"),
      value: prop("$(this:current) + 1", true),
    },
  },
  {
    type: "action",
    id: "<id>",
    definitionId: "custom_variable_set_value",
    connectionId: "internal",
    options: {
      name: prop("fx_gap"),
      value: prop("$(custom:fx_counter) * 2", true),
    },
  },
  {
    type: "action",
    id: "<id>",
    definitionId: "some_definition",
    connectionId: "FixtureConnectionAAAA",
    options: { mode: prop(1) },
  },
];

const FULL_EVENTS = [
  {
    id: "<id>",
    type: "variable_changed",
    enabled: true,
    options: { variableId: "custom:fx_counter" },
  },
  { id: "<id>", type: "startup", enabled: true, options: { delay: 0 } },
  { id: "<id>", type: "interval", enabled: true, options: { seconds: 5 } },
  { id: "<id>", type: "startup", enabled: true, options: { delay: 10000 } },
];

/** Every generated action and event id is a fresh 21-character id. */
function assertFreshIds(control: Json) {
  const ids = [
    ...(control["actions"] as Json[]),
    ...(control["events"] as Json[]),
  ].map((entity) => entity["id"]);
  for (const id of ids) assert.match(String(id), ID);
  assert.equal(new Set(ids).size, ids.length, "ids are distinct");
}

describe("apply trigger: creating a trigger", () => {
  it("writes one trigger control with every event kind and a mix of actions", async () => {
    const { dbPath, before, result } = await applyYaml(FULL_YAML, {}, (db) => {
      seedTrigger(db, TRIGGER_A, { name: "Other", sortOrder: 2 });
      seedTrigger(db, TRIGGER_B, { name: "Another", sortOrder: 7 });
    });
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(result.stderr, []);
    assert.ok(printedBackupDir(result));
    assert.equal(result.stdout.length, 2);
    assert.match(result.stdout[0] ?? "", /^backup: /);

    const after = dumpDatabase(dbPath);
    const [id, control] = newTrigger(before, after);
    assert.match(id, TRIGGER_ID);
    assert.equal(result.stdout[1], `trigger "Reset counter": created ${id}`);
    assert.deepEqual(stripIds(control), {
      type: "trigger",
      options: {
        name: "Reset counter",
        enabled: true,
        sortOrder: 8,
        notes: "",
      },
      actions: FULL_ACTIONS,
      condition: [],
      events: FULL_EVENTS,
      localVariables: [],
    });
    assertFreshIds(control);
    assertOtherControlsUnchanged(before, after, id);
    assertTablesUnchangedExcept(before, after, "controls");
  });

  it("gives the first trigger sortOrder 0, and defaults actions to [] and enabled to true", async () => {
    const { dbPath, before, result } = await applyYaml(`kind: trigger
name: Tick
events: [ { event: interval, seconds: 1 } ]
`);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    const [, control] = newTrigger(before, dumpDatabase(dbPath));
    assert.deepEqual(stripIds(control), {
      type: "trigger",
      options: { name: "Tick", enabled: true, sortOrder: 0, notes: "" },
      actions: [],
      condition: [],
      events: [
        {
          id: "<id>",
          type: "interval",
          enabled: true,
          options: { seconds: 1 },
        },
      ],
      localVariables: [],
    });
  });

  it("writes enabled: false", async () => {
    const { dbPath, before, result } = await applyYaml(`kind: trigger
name: Off
enabled: false
events: [ { event: startup } ]
`);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    const [, control] = newTrigger(before, dumpDatabase(dbPath));
    assert.equal((control["options"] as Json)["enabled"], false);
  });

  it("compares names exactly: a name differing in case creates a new trigger", async () => {
    const { dbPath, before, result } = await applyYaml(FULL_YAML, {}, (db) =>
      seedTrigger(db, TRIGGER_A, { name: "reset counter" }),
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    const after = dumpDatabase(dbPath);
    const [id] = newTrigger(before, after);
    assert.match(result.stdout[1] ?? "", /: created trigger:/);
    assertOtherControlsUnchanged(before, after, id);
  });

  it("ignores trigger: rows that are not trigger objects when matching names and ordering", async () => {
    const { dbPath, before, result } = await applyYaml(FULL_YAML, {}, (db) => {
      const insert = db.prepare(
        "INSERT INTO controls (id, value) VALUES (?, ?)",
      );
      insert.run(TRIGGER_A, JSON.stringify("Reset counter"));
      insert.run(TRIGGER_B, JSON.stringify([1, 2]));
      insert.run(
        TRIGGER_C,
        JSON.stringify({
          type: "button-layered",
          options: { name: "Reset counter", sortOrder: 40 },
        }),
      );
    });
    assert.equal(result.code, 0, result.stderr.join("\n"));
    const after = dumpDatabase(dbPath);
    const [id, control] = newTrigger(before, after);
    assert.equal((control["options"] as Json)["sortOrder"], 0);
    assertOtherControlsUnchanged(before, after, id);
  });
});

describe("apply trigger: replacing the trigger with the same name", () => {
  it("keeps the control id, sortOrder and collectionId and replaces everything else", async () => {
    const { dbPath, before, result } = await applyYaml(FULL_YAML, {}, (db) => {
      seedTrigger(db, TRIGGER_A, {
        name: "Reset counter",
        sortOrder: 3,
        collectionId: "FixtureCollectionAAAA",
      });
      seedTrigger(db, TRIGGER_B, { name: "Other", sortOrder: 9 });
    });
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(
      result.stdout[1],
      `trigger "Reset counter": replaced ${TRIGGER_A}`,
    );

    const after = dumpDatabase(dbPath);
    assert.deepEqual(
      [...triggers(after).keys()],
      [...triggers(before).keys()],
      "no trigger created or deleted",
    );
    const control = triggers(after).get(TRIGGER_A);
    assert.ok(control);
    assert.deepEqual(stripIds(control), {
      type: "trigger",
      options: {
        name: "Reset counter",
        enabled: true,
        sortOrder: 3,
        notes: "",
        collectionId: "FixtureCollectionAAAA",
      },
      actions: FULL_ACTIONS,
      condition: [],
      events: FULL_EVENTS,
      localVariables: [],
    });
    assertFreshIds(control);
    assert.equal(JSON.stringify(control).includes("Seed"), false);
    assertOtherControlsUnchanged(before, after, TRIGGER_A);
    assertTablesUnchangedExcept(before, after, "controls");
  });

  it("writes no collectionId when the replaced trigger has none", async () => {
    const { dbPath, result } = await applyYaml(FULL_YAML, {}, (db) =>
      seedTrigger(db, TRIGGER_A, { name: "Reset counter", sortOrder: 4 }),
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    const control = triggers(dumpDatabase(dbPath)).get(TRIGGER_A);
    assert.deepEqual(control?.["options"], {
      name: "Reset counter",
      enabled: true,
      sortOrder: 4,
      notes: "",
    });
  });

  it("falls back to the next sort order when the replaced trigger's sortOrder is not a number", async () => {
    const { dbPath, result } = await applyYaml(FULL_YAML, {}, (db) => {
      seedTrigger(db, TRIGGER_B, { name: "Other", sortOrder: 6 });
      db.prepare("INSERT INTO controls (id, value) VALUES (?, ?)").run(
        TRIGGER_A,
        JSON.stringify({
          ...storedTrigger({ name: "Reset counter" }),
          options: { name: "Reset counter", sortOrder: "3" },
        }),
      );
    });
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.match(result.stdout[1] ?? "", /: replaced trigger:FixtureTrigA/);
    const control = triggers(dumpDatabase(dbPath)).get(TRIGGER_A);
    assert.equal((control?.["options"] as Json)["sortOrder"], 7);
  });

  it("drops a null collectionId", async () => {
    const { dbPath, result } = await applyYaml(FULL_YAML, {}, (db) =>
      db.prepare("INSERT INTO controls (id, value) VALUES (?, ?)").run(
        TRIGGER_A,
        JSON.stringify({
          ...storedTrigger({ name: "Reset counter" }),
          options: { name: "Reset counter", sortOrder: 2, collectionId: null },
        }),
      ),
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    const control = triggers(dumpDatabase(dbPath)).get(TRIGGER_A);
    assert.deepEqual(control?.["options"], {
      name: "Reset counter",
      enabled: true,
      sortOrder: 2,
      notes: "",
    });
  });

  // Companion's trigger class falls back to its DefaultOptions
  // (`this.options=n.options||this.options`), so such a row is "New Trigger".
  it('treats a trigger row without options as Companion\'s "New Trigger"', async () => {
    const { dbPath, before, result } = await applyYaml(
      FULL_YAML.replace("name: Reset counter", "name: New Trigger"),
      {},
      (db) =>
        db
          .prepare("INSERT INTO controls (id, value) VALUES (?, ?)")
          .run(
            TRIGGER_A,
            JSON.stringify({ type: "trigger", actions: [], events: [] }),
          ),
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(
      result.stdout[1],
      `trigger "New Trigger": replaced ${TRIGGER_A}`,
    );
    const after = dumpDatabase(dbPath);
    const control = triggers(after).get(TRIGGER_A);
    assert.deepEqual(control?.["options"], {
      name: "New Trigger",
      enabled: true,
      sortOrder: 0,
      notes: "",
    });
    assertOtherControlsUnchanged(before, after, TRIGGER_A);
  });

  it("gives the same database content when applied twice", async () => {
    const env = setup({}, (db) =>
      seedTrigger(db, TRIGGER_A, { name: "Other", sortOrder: 1 }),
    );
    const before = dumpDatabase(env.dbPath);
    const first = await applyTo(env, FULL_YAML);
    assert.equal(first.code, 0, first.stderr.join("\n"));
    const once = dumpDatabase(env.dbPath);
    const second = await applyTo(env, FULL_YAML);
    assert.equal(second.code, 0, second.stderr.join("\n"));
    const twice = dumpDatabase(env.dbPath);

    const [id] = newTrigger(before, once);
    assert.equal(first.stdout[1], `trigger "Reset counter": created ${id}`);
    assert.equal(second.stdout[1], `trigger "Reset counter": replaced ${id}`);
    assert.deepEqual([...triggers(twice).keys()], [...triggers(once).keys()]);
    assert.deepEqual(normaliseIds(twice), normaliseIds(once));
  });
});

describe("apply trigger: refusals leave the database byte-identical", () => {
  async function refuse(
    yaml: string,
    expected: RegExp,
    change?: (db: DatabaseSync) => void,
  ) {
    const env = setup({}, change);
    const before = fileState(env.dbPath);
    const result = await applyTo(env, yaml);
    assert.equal(result.code, 1, result.stdout.join("\n"));
    assert.equal(result.stderr.length, 1, result.stderr.join("\n"));
    assert.match(result.stderr[0] ?? "", expected);
    assert.deepEqual(fileState(env.dbPath), before);
    assert.equal(existsSync(env.backupRoot), false, "no backup for a refusal");
    const json = await applyTo(env, yaml, {}, ["--json"]);
    assertRefusalCode(assertJsonTwin(result, json));
    const dry = await applyTo(
      env,
      yaml,
      { processControl: forbiddenProcessControl().control },
      ["--dry-run", "--json"],
    );
    assert.deepEqual(dry, json, "the dry run refuses with the same document");
    assert.deepEqual(fileState(env.dbPath), before);
  }

  const trigger = (events: string, extra = "") =>
    `kind: trigger\nname: T\nevents:\n${events}${extra}`;

  const parseCases: Array<[string, string, RegExp]> = [
    [
      "unknown top-level field",
      trigger("  - { event: startup }\n", "notes: hi\n"),
      /: notes: unknown field$/,
    ],
    [
      "condition",
      trigger("  - { event: startup }\n", "condition: []\n"),
      /: condition: unknown field$/,
    ],
    [
      "missing name",
      "kind: trigger\nevents: [ { event: startup } ]\n",
      /: name: is required$/,
    ],
    [
      "empty name",
      'kind: trigger\nname: ""\nevents: [ { event: startup } ]\n',
      /: name: must not be empty$/,
    ],
    [
      "non-string name",
      "kind: trigger\nname: 12\nevents: [ { event: startup } ]\n",
      /: name: must be a string/,
    ],
    [
      "non-boolean enabled",
      trigger("  - { event: startup }\n", "enabled: yes please\n"),
      /: enabled: must be true or false/,
    ],
    ["missing events", "kind: trigger\nname: T\n", /: events: is required$/],
    [
      "empty events",
      "kind: trigger\nname: T\nevents: []\n",
      /: events: must list at least one event$/,
    ],
    [
      "events not a list",
      "kind: trigger\nname: T\nevents: { event: startup }\n",
      /: events: must be a list/,
    ],
    [
      "event not a mapping",
      trigger("  - startup\n"),
      /: events\[0\]: must be a mapping/,
    ],
    [
      "missing event tag",
      trigger("  - { delay: 5 }\n"),
      /: events\[0\]\.event: is required$/,
    ],
    [
      "unknown event",
      trigger("  - { event: startup }\n  - { event: timeofday }\n"),
      /: events\[1\]\.event: unknown event "timeofday" \(expected one of: startup, interval, variable_changed\)$/,
    ],
    [
      "unknown event field",
      trigger("  - { event: startup, seconds: 5 }\n"),
      /: events\[0\]\.seconds: unknown field$/,
    ],
    [
      "negative delay",
      trigger("  - { event: startup, delay: -1 }\n"),
      /: events\[0\]\.delay: must be an integer of at least 0, got -1$/,
    ],
    [
      "fractional delay",
      trigger("  - { event: startup, delay: 1.5 }\n"),
      /: events\[0\]\.delay: must be an integer of at least 0, got 1\.5$/,
    ],
    [
      "missing seconds",
      trigger("  - { event: interval }\n"),
      /: events\[0\]\.seconds: is required$/,
    ],
    [
      "zero seconds",
      trigger("  - { event: interval, seconds: 0 }\n"),
      /: events\[0\]\.seconds: must be a positive integer, got 0$/,
    ],
    [
      "string seconds",
      trigger('  - { event: interval, seconds: "5" }\n'),
      /: events\[0\]\.seconds: must be a positive integer, got a string$/,
    ],
    [
      "missing variable",
      trigger("  - { event: variable_changed }\n"),
      /: events\[0\]\.variable: is required$/,
    ],
    [
      "invalid variable name",
      trigger("  - { event: variable_changed, variable: custom:fx_counter }\n"),
      /: events\[0\]\.variable: invalid variable name "custom:fx_counter"/,
    ],
    [
      "unknown action",
      trigger("  - { event: startup }\n", "actions: [ { action: jump } ]\n"),
      /: actions\[0\]\.action: unknown action "jump"/,
    ],
    [
      "unknown action field",
      trigger(
        "  - { event: startup }\n",
        "actions:\n  - { action: set, variable: fx_label, value: a }\n  - { action: increment, variable: fx_counter, value: 1 }\n",
      ),
      /: actions\[1\]\.value: unknown field$/,
    ],
  ];
  for (const [name, yaml, expected] of parseCases) {
    it(`refuses: ${name}`, async () => {
      await refuse(
        yaml,
        new RegExp(`^error: invalid description .*${expected.source}`),
      );
    });
  }

  it("refuses an unknown event variable, naming the event", async () => {
    await refuse(
      trigger(
        "  - { event: startup }\n  - { event: interval, seconds: 1 }\n  - { event: variable_changed, variable: nope }\n",
      ),
      /^error: events\[2\]\.variable: unknown custom variable "nope"$/,
    );
  });

  it("refuses an unknown action variable, naming the action", async () => {
    await refuse(
      trigger(
        "  - { event: startup }\n",
        "actions:\n  - { action: set, variable: fx_label, value: a }\n  - { action: set, variable: fx_label, value: $(custom:nope) }\n",
      ),
      /^error: actions\[1\]\.value: unknown custom variable "nope"$/,
    );
  });

  it("refuses a name two triggers share, naming both control ids", async () => {
    await refuse(
      FULL_YAML,
      new RegExp(
        `^error: name: 2 triggers with the same name "Reset counter" \\(${TRIGGER_A}, ${TRIGGER_C}\\); refusing to choose one$`,
      ),
      (db) => {
        seedTrigger(db, TRIGGER_C, { name: "Reset counter" });
        seedTrigger(db, TRIGGER_B, { name: "Other" });
        seedTrigger(db, TRIGGER_A, { name: "Reset counter" });
      },
    );
  });
});

describe("apply trigger: Companion's default name", () => {
  it('refuses "New Trigger" when an options-less row and a named trigger share it', async () => {
    const env = setup({}, (db) => {
      db.prepare("INSERT INTO controls (id, value) VALUES (?, ?)").run(
        TRIGGER_B,
        JSON.stringify({ type: "trigger", options: null }),
      );
      seedTrigger(db, TRIGGER_A, { name: "New Trigger" });
    });
    const before = fileState(env.dbPath);
    const result = await applyTo(
      env,
      "kind: trigger\nname: New Trigger\nevents: [ { event: startup } ]\n",
    );
    assert.equal(result.code, 1, result.stdout.join("\n"));
    assert.deepEqual(result.stderr, [
      `error: name: 2 triggers with the same name "New Trigger" (${TRIGGER_A}, ${TRIGGER_B}); refusing to choose one`,
    ]);
    assert.deepEqual(fileState(env.dbPath), before);
  });
});

describe("apply trigger: the checks run again under the write lock", () => {
  async function refuseAfterBackup(
    change: (db: DatabaseSync) => void,
    expected: RegExp,
  ) {
    const env = setup({}, (db) =>
      seedTrigger(db, TRIGGER_A, { name: "Reset counter", sortOrder: 2 }),
    );
    const before = dumpDatabase(env.dbPath);
    let changed: TableDump | undefined;
    const result = await applyTo(env, FULL_YAML, {
      hooks: {
        afterBackup: (path) => {
          const db = new DatabaseSync(path);
          change(db);
          db.close();
          changed = dumpDatabase(path);
        },
      },
    });
    assert.equal(result.code, 1, result.stdout.join("\n"));
    assert.equal(result.stderr.length, 1);
    assert.match(result.stderr[0] ?? "", expected);
    assert.match(result.stderr[0] ?? "", /\(nothing written; backup kept at /);
    assert.notDeepEqual(changed, before);
    assert.deepEqual(dumpDatabase(env.dbPath), changed);
  }

  it("refuses a trigger with the same name added after the snapshot", async () => {
    await refuseAfterBackup(
      (db) => seedTrigger(db, TRIGGER_B, { name: "Reset counter" }),
      new RegExp(
        `^error: name: 2 triggers with the same name "Reset counter" \\(${TRIGGER_A}, ${TRIGGER_B}\\)`,
      ),
    );
  });

  it("refuses a variable deleted after the snapshot", async () => {
    await refuseAfterBackup(
      (db) =>
        db.prepare("DELETE FROM custom_variables WHERE id = ?").run("fx_gap"),
      /^error: actions\[2\]\.variable: unknown custom variable "fx_gap"/,
    );
  });
});

describe("apply trigger: registry", () => {
  it("resolves kind: trigger to the trigger writer", () => {
    const { writer } = parseDescription(
      { kind: "trigger", name: "T", events: [{ event: "startup" }] },
      writers,
    );
    assert.equal(writer.kind, "trigger");
  });

  it("still refuses a kind without a registered writer as reserved", () => {
    assert.throws(
      () => parseDescription({ kind: "trigger" }, {}),
      /kind: kind "trigger" is reserved and not supported yet/,
    );
  });
});
