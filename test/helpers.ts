import "./setup.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { run } from "../src/cli.ts";
import {
  buildFixtureDb,
  type FixtureOptions,
} from "./fixtures/companion-db.ts";
import type { CliOptions } from "../src/cli.ts";
import type { CompanionServer, ProcessControl } from "../src/core/process.ts";

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "companion-cli-test-"));
  tempDirs.push(dir);
  return dir;
}

export function writeDescription(
  dir: string,
  yaml: string,
  name = "description.yaml",
): string {
  const path = join(dir, name);
  writeFileSync(path, yaml);
  return path;
}

export interface CliRun {
  code: number;
  stdout: string[];
  stderr: string[];
}

/**
 * The default process control for tests: Companion is not running and nothing
 * holds the database, and quitting, waiting or starting fails the test. A test
 * that expects those calls passes a fake, so no test can reach the real
 * Companion.
 */
export const STOPPED_PROCESS_CONTROL: ProcessControl = {
  servers: async () => [],
  serverPids: async () => [],
  databaseHolders: async () => [],
  quit: () => forbidden("quit"),
  waitForExit: () => forbidden("waitForExit"),
  start: () => forbidden("start"),
};

function forbidden(name: string): never {
  throw new Error(`test reached the process control (${name}) without a fake`);
}

/**
 * A process control for runs that must never touch Companion's process:
 * every method but `servers` records its name in `calls` and then fails the
 * test. `servers` reports none running without recording: listing is
 * read-only, and every command without `--db` lists the servers to find the
 * install's configuration root.
 */
export function forbiddenProcessControl(): {
  control: ProcessControl;
  calls: string[];
} {
  const calls: string[] = [];
  const refuse = (name: string): never => {
    calls.push(name);
    return forbidden(name);
  };
  return {
    calls,
    control: {
      servers: async () => [],
      serverPids: () => refuse("serverPids"),
      databaseHolders: () => refuse("databaseHolders"),
      quit: () => refuse("quit"),
      waitForExit: () => refuse("waitForExit"),
      start: () => refuse("start"),
    },
  };
}

export interface FakeProcessOptions {
  /** Whether the server is running when the apply begins. */
  running: boolean;
  /** The running server's install folder (Windows: holds `resources\BUILD`). */
  install?: string;
  /**
   * The running server's `--config-dir` (as written on its command line, so
   * it may end in a separator). Without it the command line names none.
   */
  configDir?: string;
  /** Shared call log; tests push pipeline steps into the same array. */
  calls?: string[];
  failCheck?: boolean;
  /** PIDs holding the database file when the in-use check runs. */
  holders?: readonly number[];
  failHolders?: boolean;
  failQuit?: boolean;
  failWait?: boolean;
  timeout?: boolean;
  failStart?: boolean;
}

/** A fake process control recording `check`, `holders`, `quit`, `wait` and `start`. */
export function fakeProcessControl(options: FakeProcessOptions): {
  control: ProcessControl;
  calls: string[];
  waitedFor: number[][];
  timeouts: number[];
} {
  const calls = options.calls ?? [];
  const waitedFor: number[][] = [];
  const timeouts: number[] = [];
  const servers = async (): Promise<CompanionServer[]> => {
    calls.push("check");
    if (options.failCheck) throw new Error("ps exploded");
    if (!options.running) return [];
    const install = options.install ?? null;
    const configDir =
      options.configDir === undefined
        ? ""
        : ` --config-dir=${options.configDir} --admin-port=8000`;
    return [
      {
        pid: 4242,
        commandLine:
          (install === null
            ? "node main.js"
            : `"${win32.join(install, "resources", "node-runtimes", "node26", "node.exe")}" "${win32.join(install, "resources", "main.js")}"`) +
          configDir,
        install,
        sessionId: 1,
        launcher: { pid: 4241, path: null, sessionId: 1 },
      },
    ];
  };
  const control: ProcessControl = {
    servers,
    serverPids: async () => (await servers()).map((server) => server.pid),
    databaseHolders: async () => {
      calls.push("holders");
      if (options.failHolders) throw new Error("lsof exploded");
      return [...(options.holders ?? [])];
    },
    quit: async () => {
      calls.push("quit");
      if (options.failQuit) throw new Error("osascript failed");
    },
    waitForExit: async (pids, timeoutMs) => {
      calls.push("wait");
      if (options.failWait) throw new Error("ps vanished");
      waitedFor.push([...pids]);
      timeouts.push(timeoutMs);
      return !options.timeout;
    },
    start: async () => {
      calls.push("start");
      if (options.failStart) throw new Error("open failed");
    },
  };
  return { control, calls, waitedFor, timeouts };
}

