import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  type CliRun,
  type FixtureEnv,
  fakeProcessControl,
  fileState,
  forbiddenProcessControl,
  installDir,
  runCli,
  setup,
  tempDir,
} from "./helpers.ts";
import { buildFixtureDb } from "./fixtures/companion-db.ts";
import { seedCensus, SENTINEL } from "./census-fixture.ts";
import { insert, ok } from "./list-fixture.ts";

/**
 * Runs `census` and checks #12's read-only proof: no process-control call,
 * the target byte-identical, no temporary copy left.
 */
async function censusReadOnly(
  env: FixtureEnv,
  args: string[] = [],
): Promise<CliRun> {
  const before = fileState(env.dbPath);
  const { control, calls } = forbiddenProcessControl();
  const result = await runCli(["census", "--db", env.dbPath, ...args], {
    processControl: control,
    tmpdir: env.tmpdir,
  });
  assert.deepEqual(calls, [], "no process-control call");
  assert.deepEqual(fileState(env.dbPath), before, "target byte-identical");
  assert.deepEqual(readdirSync(env.tmpdir), [], "temporary copy removed");
  return result;
}

const t = (controls: number, occurrences = controls) => ({
  controls,
  occurrences,
});
const none = { byModule: {}, byDefinition: {} };

const EXPECTED = {
  database: null,
  version: 1,
  controls: {
    types: {
      "button-layered": { total: 3, placed: 2, unplaced: 1 },
      "mystery-type": { total: 1, placed: 0, unplaced: 1 },
      pageup: { total: 1, placed: 1, unplaced: 0 },
      trigger: { total: 2, placed: 0, unplaced: 2 },
    },
    entityTypes: { action: t(3, 7), feedback: t(2, 9), gizmo: t(1) },
  },
  buttons: {
    total: 3,
    notes: 1,
    rotaryActions: 1,
    options: {
      canModifyStyleInApis: 1,
      mysteryOption: 1,
      notes: 1,
      rotaryActions: 1,
      stepExpression: 1,
      stepProgression: 1,
    },
    stepProgression: { auto: 1, manual: 1, missing: 1 },
    canModifyStyleInApis: { false: 1, missing: 1, true: 1 },
  },
  steps: {
    runWhileHeld: t(1),
    counts: { "0": 1, "1": 1, "2": 0, "3+": 1 },
    actionSets: { down: t(2), hold: t(1), rotate_left: t(1), up: t(1) },
    options: { name: t(1) },
  },
  style: {
    template: 1,
    differences: {
      image: 1,
      layerOrder: 0,
      missingLayer: { box0: t(1), canvas: t(2), image0: t(1), text0: t(1) },
      extraLayer: { text: t(1) },
      layerType: {},
      property: { "text0.fontsize": t(1) },
      expression: { "extra.text": t(1), "text0.text": t(1) },
    },
  },
  actions: {
    occurrences: {
      byModule: {
        "(missing)": t(1),
        "(unknown)": t(1),
        "alpha-module": t(2),
        internal: t(2, 3),
      },
      byDefinition: {
        "(missing):lost": t(1),
        "(unknown):go": t(1),
        "alpha-module:run": t(2),
        "internal:custom_variable_set_value": t(1),
        "internal:logic_if": t(1),
        "internal:wait": t(1),
      },
    },
    expression: {
      byModule: { internal: t(1) },
      byDefinition: { "internal:custom_variable_set_value": t(1) },
    },
    disabled: {
      byModule: { "alpha-module": t(1) },
      byDefinition: { "alpha-module:run": t(1) },
    },
    headline: {
      byModule: { "alpha-module": t(1) },
      byDefinition: { "alpha-module:run": t(1) },
    },
    upgradeIndex: {
      byModule: { "alpha-module": t(1) },
      byDefinition: { "alpha-module:run": t(1) },
    },
    children: {
      byModule: { internal: t(1) },
      byDefinition: { "internal:logic_if": t(1) },
    },
    childGroups: { default: t(1) },
    storeResult: { "custom-variable": t(1) },
  },
  feedbacks: {
    occurrences: {
      byModule: { "alpha-module": t(2), internal: t(2, 7) },
      byDefinition: {
        "alpha-module:tally": t(1),
        "alpha-module:variable_value": t(1),
        "internal:check_expression": t(1),
        "internal:logic_and": t(1),
        "internal:user_value": t(2, 4),
        "internal:variable_value": t(1),
      },
    },
    expression: {
      byModule: { "alpha-module": t(1), internal: t(1) },
      byDefinition: {
        "alpha-module:variable_value": t(1),
        "internal:check_expression": t(1),
      },
    },
    disabled: none,
    headline: {
      byModule: { "alpha-module": t(1) },
      byDefinition: { "alpha-module:variable_value": t(1) },
    },
    upgradeIndex: none,
    children: {
      byModule: { internal: t(1) },
      byDefinition: { "internal:logic_and": t(1) },
    },
    childGroups: { conditions: t(1) },
    storeResult: {},
    styleOverrides: t(1),
    inverted: t(1),
    invertedExpression: t(1),
    variableName: t(2, 5),
    lists: {
      children: t(1),
      condition: t(1),
      feedbacks: t(1, 2),
      localVariables: t(2, 5),
    },
    elementProperty: { color: t(1), text: t(1) },
  },
  localVariables: {
    controls: { "button-layered": 1, trigger: 1 },
    counts: { "1": 1, "2": 0, "3+": 1 },
    byModule: { internal: t(2, 5) },
    byDefinition: {
      "internal:logic_and": t(1),
      "internal:user_value": t(2, 4),
    },
  },
  triggers: {
    total: 2,
    disabled: 1,
    notes: 1,
    collection: 1,
    condition: 1,
    disabledEvents: t(1),
    events: { interval: t(1, 2), startup: t(1), weird_event: t(1) },
    conditionDefinitions: { "internal:variable_value": t(1) },
  },
  variables: {
    total: 3,
    persisted: 1,
    defaultTypes: { null: 1, number: 1, string: 1 },
  },
  support: "not available",
};

