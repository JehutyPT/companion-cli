import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { HELP, USAGE } from "../src/cli.ts";
import { apply } from "../src/core/apply.ts";
import { defaultBackupRoot } from "../src/core/backup.ts";
import { dryRun } from "../src/core/dry-run.ts";
import { writers } from "../src/writers/index.ts";
import {
  buildFixtureDb,
  FIXTURE_CONTROL_A,
  type FixtureOptions,
} from "./fixtures/companion-db.ts";
import {
  applyTo,
  type CliRun,
  dumpDatabase,
  fakeProcessControl,
  type FixtureEnv,
  fileState,
  forbiddenProcessControl,
  installDir,
  runCli,
  setup,
  STOPPED_PROCESS_CONTROL,
  stripIds,
  type TableDump,
  tempDir,
  writeDescription,
  assertJsonTwin,
  assertRefusalCode,
} from "./helpers.ts";
import type { CliOptions } from "../src/cli.ts";

/**
 * Writes `yaml` as the fixture's description file and runs
 * `apply <file> --db <db> --dry-run [...extra]` with a forbidden process
 * control, then checks what every dry run must leave behind: the target files
 * byte-identical, no backup directory and no temporary copy.
 */
async function dry(
  env: FixtureEnv,
  yaml: string,
  extra: string[] = [],
  options: CliOptions = {},
): Promise<CliRun> {
  const before = fileState(env.dbPath);
  const backups = () =>
    existsSync(env.backupRoot) ? readdirSync(env.backupRoot) : [];
  const backupsBefore = backups();
  const { control, calls } = forbiddenProcessControl();
  const result = await runCli(
    [
      "apply",
      writeDescription(env.dir, yaml),
      "--db",
      env.dbPath,
      "--dry-run",
      ...extra,
    ],
    { processControl: control, tmpdir: env.tmpdir, ...options },
  );
  assert.deepEqual(calls, [], "no process-control call");
  assert.deepEqual(fileState(env.dbPath), before, "target byte-identical");
  assert.equal(existsSync(defaultBackupRoot(env.dbPath)), false, "no backup");
  assert.deepEqual(backups(), backupsBefore, "no backup");
  assert.deepEqual(readdirSync(env.tmpdir), [], "temporary copies removed");
  return result;
}

/** A real `apply --db` of `yaml` that must succeed. */
async function realApply(env: FixtureEnv, yaml: string): Promise<CliRun> {
  const result = await applyTo(env, yaml);
  assert.equal(result.code, 0, result.stderr.join("\n"));
  assert.deepEqual(readdirSync(env.tmpdir), [], "snapshot copy removed");
  return result;
}

const summaryOf = (result: CliRun) => result.stdout.at(-1) ?? "";

function assertReport(
  result: CliRun,
  env: FixtureEnv,
  sections: string[],
): void {
  assert.equal(result.code, 0, result.stderr.join("\n"));
  assert.deepEqual(result.stderr, []);
  assert.deepEqual(result.stdout.slice(0, -1), [
    `dry run: nothing written to ${env.dbPath}`,
    ...sections,
  ]);
  assert.match(summaryOf(result), /^apply would report: /);
}

const VARIABLES_YAML = `kind: variables
variables:
  - name: fx_new
    default: 1
  - name: fx_label
    default: ready
    description: Replaced label
`;

const BUTTON_YAML = (
  text: string,
  location = "{ page: 1, row: 0, column: 0 }",
) =>
  `kind: button
location: ${location}
text: ${JSON.stringify(text)}
background: "#000080"
down: [ { action: increment, variable: fx_counter } ]
feedbacks:
  - feedback: expression
    expression: "$(custom:fx_label) == 'on'"
    style: { background: "#FFA500" }
`;

