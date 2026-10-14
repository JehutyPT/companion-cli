import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { apply } from "../src/core/apply.ts";
import type { Writer } from "../src/core/writer.ts";
import { variablesWriter } from "../src/writers/variables.ts";
import {
  buildFixtureDb,
  FIXTURE_VARIABLES,
  type FixtureOptions,
  WAL_ONLY_VARIABLE,
} from "./fixtures/companion-db.ts";
import {
  customVariables,
  dumpDatabase,
  fileState,
  printedBackupDir,
  runCli,
  type TableDump,
  tempDir,
  writeDescription,
} from "./helpers.ts";

const VARIABLES_YAML = `kind: variables
variables:
  - name: fx_label
    default: ready
    description: Replaced label
  - name: new_one
    default: 0
  - name: new_two
    default: ""
    description: Second
    persist: true
`;

function setup(options: FixtureOptions = {}) {
  const dir = tempDir();
  const dbPath = buildFixtureDb(join(dir, "install"), options);
  const backupRoot = join(dir, "backups");
  return { dir, dbPath, backupRoot };
}

function withoutTable(dump: TableDump, table: string): TableDump {
  const { [table]: _omitted, ...rest } = dump;
  return rest;
}

describe("apply variables: success", () => {
  it("writes the named variables, keeps existing sortOrder and appends new ones in file order", async () => {
    const { dir, dbPath, backupRoot } = setup();
    const before = dumpDatabase(dbPath);
    const file = writeDescription(dir, VARIABLES_YAML);

    const result = await runCli(["apply", file, "--db", dbPath], {
      backupRoot,
    });

    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(customVariables(dbPath), {
      ...FIXTURE_VARIABLES,
      fx_label: {
        description: "Replaced label",
        defaultValue: "ready",
        persistCurrentValue: false,
        sortOrder: 1,
      },
      new_one: {
        description: "A custom variable",
        defaultValue: 0,
        persistCurrentValue: false,
        sortOrder: 6,
      },
      new_two: {
        description: "Second",
        defaultValue: "",
        persistCurrentValue: true,
        sortOrder: 7,
      },
    });
    // Stored as compact JSON with Companion's key order.
    const stored = dumpDatabase(dbPath)["custom_variables"]?.find(
      (row) => row.id === "new_one",
    )?.value;
    assert.equal(
      stored,
      '{"description":"A custom variable","defaultValue":0,"persistCurrentValue":false,"sortOrder":6}',
    );
    // Every other table is unchanged, row for row.
    assert.deepEqual(
      withoutTable(dumpDatabase(dbPath), "custom_variables"),
      withoutTable(before, "custom_variables"),
    );
    assert.match(result.stdout.at(-1) ?? "", /2 created, 1 replaced/);
  });

  it("backs up the database and prints the backup path before writing", async () => {
    const { dir, dbPath, backupRoot } = setup();
    const original = readFileSync(dbPath);
    const logged: string[] = [];
    let loggedAtWrite: string[] = [];
    const result = await runCli(
      ["apply", writeDescription(dir, VARIABLES_YAML), "--db", dbPath],
      {
        backupRoot,
        log: (line) => logged.push(line),
        hooks: { afterWrite: () => void (loggedAtWrite = [...logged]) },
      },
    );

    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(
      loggedAtWrite.length,
      1,
      "backup path printed before the write",
    );
    const backupDir = printedBackupDir({ ...result, stdout: loggedAtWrite });
    assert.ok(backupDir, `backup line: ${loggedAtWrite}`);
    assert.ok(backupDir.startsWith(backupRoot));
    assert.deepEqual(readdirSync(backupDir), ["db.sqlite"]);
    assert.deepEqual(readFileSync(join(backupDir, "db.sqlite")), original);
  });

  it("defaults the backup location to companion-cli-backups next to the database", async () => {
    const { dir, dbPath } = setup();
    const result = await runCli(
      ["apply", writeDescription(dir, VARIABLES_YAML), "--db", dbPath],
      {
        now: () => new Date("2026-10-14T12:34:56.789Z"),
      },
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(
      printedBackupDir(result),
      join(dir, "install", "companion-cli-backups", "20261014T123456789Z"),
    );
  });

  it("is idempotent: applying the same file twice yields identical custom_variables", async () => {
    const { dir, dbPath, backupRoot } = setup();
    const file = writeDescription(dir, VARIABLES_YAML);
    const now = () => new Date("2026-10-14T00:00:00.000Z"); // same timestamp: backup names must not collide

    assert.equal(
      (await runCli(["apply", file, "--db", dbPath], { backupRoot, now })).code,
      0,
    );
    const first = dumpDatabase(dbPath);
    const second = await runCli(["apply", file, "--db", dbPath], {
      backupRoot,
      now,
    });

    assert.equal(second.code, 0, second.stderr.join("\n"));
    assert.deepEqual(dumpDatabase(dbPath), first);
    assert.match(second.stdout.at(-1) ?? "", /0 created, 3 replaced/);
    assert.equal(readdirSync(backupRoot).length, 2);
  });

  it("reads committed changes still in the WAL and backs up all three files", async () => {
    const { dir, dbPath, backupRoot } = setup({ wal: true });
    const before = fileState(dbPath);
    const result = await runCli(
      ["apply", writeDescription(dir, VARIABLES_YAML), "--db", dbPath],
      { backupRoot },
    );

    assert.equal(result.code, 0, result.stderr.join("\n"));
    const vars = customVariables(dbPath);
    assert.deepEqual(vars[WAL_ONLY_VARIABLE.name], WAL_ONLY_VARIABLE.value);
    // New variables go after the WAL-only variable's sortOrder 7.
    assert.equal((vars["new_one"] as { sortOrder: number }).sortOrder, 8);
    assert.equal((vars["new_two"] as { sortOrder: number }).sortOrder, 9);

    const backupDir = printedBackupDir(result);
    assert.ok(backupDir);
    assert.deepEqual(readdirSync(backupDir).sort(), [
      "db.sqlite",
      "db.sqlite-shm",
      "db.sqlite-wal",
    ]);
    assert.deepEqual(fileState(join(backupDir, "db.sqlite")), before);
  });
});

describe("apply variables: persisted values", () => {
  // Fixture: fx_label is persisted (stored "idle"); fx_counter is not (stored 0).
  const PERSIST_YAML = `kind: variables
variables:
  - name: fx_label
    default: fresh
    description: New label description
    persist: true
  - name: fx_counter
    default: 5
    persist: true
  - name: brand_new
    default: start
    persist: true
`;

  async function applyFile(dbPath: string, file: string, backupRoot: string) {
    const result = await runCli(["apply", file, "--db", dbPath], {
      backupRoot,
    });
    assert.equal(result.code, 0, result.stderr.join("\n"));
  }

  it("keeps a persisted variable's stored value, switches take the file default", async () => {
    const { dir, dbPath, backupRoot } = setup();
    await applyFile(dbPath, writeDescription(dir, PERSIST_YAML), backupRoot);

    const vars = customVariables(dbPath);
    assert.deepEqual(vars["fx_label"], {
      description: "New label description",
      defaultValue: "idle",
      persistCurrentValue: true,
      sortOrder: 1,
    });
    assert.deepEqual(vars["fx_counter"], {
      description: "A custom variable",
      defaultValue: 5,
      persistCurrentValue: true,
      sortOrder: 0,
    });
    assert.deepEqual(vars["brand_new"], {
      description: "A custom variable",
      defaultValue: "start",
      persistCurrentValue: true,
      sortOrder: 6,
    });
  });

  it("a true-to-false switch takes the file default", async () => {
    const { dir, dbPath, backupRoot } = setup();
    const yaml =
      "kind: variables\nvariables:\n  - {name: fx_label, default: plain, persist: false}\n";
    await applyFile(dbPath, writeDescription(dir, yaml), backupRoot);
    const label = customVariables(dbPath)["fx_label"] as Record<
      string,
      unknown
    >;
    assert.equal(label["defaultValue"], "plain");
    assert.equal(label["persistCurrentValue"], false);
  });

  it("re-applying is idempotent", async () => {
    const { dir, dbPath, backupRoot } = setup();
    const file = writeDescription(dir, PERSIST_YAML);
    await applyFile(dbPath, file, backupRoot);
    const first = dumpDatabase(dbPath);
    await applyFile(dbPath, file, backupRoot);
    assert.deepEqual(dumpDatabase(dbPath), first);
    assert.equal(
      (customVariables(dbPath)["fx_counter"] as Record<string, unknown>)[
        "defaultValue"
      ],
      5,
    );
  });
});

describe("apply variables: invalid description files leave the database byte-identical", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["missing kind", "variables: []\n", /kind: is required/],
    [
      "unknown kind",
      "kind: banana\nvariables: []\n",
      /kind: unknown kind "banana"/,
    ],
    ["reserved kind", "kind: page\n", /kind: kind "page" is reserved/],
    [
      "reserved trigger kind",
      "kind: trigger\n",
      /kind: kind "trigger" is reserved/,
    ],
    [
      "unknown top-level field",
      "kind: variables\nextra: 1\nvariables:\n  - {name: a, default: 1}\n",
      /extra: unknown field/,
    ],
    [
      "unknown variable field",
      "kind: variables\nvariables:\n  - {name: a, default: 1, colour: red}\n",
      /variables\[0\]\.colour: unknown field/,
    ],
    ["missing variables", "kind: variables\n", /variables: is required/],
    [
      "empty variables",
      "kind: variables\nvariables: []\n",
      /variables: must list at least one variable/,
    ],
    [
      "missing default",
      "kind: variables\nvariables:\n  - {name: a}\n",
      /variables\[0\]\.default: is required/,
    ],
    [
      "null default",
      "kind: variables\nvariables:\n  - {name: a, default: null}\n",
      /variables\[0\]\.default: must be a string, number or boolean/,
    ],
    [
      "non-boolean persist",
      "kind: variables\nvariables:\n  - {name: a, default: 1, persist: 'yes'}\n",
      /variables\[0\]\.persist: must be true or false/,
    ],
    [
      "duplicate name",
      "kind: variables\nvariables:\n  - {name: a, default: 1}\n  - {name: a, default: 2}\n",
      /variables\[1\]\.name: duplicate variable name "a"/,
    ],
    [
      "empty name",
      "kind: variables\nvariables:\n  - {name: '', default: 1}\n",
      /variables\[0\]\.name: invalid variable name ""/,
    ],
    [
      "name with dash",
      "kind: variables\nvariables:\n  - {name: a-b, default: 1}\n",
      /variables\[0\]\.name: invalid variable name "a-b"/,
    ],
    [
      "name with dot",
      "kind: variables\nvariables:\n  - {name: a.b, default: 1}\n",
      /invalid variable name "a.b"/,
    ],
    [
      "name with space",
      "kind: variables\nvariables:\n  - {name: 'a b', default: 1}\n",
      /invalid variable name "a b"/,
    ],
    [
      "non-ASCII name",
      "kind: variables\nvariables:\n  - {name: café, default: 1}\n",
      /invalid variable name "café"/,
    ],
    [
      "reserved name",
      "kind: variables\nvariables:\n  - {name: constructor, default: 1}\n",
      /"constructor" is reserved/,
    ],
    [
      "numeric name",
      "kind: variables\nvariables:\n  - {name: '007', default: 1}\n",
      /"007" looks like a number/,
    ],
    [
      "non-string name",
      "kind: variables\nvariables:\n  - {name: 12, default: 1}\n",
      /variables\[0\]\.name: must be a string/,
    ],
    ["invalid YAML", "kind: variables\nvariables: [\n", /invalid YAML/],
    [
      "duplicate YAML key",
      "kind: variables\nkind: variables\n",
      /invalid YAML/,
    ],
    ["not a mapping", "- kind: variables\n", /must be a mapping/],
  ];

  for (const [name, yaml, expected] of cases) {
    it(name, async () => {
      const { dir, dbPath, backupRoot } = setup({ wal: true });
      const before = fileState(dbPath);
      const result = await runCli(
        ["apply", writeDescription(dir, yaml), "--db", dbPath],
        { backupRoot },
      );

      assert.notEqual(result.code, 0);
      assert.equal(result.stderr.length, 1);
      assert.match(result.stderr[0] ?? "", expected);
      assert.deepEqual(fileState(dbPath), before);
      assert.equal(
        existsSync(backupRoot),
        false,
        "no backup for a refused apply",
      );
    });
  }
});