const EXPECTED_TEXT = `census version 1

controls.types
  button-layered  3 (2 placed, 1 unplaced)
  trigger         2 (0 placed, 2 unplaced)
  mystery-type    1 (0 placed, 1 unplaced)
  pageup          1 (1 placed, 0 unplaced)

controls.entityTypes
  feedback  9 in 2 controls
  action    7 in 3 controls
  gizmo     1

buttons
  total          3
  notes          1
  rotaryActions  1

buttons.options
  canModifyStyleInApis  1
  mysteryOption         1
  notes                 1
  rotaryActions         1
  stepExpression        1
  stepProgression       1

buttons.stepProgression
  auto     1
  manual   1
  missing  1

buttons.canModifyStyleInApis
  false    1
  missing  1
  true     1

steps
  runWhileHeld  1

steps.counts
  0   1
  1   1
  3+  1
  2   0

steps.actionSets
  down         2
  hold         1
  rotate_left  1
  up           1

steps.options
  name  1

style
  template  1

style.differences
  image       1
  layerOrder  0

style.differences.missingLayer
  canvas  2
  box0    1
  image0  1
  text0   1

style.differences.extraLayer
  text  1

style.differences.layerType
  (none)

style.differences.property
  text0.fontsize  1

style.differences.expression
  extra.text  1
  text0.text  1

actions.occurrences.byModule
  internal      3 in 2 controls
  alpha-module  2
  (missing)     1
  (unknown)     1

actions.occurrences.byDefinition
  alpha-module:run                    2
  (missing):lost                      1
  (unknown):go                        1
  internal:custom_variable_set_value  1
  internal:logic_if                   1
  internal:wait                       1

actions.expression.byModule
  internal  1

actions.expression.byDefinition
  internal:custom_variable_set_value  1

actions.disabled.byModule
  alpha-module  1

actions.disabled.byDefinition
  alpha-module:run  1

actions.headline.byModule
  alpha-module  1

actions.headline.byDefinition
  alpha-module:run  1

actions.upgradeIndex.byModule
  alpha-module  1

actions.upgradeIndex.byDefinition
  alpha-module:run  1

actions.children.byModule
  internal  1

actions.children.byDefinition
  internal:logic_if  1

actions.childGroups
  default  1

actions.storeResult
  custom-variable  1

feedbacks
  variableName        5 in 2 controls
  inverted            1
  invertedExpression  1
  styleOverrides      1

feedbacks.occurrences.byModule
  internal      7 in 2 controls
  alpha-module  2

feedbacks.occurrences.byDefinition
  internal:user_value          4 in 2 controls
  alpha-module:tally           1
  alpha-module:variable_value  1
  internal:check_expression    1
  internal:logic_and           1
  internal:variable_value      1

feedbacks.expression.byModule
  alpha-module  1
  internal      1

feedbacks.expression.byDefinition
  alpha-module:variable_value  1
  internal:check_expression    1

feedbacks.disabled.byModule
  (none)

feedbacks.disabled.byDefinition
  (none)

feedbacks.headline.byModule
  alpha-module  1

feedbacks.headline.byDefinition
  alpha-module:variable_value  1

feedbacks.upgradeIndex.byModule
  (none)

feedbacks.upgradeIndex.byDefinition
  (none)

feedbacks.children.byModule
  internal  1

feedbacks.children.byDefinition
  internal:logic_and  1

feedbacks.childGroups
  conditions  1

feedbacks.storeResult
  (none)

feedbacks.lists
  localVariables  5 in 2 controls
  feedbacks       2 in 1 controls
  children        1
  condition       1

feedbacks.elementProperty
  color  1
  text   1

localVariables.controls
  button-layered  1
  trigger         1

localVariables.counts
  1   1
  3+  1
  2   0

localVariables.byModule
  internal  5 in 2 controls

localVariables.byDefinition
  internal:user_value  4 in 2 controls
  internal:logic_and   1

triggers
  total           2
  collection      1
  condition       1
  disabled        1
  disabledEvents  1
  notes           1

triggers.events
  interval     2 in 1 controls
  startup      1
  weird_event  1

triggers.conditionDefinitions
  internal:variable_value  1

variables
  total      3
  persisted  1

variables.defaultTypes
  null    1
  number  1
  string  1

support
  not available`;