const PAGE_YAML = (page: number, text = "P") => `kind: page
page: ${page}
name: Page ${page}
buttons:
  - location: { row: 0, column: 0 }
    text: ${text}
    background: "#FF0000"
    down: [ { action: increment, variable: fx_counter } ]
  - location: { row: 1, column: 2 }
    text: Two
    background: "#00FF00"
`;

const TRIGGER_YAML = (seconds: number) => `kind: trigger
name: Tick
events:
  - { event: interval, seconds: ${seconds} }
  - { event: variable_changed, variable: fx_label }
actions:
  - { action: increment, variable: fx_counter }
`;

const BANK = "bank:[A-Za-z0-9_-]{21}";

describe("apply --dry-run: text report", () => {
  it("variables: lists the new name with + and the changed name with ~, then no changes after the apply", async () => {
    const env = setup();
    const file = VARIABLES_YAML;

    const result = await dry(env, file);
    assertReport(result, env, [
      "custom_variables: 1 added, 1 replaced, 0 removed",
      "  + fx_new",
      "  ~ fx_label",
    ]);

    const applied = await realApply(env, file);
    assert.equal(
      summaryOf(result),
      `apply would report: ${summaryOf(applied)}`,
    );

    const again = await dry(env, file);
    assertReport(again, env, ["no changes"]);
    assert.equal(
      summaryOf(again),
      "apply would report: custom variables: 0 created, 2 replaced",
    );
  });

  it("button: replacing an occupied cell lists + new id, - old id and the page cell", async () => {
    const env = setup();
    const file = BUTTON_YAML("Go");

    const result = await dry(env, file);
    const newId = new RegExp(`with (${BANK})$`).exec(summaryOf(result))?.[1];
    assert.ok(newId, summaryOf(result));
    assertReport(result, env, [
      "controls: 1 added, 0 replaced, 1 removed",
      `  + ${newId}`,
      `  - ${FIXTURE_CONTROL_A}`,
      "pages: 0 added, 1 replaced, 0 removed",
      `  ~ 1: cell 0/0 ${FIXTURE_CONTROL_A} -> ${newId}`,
    ]);
  });

  it("button: filling an empty cell lists + new id and the cell as - -> id, with no - line", async () => {
    const env = setup();
    const file = BUTTON_YAML("Go", "{ page: 1, row: 1, column: 0 }");

    const result = await dry(env, file);
    const newId = new RegExp(`created (${BANK})$`).exec(summaryOf(result))?.[1];
    assert.ok(newId, summaryOf(result));
    assertReport(result, env, [
      "controls: 1 added, 0 replaced, 0 removed",
      `  + ${newId}`,
      "pages: 0 added, 1 replaced, 0 removed",
      `  ~ 1: cell 1/0 - -> ${newId}`,
    ]);
  });

  it("button: a re-apply is no changes, and changed text under a new id is still reported", async () => {
    const env = setup();
    const file = BUTTON_YAML("Go");
    const applied = await realApply(env, file);
    const oldId = new RegExp(`with (${BANK})$`).exec(summaryOf(applied))?.[1];
    assert.ok(oldId);

    assertReport(await dry(env, file), env, ["no changes"]);

    const result = await dry(env, BUTTON_YAML("Stop"));
    const newId = new RegExp(`with (${BANK})$`).exec(summaryOf(result))?.[1];
    assert.ok(newId);
    assertReport(result, env, [
      "controls: 1 added, 0 replaced, 1 removed",
      `  + ${newId}`,
      `  - ${oldId}`,
      "pages: 0 added, 1 replaced, 0 removed",
      `  ~ 1: cell 0/0 ${oldId} -> ${newId}`,
    ]);
  });

  it("page: creating page 3 lists the gap page and the new page's name and cells; a re-apply is no changes", async () => {
    const env = setup();
    const file = PAGE_YAML(3);

    const result = await dry(env, file);
    const lines = result.stdout;
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(lines[1], "controls: 2 added, 0 replaced, 0 removed");
    assert.match(lines[2] ?? "", new RegExp(`^  \\+ ${BANK}$`));
    assert.match(lines[3] ?? "", new RegExp(`^  \\+ ${BANK}$`));
    assert.equal(lines[4], "pages: 2 added, 0 replaced, 0 removed");
    assert.equal(lines[5], '  + 2: name "PAGE"');
    assert.match(
      lines[6] ?? "",
      new RegExp(
        `^  \\+ 3: name "Page 3", cell 0/0 ${BANK}, cell 1/2 ${BANK}$`,
      ),
    );
    assert.match(
      lines[7] ?? "",
      /^apply would report: page 3 "Page 3": created; .*created 1 empty page: 2$/,
    );
    assert.equal(lines.length, 8);

    await realApply(env, file);
    assertReport(await dry(env, file), env, ["no changes"]);
  });

  it("page: replacing page 1 again with one changed button reports only that cell", async () => {
    const env = setup();
    await realApply(env, PAGE_YAML(1));
    const result = await dry(env, PAGE_YAML(1, "Q"));
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(result.stdout[1], "controls: 1 added, 0 replaced, 1 removed");
    assert.equal(result.stdout[4], "pages: 0 added, 1 replaced, 0 removed");
    assert.match(
      result.stdout[5] ?? "",
      new RegExp(`^  ~ 1: cell 0/0 ${BANK} -> ${BANK}$`),
    );
    assert.equal(result.stdout.length, 7);
  });

  it("trigger: a re-apply is no changes although event and action ids are fresh; a changed event is ~", async () => {
    const env = setup();
    const file = TRIGGER_YAML(5);

    const created = await dry(env, file);
    assert.equal(created.stdout[1], "controls: 1 added, 0 replaced, 0 removed");
    assert.match(created.stdout[2] ?? "", /^ {2}\+ trigger:[A-Za-z0-9_-]{21}$/);

    const applied = await realApply(env, file);
    const id = /created (trigger:\S+)$/.exec(summaryOf(applied))?.[1];
    assert.ok(id);
    assertReport(await dry(env, file), env, ["no changes"]);

    const result = await dry(env, TRIGGER_YAML(6));
    assertReport(result, env, [
      "controls: 0 added, 1 replaced, 0 removed",
      `  ~ ${id}`,
    ]);
  });

  it("accepts --dry-run in any position", async () => {
    const env = setup();
    const file = writeDescription(env.dir, VARIABLES_YAML);
    const { control, calls } = forbiddenProcessControl();
    const result = await runCli(
      ["--dry-run", "apply", "--db", env.dbPath, file],
      { processControl: control, tmpdir: env.tmpdir },
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(
      result.stdout[1],
      "custom_variables: 1 added, 1 replaced, 0 removed",
    );
    assert.deepEqual(calls, []);
  });
});

/** Generated ids (not the fixture's) in a value or key, replaced by `<id>`. */
function normalise(value: unknown): unknown {
  const text = JSON.stringify(stripIds(value)).replace(
    /(bank|trigger):(?!Fixture)[A-Za-z0-9_-]{21}(?![A-Za-z0-9_-])/g,
    "$1:<id>",
  );
  return JSON.parse(text);
}

interface Entry {
  key: string;
  before?: unknown;
  after?: unknown;
}
type Tables = Record<
  string,
  { added: Entry[]; changed: Entry[]; removed: Entry[] }
>;

/** The rows that changed between two dumps, keyed and valued as the JSON report is. */
function realChanges(before: TableDump, after: TableDump): Tables {
  const tables: Tables = {};
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  for (const name of names.filter((n) => n !== "sqlite_master")) {
    const was = new Map((before[name] ?? []).map((r) => [r.id, r.value]));
    const is = new Map((after[name] ?? []).map((r) => [r.id, r.value]));
    const changes = { added: [], changed: [], removed: [] } as Tables[string];
    for (const [key, value] of is) {
      if (!was.has(key)) changes.added.push({ key, after: JSON.parse(value) });
      else if (was.get(key) !== value)
        changes.changed.push({
          key,
          before: JSON.parse(was.get(key) as string),
          after: JSON.parse(value),
        });
    }
    for (const [key, value] of was) {
      if (!is.has(key))
        changes.removed.push({ key, before: JSON.parse(value) });
    }
    if (changes.added.length + changes.changed.length + changes.removed.length)
      tables[name] = changes;
  }
  return tables;
}

/** Tables with generated ids normalised and entries in a stable order. */
function comparable(tables: Tables): unknown {
  const sort = (entries: Entry[]) =>
    entries
      .map((entry) => normalise(entry) as Entry)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return Object.fromEntries(
    Object.entries(tables)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, t]) => [
        name,
        {
          added: sort(t.added),
          changed: sort(t.changed),
          removed: sort(t.removed),
        },
      ]),
  );
}

