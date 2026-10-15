import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { WAL_ONLY_VARIABLE } from "./fixtures/companion-db.ts";
import {
  type CliRun,
  type FixtureEnv,
  fileState,
  forbiddenProcessControl,
  runCli,
  setup,
} from "./helpers.ts";

/**
 * Runs `list variables --db <fixture> [...args]` and checks what every read
 * must leave behind: the target files byte-identical, no temporary copy and
 * no process-control call.
 */
async function listVariables(
  env: FixtureEnv,
  args: string[] = [],
): Promise<CliRun> {
  const before = fileState(env.dbPath);
  const { control, calls } = forbiddenProcessControl();
  const result = await runCli(
    ["list", "variables", "--db", env.dbPath, ...args],
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

/**
 * `--db` skips current values (test/list-variables-current.test.ts covers
 * them), so every value is `-`/`null` and the output says why.
 */
const DB_NOTE = "current values are only read for the install's database";
const DB_NOTE_LINE = `note: ${DB_NOTE}`;
const SKIPPED = { values: "skipped", note: DB_NOTE };

const STANDARD_TEXT = [
  "NAME        DEFAULT  CURRENT  PERSIST  DESCRIPTION",
  "fx_counter  0        -        no       Counter",
  'fx_label    "idle"   -        yes      Label',
  'fx_gap      ""       -        no       A custom variable',
  DB_NOTE_LINE,
];

const STANDARD_JSON = [
  {
    name: "fx_counter",
    defaultValue: 0,
    currentValue: null,
    persistCurrentValue: false,
    description: "Counter",
    sortOrder: 0,
  },
  {
    name: "fx_label",
    defaultValue: "idle",
    currentValue: null,
    persistCurrentValue: true,
    description: "Label",
    sortOrder: 1,
  },
  {
    name: "fx_gap",
    defaultValue: "",
    currentValue: null,
    persistCurrentValue: false,
    description: "A custom variable",
    sortOrder: 5,
  },
];

function seed(db: DatabaseSync, name: string, value: unknown): void {
  db.prepare("INSERT INTO custom_variables (id, value) VALUES (?, ?)").run(
    name,
    JSON.stringify(value),
  );
}

describe("list variables", () => {
  it("lists the standard fixture in sortOrder, as text", async () => {
    const env = setup();
    assert.deepEqual(ok(await listVariables(env)), STANDARD_TEXT);
  });

  it("prints one JSON document with --json", async () => {
    const env = setup();
    const stdout = ok(await listVariables(env, ["--json"]));
    assert.equal(stdout.length, 1);
    assert.deepEqual(JSON.parse(stdout[0] ?? ""), {
      database: env.dbPath,
      variables: STANDARD_JSON,
      ...SKIPPED,
    });
  });

  it("gives byte-identical output on every run", async () => {
    const env = setup();
    for (const args of [[], ["--json"]]) {
      const first = ok(await listVariables(env, args));
      assert.deepEqual(ok(await listVariables(env, args)), first);
    }
  });

  it("filters by name patterns", async () => {
    const env = setup();
    assert.deepEqual(ok(await listVariables(env, ["fx_*"])), STANDARD_TEXT);
    assert.deepEqual(ok(await listVariables(env, ["fx_label"])), [
      "NAME      DEFAULT  CURRENT  PERSIST  DESCRIPTION",
      'fx_label  "idle"   -        yes      Label',
      DB_NOTE_LINE,
    ]);
    assert.deepEqual(ok(await listVariables(env, ["fx_gap", "*counter"])), [
      "NAME        DEFAULT  CURRENT  PERSIST  DESCRIPTION",
      "fx_counter  0        -        no       Counter",
      'fx_gap      ""       -        no       A custom variable',
      DB_NOTE_LINE,
    ]);
    assert.deepEqual(ok(await listVariables(env, ["nomatch*"])), [
      "NAME  DEFAULT  CURRENT  PERSIST  DESCRIPTION",
      DB_NOTE_LINE,
    ]);
    const json = ok(await listVariables(env, ["nomatch*", "--json"]));
    assert.deepEqual(JSON.parse(json[0] ?? ""), {
      database: env.dbPath,
      variables: [],
      ...SKIPPED,
    });
  });

  it("an empty table prints only the header, or an empty list", async () => {
    const env = setup({}, (db) => db.exec("DELETE FROM custom_variables"));
    assert.deepEqual(ok(await listVariables(env)), [
      "NAME  DEFAULT  CURRENT  PERSIST  DESCRIPTION",
      DB_NOTE_LINE,
    ]);
    const json = ok(await listVariables(env, ["--json"]));
    assert.deepEqual(JSON.parse(json[0] ?? ""), {
      database: env.dbPath,
      variables: [],
      ...SKIPPED,
    });
  });

  it('tells a string "0" from a number 0, cuts long values and shows line breaks', async () => {
    const long = "A description that is much longer than forty characters";
    const env = setup({}, (db) => {
      db.exec("DELETE FROM custom_variables");
      seed(db, "zero_number", { defaultValue: 0, sortOrder: 1 });
      seed(db, "zero_string", {
        defaultValue: "0",
        description: "two\nlines",
        sortOrder: 1,
      });
      seed(db, "long", { defaultValue: long, description: long, sortOrder: 0 });
      seed(db, "unordered", { defaultValue: true });
      seed(db, "not_an_object", "just text");
    });
    assert.deepEqual(ok(await listVariables(env)), [
      "NAME         DEFAULT                                   CURRENT  PERSIST  DESCRIPTION",
      'long         "A description that is much longer than…  -        no       A description that is much longer than …',
      "zero_number  0                                         -        no",
      'zero_string  "0"                                       -        no       two\\nlines',
      "unordered    true                                      -        no",
      DB_NOTE_LINE,
    ]);
    const json = JSON.parse(ok(await listVariables(env, ["--json"]))[0] ?? "");
    assert.deepEqual(json.variables, [
      {
        name: "long",
        defaultValue: long,
        currentValue: null,
        persistCurrentValue: false,
        description: long,
        sortOrder: 0,
      },
      {
        name: "zero_number",
        defaultValue: 0,
        currentValue: null,
        persistCurrentValue: false,
        description: "",
        sortOrder: 1,
      },
      {
        name: "zero_string",
        defaultValue: "0",
        currentValue: null,
        persistCurrentValue: false,
        description: "two\nlines",
        sortOrder: 1,
      },
      {
        name: "unordered",
        defaultValue: true,
        currentValue: null,
        persistCurrentValue: false,
        description: "",
        sortOrder: null,
      },
    ]);
  });

  it("sees a variable written only in the WAL file", async () => {
    const env = setup({ wal: true });
    const stdout = ok(await listVariables(env, ["fx_wal*"]));
    assert.deepEqual(stdout, [
      "NAME         DEFAULT  CURRENT  PERSIST  DESCRIPTION",
      "fx_wal_only  1        -        no       WAL only",
      DB_NOTE_LINE,
    ]);
    const json = JSON.parse(ok(await listVariables(env, ["--json"]))[0] ?? "");
    assert.deepEqual(json.variables.at(-1), {
      name: WAL_ONLY_VARIABLE.name,
      ...WAL_ONLY_VARIABLE.value,
      currentValue: null,
    });
  });
});
