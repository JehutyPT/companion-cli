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
import type { CliOptions } from "../src/cli.ts";

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
 * Runs the CLI in-process, with a temp home directory unless one is given.
 * The environment defaults to empty and the working directory to a temp
 * directory, so a test never reads the developer's `COMPANION_*` variables or
 * the repository's `.env.local`.
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
    { homedir: tempDir(), env: {}, cwd: tempDir(), ...options },
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
