import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { ApplyHooks } from "../src/core/apply.ts";
import { buildFixtureDb } from "./fixtures/companion-db.ts";
import {
  assertJsonTwin,
  type CliRun,
  customVariables,
  fakeProcessControl,
  type FakeProcessOptions,
  installDir,
  runCli,
  tempDir,
  writeDescription,
} from "./helpers.ts";

const VARIABLES_YAML = `kind: variables
variables:
  - name: json_one
    default: 1
`;

const NOW = () => new Date("2026-10-14T12:34:56.789Z");
const QUIT_HINT = "quit Companion and retry";
const NOT_CONFIGURED =
  "note: REST not configured; not waiting for Companion's API";

/** A temporary home with a fixture database at the install path. */
function fakeHome(yaml = VARIABLES_YAML) {
  const home = tempDir();
  const dbPath = buildFixtureDb(installDir(home), { wal: true });
  return { home, dbPath, file: writeDescription(home, yaml) };
}

/** The backup directory an apply at `NOW` creates for `dbPath`. */
function backupDir(dbPath: string): string {
  return join(dirname(dbPath), "companion-cli-backups", "20261014T123456789Z");
}

interface Scenario {
  name: string;
  process: FakeProcessOptions;
  /** `--db <install db>` instead of live-install mode. */
  db?: boolean;
  yaml?: string;
  hooks?: ApplyHooks;
  /** A file in the way of the backup root. */
  blockBackup?: boolean;
  /** `ROLLBACK` throws, as SQLite can when the rollback itself fails. */
  failRollback?: boolean;
  code: string;
  hint?: (backup: string) => string;
  path?: string;
  committed?: true;
  /** The error carries the backup directory. */
  backup?: true;
}

function setVersion(path: string, version: number) {
  const db = new DatabaseSync(path);
  db.prepare("UPDATE main SET value = ? WHERE id = 'page_config_version'").run(
    JSON.stringify(version),
  );
  db.close();
}

const BUTTON_YAML = `kind: button
location: { page: 1, row: 0, column: 0 }
text: x
background: "#000000"
down: [ { action: set, variable: fx_label, value: a } ]
`;

const unchanged = (backup: string) =>
  `the database is unchanged; the backup is at ${backup}`;

const writeFails: ApplyHooks = {
  afterWrite: () => {
    throw new Error("disk on fire");
  },
};

const SCENARIOS: Scenario[] = [
  {
    name: "--db names the install's database while Companion runs",
    process: { running: true },
    db: true,
    code: "companion_running",
    hint: () => QUIT_HINT,
  },
  {
    // Live-install mode: the listing that locates the install's database fails.
    name: "the running check fails",
    process: { running: true, failCheck: true },
    code: "companion_running",
    hint: () => "pass --db <path>",
  },
  {
    name: "another process holds the database after the quit",
    process: { running: true, holders: [999] },
    code: "companion_running",
    hint: () => QUIT_HINT,
  },
  {
    name: "the in-use check fails",
    process: { running: false, failHolders: true },
    code: "companion_running",
    hint: () => QUIT_HINT,
  },
  {
    name: "Companion cannot be quit",
    process: { running: true, failQuit: true },
    code: "companion_running",
    hint: () => QUIT_HINT,
  },
  {
    name: "Companion does not exit in time",
    process: { running: true, timeout: true },
    code: "quit_timeout",
    hint: () => QUIT_HINT,
  },
  {
    name: "the backup cannot be written",
    process: { running: true },
    blockBackup: true,
    code: "backup_failed",
  },
  {
    name: "the version guard under the write lock",
    process: { running: true },
    hooks: { afterBackup: (path) => setVersion(path, 18) },
    code: "unsupported_version",
    hint: () => "this tool supports Companion 5.1 (DB version 17) only",
    backup: true,
  },
  {
    name: "a writer check under the write lock",
    process: { running: true },
    yaml: BUTTON_YAML,
    hooks: {
      afterBackup: (path) => {
        const db = new DatabaseSync(path);
        db.prepare("DELETE FROM custom_variables WHERE id = 'fx_label'").run();
        db.close();
      },
    },
    code: "check_failed",
    path: "down[0].variable",
    hint: () => "run companion-cli list variables",
    backup: true,
  },
  {
    name: "the database cannot be opened for writing",
    process: { running: true },
    hooks: {
      afterBackup: (path) => {
        rmSync(path);
        mkdirSync(path);
      },
    },
    code: "write_failed",
    hint: unchanged,
    backup: true,
  },
  {
    name: "the write fails",
    process: { running: true },
    hooks: writeFails,
    code: "write_failed",
    hint: unchanged,
    backup: true,
  },
  {
    name: "the integrity check fails",
    process: { running: true },
    hooks: { integrityCheck: () => ["Page 3: corrupt"] },
    code: "write_failed",
    hint: unchanged,
    backup: true,
  },
  {
    name: "the write fails and Companion does not start again",
    process: { running: true, failStart: true },
    hooks: writeFails,
    code: "write_failed",
    hint: (backup) => `start Companion manually; ${unchanged(backup)}`,
    backup: true,
  },
  {
    name: "the write fails and so does the rollback",
    process: { running: true },
    hooks: writeFails,
    failRollback: true,
    code: "write_failed",
    hint: (backup) => `restore from the backup at ${backup}`,
    backup: true,
  },
  {
    name: "Companion cannot be quit and does not start again",
    process: { running: true, failQuit: true, failStart: true },
    code: "companion_running",
    hint: () => "start Companion manually; nothing was written",
  },
  {
    name: "the write commits and Companion does not start again",
    process: { running: true, failStart: true },
    code: "restart_failed",
    hint: () => "start Companion manually; the write is committed",
    committed: true,
    backup: true,
  },
];