function parseJson(result: CliRun): Record<string, unknown> {
  assert.equal(result.code, 0, result.stderr.join("\n"));
  assert.deepEqual(result.stderr, []);
  assert.equal(result.stdout.length, 1, "exactly one stdout write");
  return JSON.parse(result.stdout[0] ?? "") as Record<string, unknown>;
}

/** Id order: whole numbers numerically, anything else by code unit. */
function byId(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) - Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertSchema(doc: Record<string, unknown>, env: FixtureEnv): void {
  assert.deepEqual(Object.keys(doc).sort(), [
    "changed",
    "database",
    "dryRun",
    "summary",
    "tables",
    "warnings",
  ]);
  assert.deepEqual(doc["warnings"], []);
  assert.equal(doc["dryRun"], true);
  assert.equal(doc["database"], env.dbPath);
  assert.equal(typeof doc["summary"], "string");
  const tables = doc["tables"] as Tables;
  assert.equal(doc["changed"], Object.keys(tables).length > 0);
  for (const table of Object.values(tables)) {
    assert.deepEqual(Object.keys(table).sort(), [
      "added",
      "changed",
      "removed",
    ]);
    const shapes: Array<[Entry[], string[]]> = [
      [table.added, ["after", "key"]],
      [table.changed, ["after", "before", "key"]],
      [table.removed, ["before", "key"]],
    ];
    for (const [entries, keys] of shapes) {
      for (const entry of entries) {
        assert.deepEqual(Object.keys(entry).sort(), keys);
        assert.equal(typeof entry.key, "string");
      }
      const order = entries.map((e) => e.key);
      assert.deepEqual(order, [...order].sort(byId));
    }
  }
}

