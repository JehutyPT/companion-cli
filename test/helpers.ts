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
import { join } from "node:path";
import { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { run } from "../src/cli.ts";
import {
  buildFixtureDb,
  type FixtureOptions,
} from "./fixtures/companion-db.ts";
import type { CliOptions } from "../src/cli.ts";
import type { ProcessControl } from "../src/core/process.ts";

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
 * A process control whose every method records its name in `calls` and then
 * fails the test, for runs that must never touch Companion's process.
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
  const control: ProcessControl = {
    serverPids: async () => {
      calls.push("check");
      if (options.failCheck) throw new Error("ps exploded");
      return options.running ? [4242] : [];
    },
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

/** `~/Library/Application Support/companion/v5.1` under `home`. */
export function installDir(home: string): string {
  return join(home, "Library", "Application Support", "companion", "v5.1");
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
    if (row.id.startsWith("bank:Fixture")) continue;
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

/** Applies `yaml` to the fixture with `apply --db`. */
export function applyTo(
  env: FixtureEnv,
  yaml: string,
  options: CliOptions = {},
): Promise<CliRun> {
  return runCli(
    ["apply", writeDescription(env.dir, yaml), "--db", env.dbPath],
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
