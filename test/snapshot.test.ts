import assert from "node:assert/strict";
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { describe, it } from "node:test";
import {
  type DatabaseCopyOptions,
  withDatabaseCopy,
} from "../src/core/database.ts";
import { CliError } from "../src/core/errors.ts";
import { buildFixtureDb, WAL_ONLY_VARIABLE } from "./fixtures/companion-db.ts";
import { fileState, runCli, tempDir } from "./helpers.ts";
import type { DatabaseSync } from "node:sqlite";

function busy(path: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    `EBUSY: resource busy or locked, copyfile '${path}'`,
  );
  error.code = "EBUSY";
  return error;
}

function walFixture(): string {
  const dbPath = buildFixtureDb(tempDir(), { wal: true });
  assert.ok(existsSync(`${dbPath}-shm`), "the fixture has a -shm file");
  return dbPath;
}

const readWalOnly = (db: DatabaseSync): boolean =>
  db
    .prepare("SELECT value FROM custom_variables WHERE id = ?")
    .get(WAL_ONLY_VARIABLE.name) !== undefined;

describe("read snapshot: files copied", () => {
  it("copies the database and -wal, never -shm, and still reads WAL-only rows", () => {
    const dbPath = walFixture();
    const before = fileState(dbPath);
    const copied: string[] = [];
    const options: DatabaseCopyOptions = {
      readOnly: true,
      tmpdir: tempDir(),
      copyFile: (source, target) => {
        copied.push(basename(target));
        copyFileSync(source, target);
      },
    };
    assert.equal(withDatabaseCopy(dbPath, options, readWalOnly), true);
    assert.deepEqual(copied, ["db.sqlite", "db.sqlite-wal"]);
    assert.deepEqual(fileState(dbPath), before);
  });

  it("a read command reads WAL-only rows with -shm present, leaving the originals untouched", async () => {
    const dbPath = walFixture();
    const before = fileState(dbPath);
    const tmpdir = tempDir();
    const result = await runCli(
      ["list", "variables", "--db", dbPath, "--json"],
      { tmpdir },
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    const names = (
      JSON.parse(result.stdout[0] ?? "") as { variables: { name: string }[] }
    ).variables.map((v) => v.name);
    assert.ok(names.includes(WAL_ONLY_VARIABLE.name), names.join(","));
    assert.deepEqual(fileState(dbPath), before);
    assert.deepEqual(readdirSync(tmpdir), []);
  });
});

describe("read snapshot: transient errors", () => {
  it("retries a copy that fails with EBUSY twice, then succeeds", () => {
    const dbPath = walFixture();
    let failures = 0;
    const slept: number[] = [];
    const options: DatabaseCopyOptions = {
      readOnly: true,
      tmpdir: tempDir(),
      sleep: (ms) => slept.push(ms),
      copyFile: (source, target) => {
        if (source === dbPath && failures < 2) {
          failures += 1;
          throw busy(source);
        }
        copyFileSync(source, target);
      },
    };
    assert.equal(withDatabaseCopy(dbPath, options, readWalOnly), true);
    assert.equal(failures, 2);
    assert.equal(slept.length, 2);
  });

  for (const code of ["EBUSY", "EPERM", "EACCES"]) {
    it(`a copy that always fails with ${code} is database_unreadable naming the file`, () => {
      const dbPath = walFixture();
      const slept: number[] = [];
      const tmpdir = tempDir();
      const options: DatabaseCopyOptions = {
        readOnly: true,
        tmpdir,
        sleep: (ms) => slept.push(ms),
        copyFile: (source, target) => {
          if (source === `${dbPath}-wal`) {
            const error: NodeJS.ErrnoException = new Error("locked");
            error.code = code;
            throw error;
          }
          copyFileSync(source, target);
        },
      };
      assert.throws(
        () => withDatabaseCopy(dbPath, options, () => "unreached"),
        (error: unknown) => {
          assert.ok(error instanceof CliError);
          assert.equal(error.code, "database_unreadable");
          assert.ok(error.message.includes(`${dbPath}-wal`), error.message);
          assert.ok(error.message.includes(code), error.message);
          return true;
        },
      );
      // Retried over about one second, then gave up.
      const total = slept.reduce((sum, ms) => sum + ms, 0);
      assert.ok(slept.length >= 3, `retried ${slept.length} times`);
      assert.ok(total >= 800 && total <= 1500, `slept ${total} ms`);
      assert.deepEqual(readdirSync(tmpdir), []);
    });
  }

  it("does not retry other copy errors", () => {
    const dbPath = walFixture();
    const slept: number[] = [];
    const options: DatabaseCopyOptions = {
      readOnly: true,
      tmpdir: tempDir(),
      sleep: (ms) => slept.push(ms),
      copyFile: () => {
        const error: NodeJS.ErrnoException = new Error("no space");
        error.code = "ENOSPC";
        throw error;
      },
    };
    assert.throws(
      () => withDatabaseCopy(dbPath, options, () => "unreached"),
      (error: unknown) =>
        error instanceof CliError &&
        error.code === "database_unreadable" &&
        error.message.includes("ENOSPC"),
    );
    assert.deepEqual(slept, []);
  });
});

describe("read snapshot: cleanup", () => {
  const failingRemove = (dir: string): void => {
    throw busy(dir);
  };

  it("a failed temp-directory removal does not mask the result", () => {
    const dbPath = walFixture();
    const options: DatabaseCopyOptions = {
      readOnly: true,
      tmpdir: tempDir(),
      removeDir: failingRemove,
    };
    assert.equal(withDatabaseCopy(dbPath, options, readWalOnly), true);
  });

  it("a failed temp-directory removal does not mask the command's error", () => {
    const dbPath = walFixture();
    const options: DatabaseCopyOptions = {
      readOnly: true,
      tmpdir: tempDir(),
      removeDir: failingRemove,
    };
    const failure = new CliError("from the reader", {
      code: "unsupported_version",
    });
    assert.throws(
      () =>
        withDatabaseCopy(dbPath, options, () => {
          throw failure;
        }),
      (error: unknown) => error === failure,
    );
  });
});