describe("apply --dry-run --json", () => {
  const cases: Array<[string, string]> = [
    ["variables", VARIABLES_YAML],
    ["button replacing a cell", BUTTON_YAML("Go")],
    [
      "button filling a cell",
      BUTTON_YAML("Go", "{ page: 1, row: 2, column: 3 }"),
    ],
    ["page with a gap page", PAGE_YAML(3)],
    ["page replacing page 1", PAGE_YAML(1)],
    ["trigger", TRIGGER_YAML(5)],
  ];
  for (const [name, yaml] of cases) {
    it(`${name}: one document matching the schema, the text report and a real apply`, async () => {
      const env = setup();
      const file = yaml;

      const text = await dry(env, file);
      const doc = parseJson(await dry(env, file, ["--json"]));
      assertSchema(doc, env);
      assert.equal(doc["changed"], true);
      assert.equal(
        normalise(`apply would report: ${String(doc["summary"])}`),
        normalise(summaryOf(text)),
      );

      // The JSON lists the same keys as the text report's +, ~ and - lines.
      const tables = doc["tables"] as Tables;
      const fromText: string[] = [];
      let table = "";
      for (const line of text.stdout.slice(1, -1)) {
        const header = /^(\S+): /.exec(line);
        if (header) table = header[1] ?? "";
        else fromText.push(`${table} ${line.trim().replace(/: .*$/, "")}`);
      }
      const fromJson = Object.entries(tables).flatMap(([t, c]) => [
        ...c.added.map((e) => `${t} + ${e.key}`),
        ...c.changed.map((e) => `${t} ~ ${e.key}`),
        ...c.removed.map((e) => `${t} - ${e.key}`),
      ]);
      // Two dry runs generate different ids.
      assert.deepEqual(normalise(fromJson), normalise(fromText));

      // A real apply makes exactly the listed changes, generated ids aside.
      const before = dumpDatabase(env.dbPath);
      await realApply(env, file);
      const after = dumpDatabase(env.dbPath);
      assert.deepEqual(
        comparable(tables),
        comparable(realChanges(before, after)),
      );

      // A re-apply changes nothing.
      const again = parseJson(await dry(env, file, ["--json"]));
      assertSchema(again, env);
      assert.equal(again["changed"], false);
      assert.deepEqual(again["tables"], {});
    });
  }
});