describe("apply variables: version guard", () => {
  for (const [label, version, found] of [
    ["16", 16, "16"],
    ["18", 18, "18"],
    ["missing", null, "missing"],
  ] as const) {
    it(`refuses page_config_version ${label} and leaves all files byte-identical`, async () => {
      const { dir, dbPath, backupRoot } = setup({ wal: true, version });
      const before = fileState(dbPath);
      const result = await runCli(
        ["apply", writeDescription(dir, VARIABLES_YAML), "--db", dbPath],
        { backupRoot },
      );

      assert.equal(result.code, 1);
      assert.deepEqual(result.stderr, [
        `error: unsupported database: page_config_version is ${found}; only 17 (Companion 5.1) is supported`,
      ]);
      assert.deepEqual(fileState(dbPath), before);
      assert.equal(existsSync(backupRoot), false);
    });
  }

  it("checks the version as committed in the WAL, not only in the main file", async () => {
    const upgraded = setup({ wal: true, version: 16, walVersion: 17 });
    const ok = await runCli(
      [
        "apply",
        writeDescription(upgraded.dir, VARIABLES_YAML),
        "--db",
        upgraded.dbPath,
      ],
      {
        backupRoot: upgraded.backupRoot,
      },
    );
    assert.equal(ok.code, 0, ok.stderr.join("\n"));

    const tooNew = setup({ wal: true, version: 17, walVersion: 18 });
    const before = fileState(tooNew.dbPath);
    const refused = await runCli(
      [
        "apply",
        writeDescription(tooNew.dir, VARIABLES_YAML),
        "--db",
        tooNew.dbPath,
      ],
      {
        backupRoot: tooNew.backupRoot,
      },
    );
    assert.equal(refused.code, 1);
    assert.match(refused.stderr[0] ?? "", /page_config_version is 18/);
    assert.deepEqual(fileState(tooNew.dbPath), before);
  });

  it("refuses a file that is not a database", async () => {
    const { dir, backupRoot } = setup();
    const notDb = writeDescription(dir, "not a database", "fake.sqlite");
    const result = await runCli(
      ["apply", writeDescription(dir, VARIABLES_YAML), "--db", notDb],
      { backupRoot },
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr[0] ?? "", /^error: cannot (open|read) database/);
    assert.equal(existsSync(backupRoot), false);
  });

  it("refuses a missing database", async () => {
    const { dir, backupRoot } = setup();
    const result = await runCli(
      [
        "apply",
        writeDescription(dir, VARIABLES_YAML),
        "--db",
        join(dir, "nope.sqlite"),
      ],
      {
        backupRoot,
      },
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr[0] ?? "", /^error: database not found/);
  });
});

