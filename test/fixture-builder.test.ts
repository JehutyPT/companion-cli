import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  COMPANION_TABLES,
  buildFixtureDb,
  FIXTURE_GRID_SIZE,
  WAL_ONLY_VARIABLE,
} from "./fixtures/companion-db.ts";
import {
  customVariables,
  dumpDatabase,
  fileState,
  tempDir,
} from "./helpers.ts";

describe("fixture builder", () => {
  it("creates a version-17 database with Companion's tables, grid size, a page, controls and variables", () => {
    const dbPath = buildFixtureDb(tempDir());
    const dump = dumpDatabase(dbPath);
    for (const table of COMPANION_TABLES) {
      const ddl = dump["sqlite_master"]?.find((row) => row.id === table)?.value;
      assert.equal(
        ddl,
        `CREATE TABLE ${table} (id STRING UNIQUE, value STRING)`,
      );
    }
    const main = Object.fromEntries(
      (dump["main"] ?? []).map((row) => [row.id, JSON.parse(row.value)]),
    );
    assert.equal(main["page_config_version"], 17);
    assert.deepEqual(main["userconfig"].gridSize, FIXTURE_GRID_SIZE);
    assert.equal(dump["pages"]?.length, 1);
    assert.equal(dump["controls"]?.length, 2);
    assert.ok(
      dump["controls"]?.every(
        (row) => JSON.parse(row.value).type === "button-layered",
      ),
    );
    assert.equal(Object.keys(customVariables(dbPath)).length, 3);
    const files = fileState(dbPath);
    assert.equal(files["db.sqlite-wal"], null);
    assert.equal(files["db.sqlite-shm"], null);
  });

  it("WAL variant keeps committed rows only in the -wal file", () => {
    const dir = tempDir();
    const dbPath = buildFixtureDb(dir, { wal: true });
    const files = fileState(dbPath);
    assert.notEqual(files["db.sqlite-wal"], null);
    assert.notEqual(files["db.sqlite-shm"], null);
    assert.deepEqual(
      customVariables(dbPath)[WAL_ONLY_VARIABLE.name],
      WAL_ONLY_VARIABLE.value,
    );
    // Without its WAL, the main file alone does not have the row.
    const alone = join(tempDir(), "db.sqlite");
    copyFileSync(dbPath, alone);
    assert.equal(customVariables(alone)[WAL_ONLY_VARIABLE.name], undefined);
  });

  it("can build other DB versions or omit the version", () => {
    const v16 = dumpDatabase(buildFixtureDb(tempDir(), { version: 16 }));
    assert.equal(
      v16["main"]?.find((row) => row.id === "page_config_version")?.value,
      "16",
    );
    const none = dumpDatabase(buildFixtureDb(tempDir(), { version: null }));
    assert.equal(
      none["main"]?.find((row) => row.id === "page_config_version"),
      undefined,
    );
  });
});