describe("apply --dry-run: Companion is never touched", () => {
  /** A temporary home with a fixture database at the install path. */
  function fakeHome() {
    const home = tempDir();
    const dbPath = buildFixtureDb(installDir(home));
    return { home, dbPath, file: writeDescription(home, VARIABLES_YAML) };
  }

  for (const [mode, withDb] of [
    ["live-install mode", false],
    ["--db naming the install's database", true],
  ] as const) {
    it(`${mode}, Companion running: no process-control call, nothing written`, async () => {
      const { home, dbPath, file } = fakeHome();
      const tmp = tempDir();
      const before = fileState(dbPath);
      const { control, calls } = fakeProcessControl({ running: true });
      const result = await runCli(
        ["apply", file, "--dry-run", ...(withDb ? ["--db", dbPath] : [])],
        { homedir: home, processControl: control, tmpdir: tmp },
      );
      assert.equal(result.code, 0, result.stderr.join("\n"));
      assert.equal(result.stdout[0], `dry run: nothing written to ${dbPath}`);
      assert.deepEqual(calls, []);
      assert.deepEqual(fileState(dbPath), before);
      assert.equal(
        existsSync(join(installDir(home), "companion-cli-backups")),
        false,
      );
      assert.deepEqual(readdirSync(tmp), []);
      assert.ok(
        result.stdout.every(
          (line) => !/^(backup:|quitting|starting)/.test(line),
        ),
      );
    });
  }

  it("leaves -wal and -shm files byte-identical and sees WAL-only rows", async () => {
    const env = setup({ wal: true });
    const file =
      "kind: variables\nvariables:\n  - name: fx_wal_only\n    default: 2\n    description: WAL only\n";
    const result = await dry(env, file);
    // The WAL-only variable already exists: it is replaced, not added.
    assertReport(result, env, [
      "custom_variables: 0 added, 1 replaced, 0 removed",
      "  ~ fx_wal_only",
    ]);
  });
});