describe("apply variables: failures inside the transaction roll back", () => {
  it("an injected write failure leaves content unchanged and keeps the backup with WAL files", async () => {
    const { dir, dbPath, backupRoot } = setup({ wal: true });
    const before = dumpDatabase(dbPath);
    const beforeFiles = fileState(dbPath);
    let wroteBeforeFailing = false;
    const result = await runCli(
      ["apply", writeDescription(dir, VARIABLES_YAML), "--db", dbPath],
      {
        backupRoot,
        hooks: {
          afterWrite: (db) => {
            // The writer's rows are really there before the failure.
            wroteBeforeFailing =
              db
                .prepare("SELECT 1 FROM custom_variables WHERE id = 'new_one'")
                .get() !== undefined;
            throw new Error("disk on fire");
          },
        },
      },
    );

    assert.equal(wroteBeforeFailing, true);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.length, 1);
    assert.match(
      result.stderr[0] ?? "",
      /write failed, rolled back.*disk on fire/,
    );
    assert.deepEqual(dumpDatabase(dbPath), before);
    const backupDir = printedBackupDir(result);
    assert.ok(backupDir && result.stderr[0]?.includes(backupDir));
    assert.deepEqual(fileState(join(backupDir, "db.sqlite")), beforeFiles);
  });

  it("a non-ok integrity check leaves content unchanged and keeps the backup", async () => {
    const { dir, dbPath, backupRoot } = setup({ wal: true });
    const before = dumpDatabase(dbPath);
    const beforeFiles = fileState(dbPath);
    const result = await runCli(
      ["apply", writeDescription(dir, VARIABLES_YAML), "--db", dbPath],
      {
        backupRoot,
        hooks: {
          integrityCheck: () => [
            "*** in database main ***",
            "Page 3: btreeInitPage() returns error code 11",
          ],
        },
      },
    );

    assert.equal(result.code, 1);
    assert.equal(result.stderr.length, 1);
    assert.match(
      result.stderr[0] ?? "",
      /integrity check failed: \*\*\* in database main/,
    );
    assert.deepEqual(dumpDatabase(dbPath), before);
    const backupDir = printedBackupDir(result);
    assert.ok(backupDir);
    assert.deepEqual(fileState(join(backupDir, "db.sqlite")), beforeFiles);
  });

  it("refuses with a version error when the version changes before the write lock", async () => {
    const { dir, dbPath, backupRoot } = setup({ wal: true });
    const beforeVariables = customVariables(dbPath);
    const result = await runCli(
      ["apply", writeDescription(dir, VARIABLES_YAML), "--db", dbPath],
      {
        backupRoot,
        hooks: {
          afterBackup: (path) => {
            const db = new DatabaseSync(path);
            db.prepare(
              "UPDATE main SET value = '18' WHERE id = 'page_config_version'",
            ).run();
            db.close();
          },
        },
      },
    );

    assert.equal(result.code, 1);
    assert.equal(result.stderr.length, 1);
    assert.match(
      result.stderr[0] ?? "",
      /^error: unsupported database: page_config_version is 18; .*nothing written; backup kept at /,
    );
    assert.deepEqual(customVariables(dbPath), beforeVariables);
  });

  it("runs the writer's database check on the snapshot and again under the write lock", async () => {
    const { dir, dbPath, backupRoot } = setup();
    const seen: boolean[] = [];
    apply(
      {
        descriptionPath: writeDescription(dir, VARIABLES_YAML),
        dbPath,
        writers: {
          variables: {
            ...variablesWriter,
            check: (db) => void seen.push(db.isTransaction),
          } as Writer,
        },
      },
      { homedir: tempDir(), backupRoot },
    );
    assert.deepEqual(seen, [false, true]);
  });
});