describe("census", () => {
  it("counts every seeded case, as one JSON document", async () => {
    const env = setup({}, seedCensus);
    const stdout = ok(await censusReadOnly(env, ["--json"]));
    assert.equal(stdout.length, 1);
    assert.deepEqual(JSON.parse(stdout[0] ?? ""), EXPECTED);
  });

  it("prints the same counts as text", async () => {
    const env = setup({}, seedCensus);
    const text = ok(await censusReadOnly(env)).join("\n");
    assert.equal(text, EXPECTED_TEXT);
  });

  it("never prints a value, in text or JSON", async () => {
    const env = setup({}, seedCensus);
    for (const args of [[], ["--json"]]) {
      const result = await censusReadOnly(env, args);
      const output = [...result.stdout, ...result.stderr].join("\n");
      assert.equal(result.code, 0);
      assert.ok(!output.includes(SENTINEL), output);
      for (const secret of ["7777", "8888", "123456", "1000"]) {
        assert.ok(!output.includes(secret), `${secret} printed`);
      }
    }
  });

  it("prints byte-identical output on repeat runs", async () => {
    const env = setup({}, seedCensus);
    for (const args of [[], ["--json"]]) {
      const first = ok(await censusReadOnly(env, args));
      const second = ok(await censusReadOnly(env, args));
      assert.deepEqual(second, first);
    }
  });

  it("counts the SKAARHOJ page's buttons as matching the template", async () => {
    const env = setup({}, (db: DatabaseSync) => {
      const capture = JSON.parse(
        readFileSync(
          new URL("./fixtures/skaarhoj-page20.json", import.meta.url),
          "utf8",
        ),
      ) as { controls: Record<string, unknown> };
      for (const [cell, value] of Object.entries(capture.controls)) {
        insert(db, "controls", `bank:skaarhoj-${cell}`, value);
      }
    });
    const document = JSON.parse(
      ok(await censusReadOnly(env, ["--json"]))[0] ?? "",
    );
    // The page's 47 buttons and the standard fixture's two.
    assert.equal(document.buttons.total, 49);
    assert.equal(document.style.template, 49);
  });

  it("hides any numeric hold key and counts odd option values", async () => {
    const env = setup({}, (db: DatabaseSync) => {
      db.exec("DELETE FROM controls");
      insert(db, "controls", "bank:OddValues", {
        type: "button-layered",
        options: { canModifyStyleInApis: "yes" },
        steps: {
          "0": {
            action_sets: {
              "1500.5": [{ type: "action", definitionId: "a" }],
              "-20": [{ type: "action", definitionId: "b" }],
            },
          },
        },
      });
    });
    const result = await censusReadOnly(env, ["--json"]);
    const document = JSON.parse(ok(result)[0] ?? "");
    assert.deepEqual(document.steps.actionSets, { hold: t(1, 2) });
    assert.deepEqual(document.buttons.canModifyStyleInApis, {
      "(other)": 1,
      false: 0,
      missing: 0,
      true: 0,
    });
    assert.ok(!result.stdout[0]?.includes("1500"));
  });

  it("prints help", async () => {
    const result = await runCli(["census", "--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout.join("\n"), /census \[--db/);
  });

  it("refuses arguments and unknown options as usage errors", async () => {
    for (const args of [
      ["census", "extra"],
      ["census", "--bogus"],
      ["census", "--db", ""],
    ]) {
      const text = await runCli(args);
      assert.equal(text.code, 2);
      assert.match(text.stderr.join("\n"), /^error: /);
      const json = await runCli([...args, "--json"]);
      assert.equal(json.code, 2);
      assert.deepEqual(json.stderr, []);
      assert.equal(JSON.parse(json.stdout[0] ?? "").error.code, "usage");
    }
  });

  it("reports a missing database as a JSON error document", async () => {
    const env = setup();
    const result = await runCli([
      "census",
      "--db",
      `${env.dir}/nothing.sqlite`,
      "--json",
    ]);
    assert.equal(result.code, 1);
    assert.equal(
      JSON.parse(result.stdout[0] ?? "").error.code,
      "database_not_found",
    );
  });

  it("refuses an unsupported database version", async () => {
    const env = setup({ version: 16 });
    const result = await censusReadOnly(env, ["--json"]);
    assert.equal(result.code, 1);
    assert.equal(
      JSON.parse(result.stdout[0] ?? "").error.code,
      "unsupported_version",
    );
  });

  it("reads the install's database without touching the process", async () => {
    const home = tempDir();
    const dbPath = buildFixtureDb(installDir(home), { wal: true });
    const before = fileState(dbPath);
    const tmpdir = tempDir();
    const { control, calls } = forbiddenProcessControl();
    const result = await runCli(["census", "--json"], {
      homedir: home,
      processControl: control,
      tmpdir,
    });
    const document = JSON.parse(ok(result)[0] ?? "");
    assert.equal(document.database, null);
    // The fixture's three variables and the WAL-only one, read through the copied WAL files.
    assert.equal(document.variables.total, 4);
    assert.deepEqual(calls, []);
    assert.deepEqual(fileState(dbPath), before);
    assert.deepEqual(readdirSync(tmpdir), []);
  });

  it("--db naming the install's database reads it while Companion runs", async () => {
    const home = tempDir();
    const dbPath = buildFixtureDb(installDir(home), { wal: true });
    const before = fileState(dbPath);
    const fake = fakeProcessControl({ running: true });
    const result = await runCli(
      [
        "census",
        "--db",
        "~/" +
          join(
            "Library",
            "Application Support",
            "companion",
            "v5.1",
            "db.sqlite",
          ),
      ],
      { homedir: home, processControl: fake.control },
    );
    ok(result);
    assert.deepEqual(fake.calls, [], "the running check is never made");
    assert.deepEqual(fileState(dbPath), before);
  });
});