describe("apply --dry-run: refusals are apply's", () => {
  const cases: Array<[string, string, FixtureOptions?]> = [
    ["invalid YAML", "kind: [\n"],
    ["unknown kind", "kind: banana\n"],
    ["unknown field", "kind: variables\nvariables: []\nextra: 1\n"],
    ["unsupported DB version", VARIABLES_YAML, { version: 16 }],
    [
      "location outside the grid",
      BUTTON_YAML("x", "{ page: 1, row: 9, column: 0 }"),
    ],
    [
      "unknown variable",
      "kind: trigger\nname: T\nevents: [ { event: variable_changed, variable: nope } ]\n",
    ],
    ["missing page", BUTTON_YAML("x", "{ page: 7, row: 0, column: 0 }")],
  ];
  const codes: Record<string, string> = {
    "unsupported DB version": "unsupported_version",
  };
  for (const [name, yaml, fixture] of cases) {
    it(`${name}: apply's exit code and stderr line; with --json the same error document as apply --json`, async () => {
      const env = setup(fixture);
      const text = await dry(env, yaml);
      const json = await dry(env, yaml, ["--json"]);
      const real = await applyTo(env, yaml, {
        processControl: STOPPED_PROCESS_CONTROL,
      });
      const realJson = await applyTo(
        env,
        yaml,
        { processControl: STOPPED_PROCESS_CONTROL },
        ["--json"],
      );
      assert.equal(real.code, 1);
      assert.equal(real.stderr.length, 1);
      assert.doesNotMatch(real.stderr[0] ?? "", /nothing written; backup kept/);
      assert.equal(text.code, 1);
      assert.deepEqual(text.stdout, []);
      assert.deepEqual(text.stderr, real.stderr);
      const doc = assertJsonTwin(text, json);
      assert.deepEqual(json.stderr, []);
      assert.deepEqual(realJson.stdout, json.stdout);
      assert.deepEqual(realJson.stderr, []);
      if (codes[name]) assert.equal(doc.code, codes[name]);
      else assertRefusalCode(doc);
    });
  }

  it("a missing database or description file", async () => {
    const env = setup();
    const file = writeDescription(env.dir, VARIABLES_YAML);
    for (const argv of [
      ["apply", file, "--db", join(env.dir, "nope.sqlite")],
      ["apply", join(env.dir, "nope.yaml"), "--db", env.dbPath],
    ]) {
      const real = await runCli(argv);
      const result = await runCli([...argv, "--dry-run"], {
        processControl: forbiddenProcessControl().control,
      });
      const json = await runCli([...argv, "--dry-run", "--json"], {
        processControl: forbiddenProcessControl().control,
      });
      assert.equal(real.code, 1);
      assert.equal(result.code, 1);
      assert.deepEqual(result.stdout, []);
      assert.deepEqual(result.stderr, real.stderr);
      const doc = assertJsonTwin(result, json);
      assert.equal(
        doc.code,
        argv[1]?.endsWith("nope.yaml")
          ? "invalid_description"
          : "database_not_found",
      );
    }
  });

  it("live-install mode off macOS", async () => {
    const env = setup();
    const file = writeDescription(env.dir, VARIABLES_YAML);
    const real = await runCli(["apply", file], { platform: "linux" });
    const result = await runCli(["apply", file, "--dry-run"], {
      platform: "linux",
      processControl: forbiddenProcessControl().control,
    });
    assert.equal(result.code, 1);
    assert.deepEqual(result.stderr, real.stderr);
    assert.match(result.stderr[0] ?? "", /unsupported platform "linux"/);
    for (const extra of [[], ["--dry-run"]]) {
      const json = await runCli(["apply", file, ...extra, "--json"], {
        platform: "linux",
        processControl: forbiddenProcessControl().control,
      });
      const doc = assertJsonTwin(result, json);
      assert.equal(doc.code, "unsupported_platform");
      assert.equal(doc.hint, "pass --db <path>");
    }
  });

  it("a kind without a registered writer, through the core", async () => {
    const env = setup();
    const file = writeDescription(env.dir, TRIGGER_YAML(5));
    const { trigger: _trigger, ...registry } = writers;
    const request = {
      descriptionPath: file,
      dbPath: env.dbPath,
      writers: registry,
    };
    const expected = /kind: kind "trigger" is reserved and not supported yet/;
    await assert.rejects(dryRun(request, { tmpdir: env.tmpdir }), expected);
    return assert.rejects(
      apply(request, { processControl: STOPPED_PROCESS_CONTROL }),
      expected,
    );
  });
});

/**
 * Orphans an index's pages: `pragma integrity_check` then reports pages that
 * are never used, while every table still reads normally.
 */