/** Makes every `ROLLBACK` throw until the returned function restores it. */
function failRollbacks(): () => void {
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
    if (sql === "ROLLBACK") throw new Error("rollback exploded");
    return exec.call(this, sql);
  };
  return () => {
    DatabaseSync.prototype.exec = exec;
  };
}

async function runScenario(
  scenario: Scenario,
  json: boolean,
): Promise<CliRun & { home: string; dbPath: string }> {
  const { home, dbPath, file } = fakeHome(scenario.yaml);
  const extra: { backupRoot?: string } = {};
  if (scenario.blockBackup) {
    extra.backupRoot = join(home, "not-a-dir");
    writeFileSync(extra.backupRoot, "");
  }
  const fake = fakeProcessControl(scenario.process);
  const restore = scenario.failRollback ? failRollbacks() : () => {};
  const result = await runCli(
    [
      "apply",
      file,
      ...(scenario.db ? ["--db", dbPath] : []),
      ...(json ? ["--json"] : []),
    ],
    {
      homedir: home,
      processControl: fake.control,
      now: NOW,
      ...(scenario.hooks ? { hooks: scenario.hooks } : {}),
      ...extra,
    },
  ).finally(restore);
  return { ...result, home, dbPath };
}

describe("apply --json: every failure is one error document", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: ${scenario.code}`, async () => {
      const text = await runScenario(scenario, false);
      const json = await runScenario(scenario, true);
      const toText = (line: string) => line.replaceAll(json.home, text.home);
      assert.equal(text.code, 1);
      const doc = assertJsonTwin(text, json, toText);
      assert.equal(doc.code, scenario.code);
      const backup = backupDir(json.dbPath);
      assert.equal(doc.hint, scenario.hint?.(backup));
      assert.equal(doc.path, scenario.path);
      assert.equal(doc.committed, scenario.committed);
      assert.equal(doc.backup, scenario.backup ? backup : undefined);
      // Only the progress lines the text run prints on stdout reach stderr.
      assert.deepEqual(json.stderr.map(toText), text.stdout);
    });
  }

  it("restart_failed: the write is committed", async () => {
    const restart = SCENARIOS.find((s) => s.code === "restart_failed");
    assert.ok(restart);
    const json = await runScenario(restart, true);
    assert.ok(customVariables(json.dbPath)["json_one"]);
  });
});

describe("apply --json: a real apply prints one result document", () => {
  it("--db: live false, restarted false, the backup path; progress on stderr", async () => {
    const { home, dbPath, file } = fakeHome();
    const fake = fakeProcessControl({ running: false });
    const result = await runCli(["apply", file, "--db", dbPath, "--json"], {
      homedir: home,
      processControl: fake.control,
      now: NOW,
    });
    assert.equal(result.code, 0, result.stdout.join("\n"));
    assert.equal(result.stdout.length, 1);
    const backup = backupDir(dbPath);
    assert.deepEqual(JSON.parse(result.stdout[0] ?? ""), {
      applied: true,
      kind: "variables",
      summary: "custom variables: 1 created, 0 replaced",
      database: dbPath,
      databaseSource: null,
      live: false,
      backup,
      restarted: false,
      rest: null,
      warnings: [],
    });
    assert.deepEqual(result.stderr, [`backup: ${backup}`]);
    assert.deepEqual(fake.calls, ["check", "holders"]);
    assert.ok(customVariables(dbPath)["json_one"]);
  });

  it("live-install mode, Companion running: live and restarted true; progress on stderr only", async () => {
    const { home, dbPath, file } = fakeHome();
    const fake = fakeProcessControl({ running: true });
    const result = await runCli(["apply", file, "--json"], {
      homedir: home,
      processControl: fake.control,
      now: NOW,
    });
    assert.equal(result.code, 0, result.stdout.join("\n"));
    assert.equal(result.stdout.length, 1);
    const backup = backupDir(dbPath);
    assert.deepEqual(JSON.parse(result.stdout[0] ?? ""), {
      applied: true,
      kind: "variables",
      summary: "custom variables: 1 created, 0 replaced",
      database: dbPath,
      databaseSource: "default",
      live: true,
      backup,
      restarted: true,
      // The test environment has no REST settings.
      rest: "not_configured",
      warnings: [],
    });
    assert.deepEqual(result.stderr, [
      "quitting Companion",
      `backup: ${backup}`,
      "starting Companion",
      NOT_CONFIGURED,
    ]);
    // The first listing locates the install's database, the second precedes the quit.
    assert.deepEqual(fake.calls, [
      "check",
      "check",
      "quit",
      "wait",
      "holders",
      "start",
    ]);
  });

  it("live-install mode, Companion not running: restarted false", async () => {
    const { home, file } = fakeHome();
    const fake = fakeProcessControl({ running: false });
    const result = await runCli(["apply", file, "--json"], {
      homedir: home,
      processControl: fake.control,
      now: NOW,
    });
    assert.equal(result.code, 0, result.stdout.join("\n"));
    const doc = JSON.parse(result.stdout[0] ?? "") as Record<string, unknown>;
    assert.equal(doc["live"], true);
    assert.equal(doc["restarted"], false);
    assert.deepEqual(fake.calls, ["check", "check", "holders"]);
  });

  it("without --json: progress and the summary on stdout, as before", async () => {
    const { home, dbPath, file } = fakeHome();
    const fake = fakeProcessControl({ running: true });
    const result = await runCli(["apply", file], {
      homedir: home,
      processControl: fake.control,
      now: NOW,
    });
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, [
      "quitting Companion",
      `backup: ${backupDir(dbPath)}`,
      "starting Companion",
      NOT_CONFIGURED,
      "custom variables: 1 created, 0 replaced",
    ]);
    assert.deepEqual(result.stderr, []);
  });
});