/**
 * `~/Library/Application Support/companion/v5.1` under `home`: the macOS
 * layout, with host path rules.
 */
export function installDir(home: string): string {
  return join(home, "Library", "Application Support", "companion", "v5.1");
}

/**
 * `<appData>\companion\v5.1`: the Windows layout, with Windows path rules, so
 * it is a real directory on a Windows host only.
 */
export function windowsInstallDir(appData: string): string {
  return win32.join(appData, "companion", "v5.1");
}

/** Skips a test that needs a Windows install's files on disk off Windows. */
export const WINDOWS_HOST_ONLY =
  process.platform === "win32"
    ? false
    : "Windows install paths use Windows path rules: run by the Windows CI job";

/**
 * A regular-expression source matching `join(...segments)` literally, so a
 * path assertion uses the host's separator instead of a literal `/`.
 */
export function pathPattern(...segments: string[]): string {
  return join(...segments).replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/**
 * Runs the CLI in-process, with a temp home directory unless one is given.
 * The environment defaults to empty and the working directory to a temp
 * directory, so a test never reads the developer's `COMPANION_*` variables or
 * the repository's `.env.local`. The platform defaults to macOS and the
 * process control to `STOPPED_PROCESS_CONTROL`, so no test can fall back to
 * the real home or the real Companion process.
 */
export async function runCli(
  argv: string[],
  options: CliOptions = {},
): Promise<CliRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    argv,
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    {
      env: {},
      cwd: tempDir(),
      platform: "darwin",
      ...options,
      homedir: options.homedir ?? tempDir(),
      processControl: options.processControl ?? STOPPED_PROCESS_CONTROL,
      // Never the real /Applications bundle: a test that needs one passes it.
      // On Windows the build file comes from the (fake) running server's
      // install, unless the test passes one.
      ...(options.companionBuildFile !== undefined ||
      (options.platform ?? "darwin") !== "win32"
        ? {
            companionBuildFile:
              options.companionBuildFile ?? join(tempDir(), "missing-BUILD"),
          }
        : {}),
    },
  );
  return { code, stdout, stderr };
}

/** sha256 of db.sqlite, -wal and -shm (null when absent). */
export function fileState(dbPath: string): Record<string, string | null> {
  const state: Record<string, string | null> = {};
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = dbPath + suffix;
    state[`db.sqlite${suffix}`] = existsSync(path)
      ? createHash("sha256").update(readFileSync(path)).digest("hex")
      : null;
  }
  return state;
}

export type TableDump = Record<string, Array<{ id: string; value: string }>>;

/**
 * Every table's rows (and the schema), read from a copy so that reading never
 * touches the files under test.
 */
export function dumpDatabase(dbPath: string): TableDump {
  const dir = tempDir();
  const copy = join(dir, "db.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(dbPath + suffix))
      copyFileSync(dbPath + suffix, copy + suffix);
  }
  const db = new DatabaseSync(copy, { readOnly: true });
  try {
    const dump: TableDump = {};
    dump["sqlite_master"] = db
      .prepare(
        "SELECT name AS id, sql AS value FROM sqlite_master ORDER BY name",
      )
      .all()
      .map((row) => ({ id: String(row["id"]), value: String(row["value"]) }));
    for (const { id: table } of dump["sqlite_master"]) {
      if (
        !dump["sqlite_master"].some(
          (row) => row.id === table && row.value.startsWith("CREATE TABLE"),
        )
      )
        continue;
      dump[table] = db
        .prepare(`SELECT id, value FROM ${table} ORDER BY id`)
        .all()
        .map((row) => ({ id: String(row["id"]), value: String(row["value"]) }));
    }
    return dump;
  } finally {
    db.close();
  }
}

