import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  applyTo,
  type CliRun,
  type FixtureEnv,
  fileState,
  forbiddenProcessControl,
  rows,
  dumpDatabase,
  runCli,
  setup,
} from "./helpers.ts";

async function listTriggers(
  env: FixtureEnv,
  args: string[] = [],
): Promise<CliRun> {
  const before = fileState(env.dbPath);
  const { control, calls } = forbiddenProcessControl();
  const result = await runCli(
    ["list", "triggers", "--db", env.dbPath, ...args],
    { processControl: control, tmpdir: env.tmpdir },
  );
  assert.deepEqual(calls, [], "no process-control call");
  assert.deepEqual(fileState(env.dbPath), before, "target byte-identical");
  assert.deepEqual(readdirSync(env.tmpdir), [], "temporary copy removed");
  return result;
}

function ok(result: CliRun): string[] {
  assert.equal(result.code, 0, result.stderr.join("\n"));
  assert.deepEqual(result.stderr, []);
  return result.stdout;
}

function seed(db: DatabaseSync, id: string, value: unknown): void {
  db.prepare("INSERT INTO controls (id, value) VALUES (?, ?)").run(
    id,
    JSON.stringify(value),
  );
}

const NO_OPTIONS = "trigger:FixtureTrigNoOptionsAA";
const CONDITIONAL = "trigger:FixtureTrigCondAAAAAAA";
const DUP_A = "trigger:FixtureTrigDupAAAAAAAA";
const DUP_B = "trigger:FixtureTrigDupBBBBBBBB";

/**
 * Hand-seeded rows: a trigger without options, one with a condition and a
 * disabled event, two sharing a name (one event without `enabled`, one of an
 * other type), and two `trigger:` rows that are not triggers.
 */
function seedTriggers(db: DatabaseSync): void {
  seed(db, NO_OPTIONS, { type: "trigger" });
  seed(db, CONDITIONAL, {
    type: "trigger",
    options: { name: "Conditional", enabled: true, sortOrder: 1 },
    actions: [{ type: "action" }],
    condition: [{ type: "feedback" }],
    events: [
      { id: "e1", type: "condition_true", enabled: true, options: {} },
      {
        id: "e2",
        type: "variable_changed",
        enabled: false,
        options: { variableId: "internal:time_hms" },
      },
    ],
  });
  seed(db, DUP_B, {
    type: "trigger",
    options: { name: "Dup", enabled: true, sortOrder: 2 },
    actions: [],
    condition: [],
    events: [
      {
        id: "e3",
        type: "intervalRandom",
        enabled: true,
        options: { minimum: 1, maximum: 2 },
      },
    ],
  });
  seed(db, DUP_A, {
    type: "trigger",
    options: { name: "Dup", enabled: false, sortOrder: 2, collectionId: "c1" },
    events: [{ id: "e4", type: "startup", options: { delay: 10000 } }],
  });
  seed(db, "trigger:FixtureTrigButtonAAAAA", {
    type: "button",
    options: { name: "Not a trigger" },
  });
  seed(db, "trigger:FixtureTrigNumberAAAAA", 42);
}

const RESET_YAML = `kind: trigger
name: Reset counter
events:
  - { event: startup, delay: 0 }
  - { event: interval, seconds: 5 }
  - { event: variable_changed, variable: fx_counter }
actions:
  - { action: increment, variable: fx_counter }
  - { action: set, variable: fx_label, value: idle }
`;

const QUIET_YAML = `kind: trigger
name: Quiet
enabled: false
events:
  - { event: interval, seconds: 60 }
`;

/** The seeded fixture, then two tool-written triggers (sortOrder 3 and 4). */
async function triggerFixture(): Promise<{
  env: FixtureEnv;
  reset: string;
  quiet: string;
}> {
  const env = setup({}, seedTriggers);
  for (const yaml of [RESET_YAML, QUIET_YAML]) {
    const result = await applyTo(env, yaml);
    assert.equal(result.code, 0, result.stderr.join("\n"));
  }
  const controls = rows(dumpDatabase(env.dbPath), "controls");
  const idOf = (name: string) =>
    [...controls].find(
      ([, value]) => (value["options"] as { name?: string })?.name === name,
    )?.[0] ?? "";
  return { env, reset: idOf("Reset counter"), quiet: idOf("Quiet") };
}