function corruptIndex(db: DatabaseSync): void {
  db.exec("CREATE INDEX fixture_orphan ON custom_variables (value)");
  db.exec("PRAGMA writable_schema = ON");
  db.exec("DELETE FROM sqlite_master WHERE name = 'fixture_orphan'");
  db.exec("PRAGMA writable_schema = OFF");
}

describe("apply --dry-run: failures on the copy", () => {
  const failures: Array<
    [
      string,
      FixtureOptions,
      ((db: DatabaseSync) => void) | undefined,
      CliOptions,
      RegExp,
      string,
    ]
  > = [
    [
      "an inconsistent snapshot",
      {},
      corruptIndex,
      {},
      /^error: dry run: the database snapshot is inconsistent \(integrity check: .*never used.*\), perhaps copied while Companion was writing; nothing written\. Retry, or quit Companion and retry$/,
      "snapshot_inconsistent",
    ],
    [
      "a write failure",
      { wal: true },
      undefined,
      {
        hooks: {
          afterWrite: () => {
            throw new Error("disk exploded");
          },
        },
      },
      /^error: dry run: apply would fail: disk exploded; nothing written$/,
      "write_failed",
    ],
    [
      "a failed integrity check after the write",
      { wal: true },
      undefined,
      { hooks: { integrityCheck: () => ["row 3 missing from index"] } },
      /^error: dry run: apply would fail: integrity check failed: row 3 missing from index; nothing written$/,
      "write_failed",
    ],
  ];
  for (const [name, fixture, change, options, expected, code] of failures) {
    it(`${name}: exit 1, nothing written, copies removed; ${code} with --json`, async () => {
      const env = setup(fixture, change);
      const result = await dry(env, VARIABLES_YAML, [], options);
      assert.equal(result.code, 1);
      assert.deepEqual(result.stdout, []);
      assert.equal(result.stderr.length, 1);
      assert.match(result.stderr[0] ?? "", expected);
      const json = await dry(env, VARIABLES_YAML, ["--json"], options);
      const doc = assertJsonTwin(result, json);
      assert.deepEqual(json.stderr, []);
      assert.equal(doc.code, code);
      assert.equal(doc.backup, undefined, "a dry run takes no backup");
      if (code === "write_failed") assert.equal(doc.hint, undefined);
    });
  }

  it("the pre-write check on the copy is not the integrityCheck hook", async () => {
    const env = setup();
    let calls = 0;
    const result = await dry(env, VARIABLES_YAML, [], {
      hooks: {
        integrityCheck: () => {
          calls += 1;
          return ["ok"];
        },
      },
    });
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(calls, 1, "the hook replaces only the post-write check");
  });
});

describe("apply --dry-run: temporary copies", () => {
  it("both the read-only snapshot and the dry-run copy go under the tmpdir option", async () => {
    const env = setup();
    const missing = join(env.tmpdir, "missing");
    const real = await applyTo(env, VARIABLES_YAML, { tmpdir: missing });
    assert.equal(real.code, 1, "apply's snapshot uses the tmpdir option");
    assert.match(real.stderr[0] ?? "", /ENOENT/);
    const result = await dry(env, VARIABLES_YAML, [], { tmpdir: missing });
    assert.equal(result.code, 1);
    assert.match(result.stderr[0] ?? "", /ENOENT/);
  });
});

describe("apply --dry-run: stored values are compared as parsed JSON", () => {
  it("a custom variable stored with other whitespace and key order is unchanged", async () => {
    const env = setup({}, (db) =>
      db
        .prepare(
          "UPDATE custom_variables SET value = ? WHERE id = 'fx_counter'",
        )
        .run(
          '{ "sortOrder": 0, "persistCurrentValue": false, "defaultValue": 0, "description": "Counter" }',
        ),
    );
    const result = await dry(
      env,
      "kind: variables\nvariables:\n  - name: fx_counter\n    default: 0\n    description: Counter\n",
    );
    assertReport(result, env, ["no changes"]);
  });
});

