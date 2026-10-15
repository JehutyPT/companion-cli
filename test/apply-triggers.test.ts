/**
 * `kind: triggers`: several trigger bodies in one file, applied in one
 * transaction. Each entry is parsed and written exactly as `kind: trigger`.
 */
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  applyTo,
  applyYaml,
  assertTablesUnchangedExcept,
  dumpDatabase,
  type Json,
  rows,
  runCli,
  setup,
  type TableDump,
  writeDescription,
} from "./helpers.ts";

const KEPT = "trigger:FixtureTrigKeptAAAAAAA";
const OTHER = "trigger:FixtureTrigOtherAAAAAA";

function seed(db: DatabaseSync): void {
  const insert = db.prepare("INSERT INTO controls (id, value) VALUES (?, ?)");
  insert.run(
    KEPT,
    JSON.stringify({
      type: "trigger",
      options: {
        name: "Kept",
        enabled: true,
        sortOrder: 4,
        notes: "",
        collectionId: "coll1",
      },
      actions: [],
      condition: [],
      events: [
        {
          id: "SeedEventAAAAAAAAAAAA",
          type: "interval",
          enabled: true,
          options: { seconds: 30 },
        },
      ],
      localVariables: [],
    }),
  );
  insert.run(
    OTHER,
    JSON.stringify({
      type: "trigger",
      options: { name: "Other", enabled: true, sortOrder: 7, notes: "" },
      actions: [],
      condition: [],
      events: [],
      localVariables: [],
    }),
  );
}

const THREE_YAML = `kind: triggers
triggers:
  - name: Kept
    events: [ { event: startup, delay: 0 } ]
  - name: First new
    enabled: false
    events: [ { event: interval, seconds: 5 } ]
    actions: [ { action: increment, variable: fx_counter } ]
  - name: Second new
    events: [ { event: variable_changed, variable: fx_counter } ]
`;

function triggerRows(dump: TableDump): Map<string, Json> {
  return new Map(
    [...rows(dump, "controls")].filter(([id]) => id.startsWith("trigger:")),
  );
}

const options = (value: Json | undefined) => (value?.["options"] ?? {}) as Json;

describe("apply kind: triggers", () => {
  it("replaces one, creates two in list order and leaves the rest alone, in one apply", async () => {
    const { dbPath, before, result } = await applyYaml(THREE_YAML, {}, seed);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(result.stdout.at(-1), "triggers: 2 created, 1 replaced");

    const after = dumpDatabase(dbPath);
    assertTablesUnchangedExcept(before, after, "controls");
    const was = triggerRows(before);
    const now = triggerRows(after);
    assert.deepEqual(now.get(OTHER), was.get(OTHER), "unnamed untouched");
    assert.deepEqual(options(now.get(KEPT)), {
      name: "Kept",
      enabled: true,
      sortOrder: 4,
      notes: "",
      collectionId: "coll1",
    });
    const created = [...now].filter(([id]) => !was.has(id));
    assert.deepEqual(
      created
        .map(([, value]) => [
          options(value)["name"],
          options(value)["sortOrder"],
          options(value)["enabled"],
        ])
        .sort((a, b) => Number(a[1]) - Number(b[1])),
      [
        ["First new", 8, false],
        ["Second new", 9, true],
      ],
    );
    const nonTriggers = (dump: TableDump) =>
      (dump["controls"] ?? []).filter((row) => !row.id.startsWith("trigger:"));
    assert.deepEqual(nonTriggers(after), nonTriggers(before));
  });

  it("dry-run --json reports exactly those controls", async () => {
    const env = setup({}, seed);
    const file = writeDescription(env.dir, THREE_YAML);
    const result = await runCli(
      ["apply", file, "--db", env.dbPath, "--dry-run", "--json"],
      { tmpdir: env.tmpdir },
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    const report = JSON.parse(result.stdout.join("\n"));
    assert.equal(report.changed, true);
    assert.deepEqual(Object.keys(report.tables), ["controls"]);
    const controls = report.tables.controls;
    assert.deepEqual(
      controls.changed.map((row: { key: string }) => row.key),
      [KEPT],
    );
    assert.deepEqual(controls.removed, []);
    assert.deepEqual(
      controls.added
        .map((row: { after: Json }) => options(row.after)["name"])
        .sort(),
      ["First new", "Second new"],
    );
    assert.equal(report.summary, "triggers: 2 created, 1 replaced");
  });

  describe("refuses, naming the field", () => {
    const refusals: [string, string, RegExp][] = [
      [
        "an empty list",
        "kind: triggers\ntriggers: []\n",
        /triggers: must list at least one trigger/,
      ],
      [
        "duplicate names in the file",
        `kind: triggers
triggers:
  - { name: Same, events: [ { event: startup } ] }
  - { name: Same, events: [ { event: startup } ] }
`,
        /triggers\[1\]\.name: duplicate trigger name "Same" \(also at triggers\[0\]\)/,
      ],
      [
        "a bad entry",
        `kind: triggers
triggers:
  - { name: Fine, events: [ { event: startup } ] }
  - { name: Bad, events: [ { event: interval, seconds: 0 } ] }
`,
        /triggers\[1\]\.events\[0\]\.seconds: must be a positive integer, got 0/,
      ],
      [
        "an unknown variable",
        `kind: triggers
triggers:
  - { name: Fine, events: [ { event: startup } ] }
  - { name: Bad, events: [ { event: variable_changed, variable: nope } ] }
`,
        /triggers\[1\]\.events\[0\]\.variable: unknown custom variable "nope"/,
      ],
    ];
    for (const [label, yaml, expected] of refusals) {
      it(label, async () => {
        const { dbPath, before, result } = await applyYaml(yaml, {}, seed);
        assert.equal(result.code, 1);
        assert.match(result.stderr.join("\n"), expected);
        assert.deepEqual(dumpDatabase(dbPath), before);
      });
    }

    it("an ambiguous stored name", async () => {
      const env = setup({}, (db) => {
        seed(db);
        db.prepare("INSERT INTO controls (id, value) VALUES (?, ?)").run(
          "trigger:FixtureTrigKeptBBBBBBB",
          JSON.stringify({ type: "trigger", options: { name: "Kept" } }),
        );
      });
      const before = dumpDatabase(env.dbPath);
      const result = await applyTo(env, THREE_YAML);
      assert.equal(result.code, 1);
      assert.match(
        result.stderr.join("\n"),
        /triggers\[0\]\.name: 2 triggers with the same name "Kept" \(trigger:FixtureTrigKeptAAAAAAA, trigger:FixtureTrigKeptBBBBBBB\); refusing to choose one/,
      );
      assert.deepEqual(dumpDatabase(env.dbPath), before);
    });
  });
});