describe("apply: default install database and command line", () => {
  function fakeInstall() {
    const home = tempDir();
    const installDir = join(
      home,
      "Library",
      "Application Support",
      "companion",
      "v5.1",
    );
    const dbPath = buildFixtureDb(installDir);
    return { home, dbPath, file: writeDescription(home, VARIABLES_YAML) };
  }

  it("refuses the default install database", async () => {
    const { home, dbPath, file } = fakeInstall();
    const before = fileState(dbPath);
    const result = await runCli(["apply", file, "--db", dbPath], {
      homedir: home,
    });
    assert.equal(result.code, 1);
    assert.match(
      result.stderr[0] ?? "",
      /^error: refusing to write the Companion install's default database/,
    );
    assert.deepEqual(fileState(dbPath), before);
  });

  it("refuses a symlink that resolves to the default install database", async () => {
    const { home, dbPath, file } = fakeInstall();
    const link = join(tempDir(), "link.sqlite");
    symlinkSync(dbPath, link);
    const result = await runCli(["apply", file, "--db", link], {
      homedir: home,
    });
    assert.equal(result.code, 1);
    assert.match(
      result.stderr[0] ?? "",
      /refusing to write the Companion install's default database/,
    );
  });

  it("refuses a path through a symlinked directory and a ~ path", async () => {
    const { home, file } = fakeInstall();
    const linkDir = join(tempDir(), "linked");
    symlinkSync(
      join(home, "Library", "Application Support", "companion"),
      linkDir,
    );
    for (const db of [
      join(linkDir, "v5.1", "db.sqlite"),
      "~/Library/Application Support/companion/v5.1/db.sqlite",
    ]) {
      const result = await runCli(["apply", file, "--db", db], {
        homedir: home,
      });
      assert.equal(result.code, 1, db);
      assert.match(
        result.stderr[0] ?? "",
        /refusing to write the Companion install's default database/,
      );
    }
  });

  it("allows a copy elsewhere in the same home", async () => {
    const { home, file } = fakeInstall();
    const copyDir = join(home, "copies");
    mkdirSync(copyDir);
    const copy = buildFixtureDb(copyDir);
    const result = await runCli(["apply", file, "--db", copy], {
      homedir: home,
    });
    assert.equal(result.code, 0, result.stderr.join("\n"));
  });

  it("requires --db", async () => {
    const result = await runCli([
      "apply",
      writeDescription(tempDir(), VARIABLES_YAML),
    ]);
    assert.equal(result.code, 2);
    assert.equal(result.stderr.length, 1);
    assert.match(result.stderr[0] ?? "", /--db is required/);
  });

  it("rejects unknown commands, options and missing files", async () => {
    for (const argv of [
      [],
      ["frobnicate"],
      ["apply"],
      ["apply", "a.yaml", "b.yaml", "--db", "x"],
      ["apply", "a.yaml", "--nope"],
    ]) {
      const result = await runCli(argv);
      assert.equal(result.code, 2, argv.join(" "));
      assert.equal(result.stderr.length, 1);
    }
    const missing = await runCli([
      "apply",
      join(tempDir(), "missing.yaml"),
      "--db",
      join(tempDir(), "db.sqlite"),
    ]);
    assert.equal(missing.code, 1);
    assert.match(
      missing.stderr[0] ?? "",
      /cannot read description file .*ENOENT/,
    );
  });
});