describe("apply --dry-run: command line", () => {
  it("usage errors with --json are one usage document on stdout, exit 2", async () => {
    const dir = tempDir();
    const file = join(dir, "missing.yaml");
    const cases = [
      ["apply", "--json"],
      ["apply", file, "extra", "--dry-run", "--json"],
      ["apply", file, "--db", "", "--json"],
      ["apply", file, "--dry-run=yes", "--json"],
      ["apply", file, "--bogus", "--json"],
      ["--json", "apply", file, "--db"],
    ];
    for (const argv of cases) {
      const control = forbiddenProcessControl();
      const text = await runCli(
        argv.filter((arg) => arg !== "--json"),
        { processControl: control.control },
      );
      const json = await runCli(argv, { processControl: control.control });
      assert.equal(text.code, 2, argv.join(" "));
      const doc = assertJsonTwin(text, json);
      assert.deepEqual(json.stderr, []);
      assert.equal(doc.code, "usage");
      assert.equal(doc.hint, USAGE);
      assert.deepEqual(control.calls, []);
    }
  });

  it("a value given to --dry-run exits 2", async () => {
    const dir = tempDir();
    const result = await runCli([
      "apply",
      join(dir, "missing.yaml"),
      "--dry-run=yes",
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr[0] ?? "", /--dry-run/);
  });

  it("usage and help show the flags; help says a dry run writes nothing and never stops or starts Companion", async () => {
    assert.match(
      USAGE,
      /apply <description-file> \[--db <path-to-db\.sqlite>\] \[--dry-run\] \[--json\]/,
    );
    assert.match(HELP, /\[--dry-run\] \[--json\]/);
    assert.match(
      HELP,
      /apply --json prints the result[\s\S]*JSON error document[\s\S]*progress lines go to stderr/,
    );
    assert.match(
      HELP,
      /dry-run[\s\S]*writes nothing[\s\S]*never stops or starts Companion/,
    );
    const result = await runCli(["apply", "--dry-run", "--help"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, [HELP]);
  });
});

describe("apply --dry-run: generated-id masking never hides option changes", () => {
  const A = "A".repeat(21);
  const B = "B".repeat(21);
  const passthroughAction = (id: string) =>
    `[ { action: passthrough, connection: FixtureConnectionAAAA, definition: run, options: { target: { id: ${id} } } } ]`;
  const cases: Array<[string, (id: string) => string, RegExp]> = [
    [
      "button pass-through action",
      (id) =>
        `kind: button\nlocation: { page: 1, row: 0, column: 0 }\ntext: x\nbackground: "#000000"\ndown: ${passthroughAction(id)}\n`,
      new RegExp(`^ {2}\\+ ${BANK}$`),
    ],
    [
      "button pass-through feedback",
      (id) =>
        `kind: button\nlocation: { page: 1, row: 0, column: 0 }\ntext: x\nbackground: "#000000"\nfeedbacks:\n  - feedback: passthrough\n    connection: FixtureConnectionAAAA\n    definition: watch\n    options: { target: { id: ${id} } }\n    style: { text: "ON" }\n`,
      new RegExp(`^ {2}\\+ ${BANK}$`),
    ],
    [
      "trigger pass-through action",
      (id) =>
        `kind: trigger\nname: Tick\nevents: [ { event: interval, seconds: 5 } ]\nactions: ${passthroughAction(id)}\n`,
      /^ {2}~ trigger:[A-Za-z0-9_-]{21}$/,
    ],
  ];
  for (const [name, yaml, line] of cases) {
    it(`${name}: a 21-character id inside options is a change`, async () => {
      const env = setup();
      await realApply(env, yaml(A));
      assertReport(await dry(env, yaml(A)), env, ["no changes"]);
      const result = await dry(env, yaml(B));
      assert.equal(result.code, 0, result.stderr.join("\n"));
      assert.notEqual(result.stdout[1], "no changes");
      assert.match(result.stdout[2] ?? "", line);
    });
  }
});
