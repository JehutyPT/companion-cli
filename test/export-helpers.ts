/**
 * The export round-trip oracle and refusal assertions, shared by the export
 * tests (ADR 0006).
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseDocument } from "yaml";
import {
  type CliRun,
  dumpDatabase,
  type FixtureEnv,
  fileState,
  forbiddenProcessControl,
  type Json,
  normaliseIds,
  runCli,
  stripIds,
  type TableDump,
  tempDir,
  writeDescription,
} from "./helpers.ts";
import { agreement } from "./schema-check.ts";

/** `value` with every object's keys sorted, so key order does not count. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Json)[key])]),
  );
}

/**
 * `normaliseIds`, and also every control id named by its page cell
 * (`bank:@<page>/<row>/<column>`) and every `id` and `overrideId` inside
 * controls and pages masked and their keys sorted (key order is not
 * content; the dry run compares parsed values too), so a page apply that replaces the fixture's own
 * `bank:Fixture…` controls with fresh ids compares equal.
 */
export function normaliseControls(dump: TableDump): TableDump {
  const located = new Map<string, string>();
  for (const { id: page, value } of dump["pages"] ?? []) {
    const controls = (JSON.parse(value) as Json)["controls"];
    if (controls === null || typeof controls !== "object") continue;
    for (const [row, columns] of Object.entries(controls as Json)) {
      if (columns === null || typeof columns !== "object") continue;
      for (const [column, id] of Object.entries(columns as Json))
        if (typeof id === "string")
          located.set(id, `bank:@${page}/${row}/${column}`);
    }
  }
  const replace = (text: string) => {
    let out = text;
    for (const [id, location] of located) out = out.split(id).join(location);
    return out;
  };
  const normalised = Object.fromEntries(
    Object.entries(dump).map(([table, tableRows]) => [
      table,
      tableRows.map(({ id, value }) => ({
        id: replace(id),
        value:
          table === "controls" || table === "pages"
            ? JSON.stringify(sortKeys(stripIds(JSON.parse(replace(value)))))
            : replace(value),
      })),
    ]),
  );
  return normaliseIds(normalised);
}

/** Runs `export …` on the fixture, proving it read-only. */
export async function exportFrom(
  env: FixtureEnv,
  args: string[],
): Promise<CliRun> {
  const before = fileState(env.dbPath);
  const { control, calls } = forbiddenProcessControl();
  const result = await runCli(["export", ...args, "--db", env.dbPath], {
    processControl: control,
    tmpdir: env.tmpdir,
  });
  assert.deepEqual(calls, [], "no process-control call");
  assert.deepEqual(fileState(env.dbPath), before, "target byte-identical");
  assert.deepEqual(readdirSync(env.tmpdir), [], "temporary copy removed");
  return result;
}

export function ok(result: CliRun): string {
  assert.equal(result.code, 0, result.stderr.join("\n"));
  assert.deepEqual(result.stderr, []);
  return result.stdout.map((line) => `${line}\n`).join("");
}

/** A copy of the fixture database (and its WAL files) in a new directory. */
export function copyEnv(env: FixtureEnv): FixtureEnv {
  const dir = tempDir();
  const dbPath = join(dir, "db.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(env.dbPath + suffix))
      copyFileSync(env.dbPath + suffix, dbPath + suffix);
  }
  return { dir, dbPath, backupRoot: join(dir, "backups"), tmpdir: tempDir() };
}

/** The file round-trips: no dry-run change, and an apply to a copy changes nothing. */
export async function assertRoundTrip(
  env: FixtureEnv,
  file: string,
): Promise<void> {
  const dry = await runCli(
    ["apply", file, "--db", env.dbPath, "--dry-run", "--json"],
    { tmpdir: env.tmpdir },
  );
  assert.equal(dry.code, 0, dry.stderr.join("\n"));
  const report = JSON.parse(dry.stdout.join("\n"));
  assert.equal(report.changed, false, JSON.stringify(report.tables));

  const copy = copyEnv(env);
  const applied = await runCli(["apply", file, "--db", copy.dbPath], {
    backupRoot: copy.backupRoot,
    tmpdir: copy.tmpdir,
  });
  assert.equal(applied.code, 0, applied.stderr.join("\n"));
  assert.deepEqual(
    normaliseControls(dumpDatabase(copy.dbPath)),
    normaliseControls(dumpDatabase(env.dbPath)),
  );
}

/**
 * Exports as YAML and as JSON, checks both parse cleanly and repeat
 * byte-identically, and round-trips both. Returns the YAML text.
 */
export async function exportRoundTrip(
  env: FixtureEnv,
  args: string[],
): Promise<string> {
  const yaml = ok(await exportFrom(env, args));
  assert.equal(ok(await exportFrom(env, args)), yaml, "byte-identical");
  const doc = parseDocument(yaml, { uniqueKeys: true });
  assert.deepEqual(doc.errors, []);
  assert.deepEqual(doc.warnings, []);
  assert.deepEqual(agreement(doc.toJS()), { schema: true, parser: true });
  const json = ok(await exportFrom(env, [...args, "--json"]));
  assert.deepEqual(JSON.parse(json), doc.toJS());
  await assertRoundTrip(env, writeDescription(env.dir, yaml, "export.yaml"));
  await assertRoundTrip(env, writeDescription(env.dir, json, "export.json"));
  return yaml;
}

/** Rewrites one stored row's JSON value. */
export function mutate(
  db: DatabaseSync,
  table: string,
  id: string,
  change: (value: Json) => unknown,
): void {
  const row = db.prepare(`SELECT value FROM ${table} WHERE id = ?`).get(id);
  assert.ok(row, `${table} ${id}`);
  db.prepare(`UPDATE ${table} SET value = ? WHERE id = ?`).run(
    JSON.stringify(change(JSON.parse(String(row["value"])))),
    id,
  );
}

export function insert(
  db: DatabaseSync,
  table: string,
  id: string,
  value: unknown,
) {
  db.prepare(`INSERT INTO ${table} (id, value) VALUES (?, ?)`).run(
    id,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

/** One refusal: exit 1, one stderr line, nothing on stdout; and the JSON envelope. */
export async function assertRefused(
  env: FixtureEnv,
  args: string[],
  line: string,
  path: string,
  hint?: string,
): Promise<Json> {
  const text = await exportFrom(env, args);
  assert.equal(text.code, 1);
  assert.deepEqual(text.stdout, []);
  assert.deepEqual(text.stderr, [`error: ${line}`]);
  const json = await exportFrom(env, [...args, "--json"]);
  assert.equal(json.code, 1);
  assert.deepEqual(json.stderr, []);
  assert.equal(json.stdout.length, 1);
  const { error } = JSON.parse(json.stdout[0] as string);
  assert.equal(error.message, line);
  assert.equal(error.path, path);
  assert.equal(error.hint, hint);
  return error;
}