describe("list triggers", () => {
  it("lists tool-written and hand-seeded triggers, as text", async () => {
    const { env, reset, quiet } = await triggerFixture();
    assert.deepEqual(ok(await listTriggers(env)), [
      "NAME           ENABLED  EVENTS                                    ACTIONS  ID",
      `New Trigger    no                                                 0        ${NO_OPTIONS}`,
      `Conditional    yes      condition_true, var internal:time_hms (…  1 +cond  ${CONDITIONAL}`,
      `Dup            no       startup 10000ms (off)                     0        ${DUP_A}`,
      `Dup            yes      random 1-2s                               0        ${DUP_B}`,
      `Reset counter  yes      startup 0ms, interval 5s, var fx_counter  2        ${reset}`,
      `Quiet          no       interval 60s                              0        ${quiet}`,
    ]);
  });

  it("prints one JSON document with --json", async () => {
    const { env, reset, quiet } = await triggerFixture();
    const stdout = ok(await listTriggers(env, ["--json"]));
    assert.equal(stdout.length, 1);
    const document = JSON.parse(stdout[0] ?? "");
    assert.equal(document.database, env.dbPath);
    assert.deepEqual(document.triggers, [
      {
        id: NO_OPTIONS,
        name: "New Trigger",
        enabled: false,
        sortOrder: 0,
        events: [],
        actionCount: 0,
        conditionCount: 0,
        collectionId: null,
      },
      {
        id: CONDITIONAL,
        name: "Conditional",
        enabled: true,
        sortOrder: 1,
        events: [
          { type: "condition_true", enabled: true, options: {} },
          {
            type: "variable_changed",
            enabled: false,
            options: { variableId: "internal:time_hms" },
          },
        ],
        actionCount: 1,
        conditionCount: 1,
        collectionId: null,
      },
      {
        id: DUP_A,
        name: "Dup",
        enabled: false,
        sortOrder: 2,
        events: [
          { type: "startup", enabled: false, options: { delay: 10000 } },
        ],
        actionCount: 0,
        conditionCount: 0,
        collectionId: "c1",
      },
      {
        id: DUP_B,
        name: "Dup",
        enabled: true,
        sortOrder: 2,
        events: [
          {
            type: "intervalRandom",
            enabled: true,
            options: { minimum: 1, maximum: 2 },
          },
        ],
        actionCount: 0,
        conditionCount: 0,
        collectionId: null,
      },
      {
        id: reset,
        name: "Reset counter",
        enabled: true,
        sortOrder: 3,
        events: [
          { type: "startup", enabled: true, options: { delay: 0 } },
          { type: "interval", enabled: true, options: { seconds: 5 } },
          {
            type: "variable_changed",
            enabled: true,
            options: { variableId: "custom:fx_counter" },
          },
        ],
        actionCount: 2,
        conditionCount: 0,
        collectionId: null,
      },
      {
        id: quiet,
        name: "Quiet",
        enabled: false,
        sortOrder: 4,
        events: [{ type: "interval", enabled: true, options: { seconds: 60 } }],
        actionCount: 0,
        conditionCount: 0,
        collectionId: null,
      },
    ]);
  });

  it("summarizes every event kind (#27)", async () => {
    const summaries: Array<[string, Record<string, unknown>, string]> = [
      ["intervalRandom", { minimum: 3, maximum: 10 }, "random 3-10s"],
      [
        "timeofday",
        { time: "08:00:00", days: [1, 2, 3, 4, 5] },
        "timeofday 08:00:00 mon-fri",
      ],
      [
        "timeofday",
        { time: "07:00:00", days: [6, 0] },
        "timeofday 07:00:00 sun,sat",
      ],
      [
        "timeofday",
        { time: "07:00:00", days: [0, 1, 2, 3, 4, 5, 6] },
        "timeofday 07:00:00 sun-sat",
      ],
      [
        "specificDate",
        { date: "2026-12-31", time: "23:00" },
        "date 2026-12-31 23:00",
      ],
      [
        "sun_event",
        { type: "sunset", latitude: 0, longitude: 0, offset: 10 },
        "sun sunset +10m",
      ],
      [
        "sun_event",
        { type: "sunrise", latitude: 0, longitude: 0, offset: -5 },
        "sun sunrise -5m",
      ],
      [
        "sun_event",
        { type: "sunrise", latitude: 0, longitude: 0, offset: 0 },
        "sun sunrise",
      ],
      ["client_connect", { delay: 0 }, "connect 0ms"],
      ["button_press", {}, "press"],
      ["button_release", {}, "release"],
      ["computer_locked", {}, "locked"],
      ["computer_unlocked", {}, "unlocked"],
      ["timeofday", { days: "x" }, "timeofday"],
    ];
    const env = setup({}, (db) =>
      summaries.forEach(([type, options], index) =>
        seed(db, `trigger:FixtureTrigEvent${String(index).padStart(4, "0")}A`, {
          type: "trigger",
          options: { name: `E${index}`, enabled: true, sortOrder: index },
          actions: [],
          condition: [],
          events: [{ id: `e${index}`, type, enabled: true, options }],
        }),
      ),
    );
    const stdout = ok(await listTriggers(env));
    assert.deepEqual(
      stdout.slice(1).map((line) => line.split(/ {2,}/)[2]),
      summaries.map(([, , summary]) => summary),
    );
  });

  it("gives byte-identical output on every run", async () => {
    const { env } = await triggerFixture();
    for (const args of [[], ["--json"]]) {
      const first = ok(await listTriggers(env, args));
      assert.deepEqual(ok(await listTriggers(env, args)), first);
    }
  });

  it("filters by name patterns", async () => {
    const { env, reset } = await triggerFixture();
    const names = async (...patterns: string[]) =>
      ok(await listTriggers(env, patterns))
        .slice(1)
        .map((line) => line.split("  ")[0]);
    assert.deepEqual(await names("Reset counter"), ["Reset counter"]);
    assert.deepEqual(await names("D?p"), ["Dup", "Dup"]);
    assert.deepEqual(await names("*e*", "Quiet"), [
      "New Trigger",
      "Reset counter",
      "Quiet",
    ]);
    assert.deepEqual(ok(await listTriggers(env, ["nomatch*"])), [
      "NAME  ENABLED  EVENTS  ACTIONS  ID",
    ]);
    const json = ok(await listTriggers(env, ["Reset*", "--json"]));
    assert.deepEqual(
      JSON.parse(json[0] ?? "").triggers.map((t: { id: string }) => t.id),
      [reset],
    );
  });

  it("an empty table prints only the header, or an empty list", async () => {
    const env = setup();
    assert.deepEqual(ok(await listTriggers(env)), [
      "NAME  ENABLED  EVENTS  ACTIONS  ID",
    ]);
    const json = ok(await listTriggers(env, ["--json"]));
    assert.deepEqual(JSON.parse(json[0] ?? ""), {
      database: env.dbPath,
      triggers: [],
    });
  });
});