export function customVariables(dbPath: string): Record<string, unknown> {
  const rows = dumpDatabase(dbPath)["custom_variables"] ?? [];
  return Object.fromEntries(rows.map((row) => [row.id, JSON.parse(row.value)]));
}

/** The backup directory path printed by apply. */
export function printedBackupDir(result: CliRun): string | undefined {
  const line = result.stdout.find((l) => l.startsWith("backup: "));
  return line?.slice("backup: ".length);
}

/** A generated nanoid-style id, and a button control id. */
export const ID = /^[A-Za-z0-9_-]{21}$/;
export const CONTROL_ID = /^bank:[A-Za-z0-9_-]{21}$/;

export type Json = Record<string, unknown>;

export function rows(dump: TableDump, table: string): Map<string, Json> {
  return new Map(
    (dump[table] ?? []).map((row) => [row.id, JSON.parse(row.value) as Json]),
  );
}

export function page(dump: TableDump, id = "1"): Json {
  const value = rows(dump, "pages").get(id);
  assert.ok(value, `pages row ${id}`);
  return value;
}

export function withoutTables(dump: TableDump, ...tables: string[]): TableDump {
  return Object.fromEntries(
    Object.entries(dump).filter(([table]) => !tables.includes(table)),
  );
}

/** Every table except `tables` is unchanged between two dumps. */
export function assertTablesUnchangedExcept(
  before: TableDump,
  after: TableDump,
  ...tables: string[]
): void {
  assert.deepEqual(
    withoutTables(after, ...tables),
    withoutTables(before, ...tables),
  );
}

/** A wrapped option value, as Companion stores options in actions and feedbacks. */
export const prop = (value: unknown, isExpression = false) => ({
  value,
  isExpression,
});

/**
 * Replaces generated control, action, feedback and override ids everywhere in
 * a dump (including page cells), so two applies can be compared.
 */
export function normaliseIds(dump: TableDump): TableDump {
  const generated = new Set<string>();
  for (const row of dump["controls"] ?? []) {
    // Fixture controls, and controls already named by their cell (`normaliseControls`).
    if (/^bank:(Fixture|@)/.test(row.id)) continue;
    generated.add(row.id);
    for (const id of generatedIds(JSON.parse(row.value))) generated.add(id);
  }
  const replace = (text: string) => {
    let out = text;
    for (const id of generated) out = out.split(id).join("<id>");
    return out;
  };
  return Object.fromEntries(
    Object.entries(dump).map(([table, tableRows]) => [
      table,
      tableRows
        .map((row) => ({ id: replace(row.id), value: replace(row.value) }))
        .sort((a, b) => (a.id + a.value).localeCompare(b.id + b.value, "en")),
    ]),
  );
}

/** Replaces every `id` and `overrideId` with "<id>" after checking its format. */
export function stripIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripIds);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (
          (key === "id" || key === "overrideId") &&
          typeof child === "string" &&
          ID.test(child)
        )
          return [key, "<id>"];
        return [key, stripIds(child)];
      }),
    );
  }
  return value;
}

/** Every generated `id` and `overrideId` in a control. */
export function generatedIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(generatedIds);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      (key === "id" || key === "overrideId") &&
      typeof child === "string" &&
      ID.test(child)
        ? [child]
        : generatedIds(child),
    );
  }
  return [];
}

export interface FixtureEnv {
  dir: string;
  dbPath: string;
  backupRoot: string;
  /** Root for the pipeline's temporary database copies; empty after every run. */
  tmpdir: string;
}

/**
 * A fixture database in a temp directory, with a backup root next to it.
 * `change` edits the fixture before the test runs.
 */
export function setup(
  options: FixtureOptions = {},
  change?: (db: DatabaseSync) => void,
): FixtureEnv {
  const dir = tempDir();
  const dbPath = buildFixtureDb(join(dir, "install"), options);
  if (change) {
    const db = new DatabaseSync(dbPath);
    change(db);
    db.close();
  }
  return { dir, dbPath, backupRoot: join(dir, "backups"), tmpdir: tempDir() };
}

/** Applies `yaml` to the fixture with `apply --db`, then any `extra` arguments. */
export function applyTo(
  env: FixtureEnv,
  yaml: string,
  options: CliOptions = {},
  extra: string[] = [],
): Promise<CliRun> {
  return runCli(
    ["apply", writeDescription(env.dir, yaml), "--db", env.dbPath, ...extra],
    { backupRoot: env.backupRoot, tmpdir: env.tmpdir, ...options },
  );
}

/** A fresh fixture, its dump before the apply, and the apply's result. */
export async function applyYaml(
  yaml: string,
  options: FixtureOptions = {},
  change?: (db: DatabaseSync) => void,
) {
  const env = setup(options, change);
  const before = dumpDatabase(env.dbPath);
  const result = await applyTo(env, yaml);
  return { ...env, before, result };
}

/**
 * Orphans an index's pages: `pragma integrity_check` then reports pages that
 * are never used, while every table still reads normally.
 */
export function corruptIndex(db: DatabaseSync): void {
  db.exec("CREATE INDEX fixture_orphan ON custom_variables (value)");
  db.exec("PRAGMA writable_schema = ON");
  db.exec("DELETE FROM sqlite_master WHERE name = 'fixture_orphan'");
  db.exec("PRAGMA writable_schema = OFF");
}

/** The `error` object of a JSON error document. */
export interface ErrorDocument {
  code: string;
  message: string;
  path?: string;
  hint?: string;
  items?: unknown;
  committed?: boolean;
  backup?: string;
}

/**
 * Asserts that `json` is the `--json` twin of the failed run `text`: the same
 * exit code, exactly one error document on stdout whose `message` is the text
 * run's `error: ` line without the prefix, no `error: ` line on stderr (only
 * progress lines), and a code other than `unexpected`. Returns the document.
 * The two runs may use different directories when `normalise` maps them.
 */
export function assertJsonTwin(
  text: CliRun,
  json: CliRun,
  /** Maps the JSON run's message onto the text run's, e.g. another home. */
  normalise: (message: string) => string = (message) => message,
): ErrorDocument {
  const line = text.stderr.find((l) => l.startsWith("error: "));
  assert.ok(line, `the text run fails with an error line: ${text.stderr}`);
  assert.notEqual(text.code, 0);
  assert.equal(json.code, text.code);
  assert.equal(json.stdout.length, 1, json.stdout.join("\n"));
  const doc = JSON.parse(json.stdout[0] ?? "") as { error: ErrorDocument };
  assert.deepEqual(Object.keys(doc), ["error"]);
  assert.equal(normalise(doc.error.message), line.slice("error: ".length));
  assert.deepEqual(
    json.stderr.filter((l) => l.startsWith("error: ")),
    [],
    "no error line on stderr",
  );
  assert.notEqual(doc.error.code, "unexpected", doc.error.message);
  return doc.error;
}

/**
 * The code a refusal before any write gets: `invalid_description` for the
 * description file on its own, `check_failed` for the database refusing it.
 * Also asserts that a `path` is the field the message names.
 */
export function assertRefusalCode(doc: ErrorDocument): void {
  const description =
    /^(invalid description .*?: |invalid YAML |cannot read description )/;
  const match = description.exec(doc.message);
  assert.equal(
    doc.code,
    match ? "invalid_description" : "check_failed",
    doc.message,
  );
  if (doc.path !== undefined) {
    const reason = match ? doc.message.slice(match[0].length) : doc.message;
    assert.ok(
      reason.startsWith(`${doc.path}: `),
      `path ${doc.path} names the field in: ${doc.message}`,
    );
  }
}
