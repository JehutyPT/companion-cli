import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { USAGE } from "../src/cli.ts";
import { apply, runIntegrityCheck } from "../src/core/apply.ts";
import type { Writer } from "../src/core/writer.ts";
import { variablesWriter } from "../src/writers/variables.ts";
import {
  buildFixtureDb,
  FIXTURE_VARIABLES,
  type FixtureOptions,
} from "./fixtures/companion-db.ts";
import {
  type CliRun,
  customVariables,
  dumpDatabase,
  fakeProcessControl,
  type FakeProcessOptions,
  fileState,
  installDir,
  printedBackupDir,
  runCli,
  tempDir,
  writeDescription,
} from "./helpers.ts";
import type { ApplyHooks } from "../src/core/apply.ts";
import { windowsProcessControl } from "../src/core/process.ts";

const VARIABLES_YAML = `kind: variables
variables:
  - name: live_one
    default: 1
`;

/** A temporary home with a fixture database at the install path. */
function fakeHome(options: FixtureOptions = {}) {
  const home = tempDir();
  const dbPath = buildFixtureDb(installDir(home), options);
  return { home, dbPath, file: writeDescription(home, VARIABLES_YAML) };
}

/** Hooks that log `backup`, `write` and `integrity` into the shared call log. */
function recordingHooks(calls: string[]): ApplyHooks {
  return {
    afterBackup: () => void calls.push("backup"),
    afterWrite: () => void calls.push("write"),
    integrityCheck: (db) => {
      calls.push("integrity");
      return runIntegrityCheck(db);
    },
  };
}

async function liveApply(
  home: string,
  file: string,
  process: FakeProcessOptions,
  hooks?: (calls: string[]) => ApplyHooks,
  extra: { quitTimeoutMs?: number; backupRoot?: string } = {},
): Promise<
  CliRun & { calls: string[]; waitedFor: number[][]; timeouts: number[] }
> {
  const fake = fakeProcessControl(process);
  const result = await runCli(["apply", file], {
    homedir: home,
    processControl: fake.control,
    hooks: (hooks ?? recordingHooks)(fake.calls),
    now: () => new Date("2026-10-14T12:34:56.789Z"),
    ...extra,
  });
  return { ...result, ...fake };
}

describe("live-install mode: order", () => {
  it("validates, checks, quits, waits, backs up, writes, checks integrity and restarts", async () => {
    const { home, dbPath, file } = fakeHome();
    const result = await liveApply(home, file, { running: true });

    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(result.calls, [
      "check",
      "check",
      "quit",
      "wait",
      "holders",
      "backup",
      "write",
      "integrity",
      "start",
    ]);
    assert.deepEqual(result.waitedFor, [[4242]]);
    assert.deepEqual(result.timeouts, [30_000]);
    assert.equal(
      (customVariables(dbPath)["live_one"] as { defaultValue: number })
        .defaultValue,
      1,
    );
  });

  it("backs up the install's database next to it, in companion-cli-backups/<timestamp>/", async () => {
    const { home, dbPath, file } = fakeHome({ wal: true });
    const before = fileState(dbPath);
    const result = await liveApply(home, file, { running: true });

    assert.equal(result.code, 0, result.stderr.join("\n"));
    const expected = join(
      installDir(home),
      "companion-cli-backups",
      "20261014T123456789Z",
    );
    assert.equal(printedBackupDir(result), expected);
    assert.deepEqual(readdirSync(expected).sort(), [
      "db.sqlite",
      "db.sqlite-shm",
      "db.sqlite-wal",
    ]);
    assert.deepEqual(fileState(join(expected, "db.sqlite")), before);
  });

  it("passes an injected wait timeout to the process control", async () => {
    const { home, file } = fakeHome();
    const result = await liveApply(home, file, { running: true }, undefined, {
      quitTimeoutMs: 5,
    });
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(result.timeouts, [5]);
  });
});

describe("live-install mode: Companion not running", () => {
  it("neither quits nor starts Companion on success", async () => {
    const { home, dbPath, file } = fakeHome();
    const result = await liveApply(home, file, { running: false });
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(result.calls, [
      "check",
      "check",
      "holders",
      "backup",
      "write",
      "integrity",
    ]);
    assert.ok(customVariables(dbPath)["live_one"]);
  });

  it("neither quits nor starts Companion on failure", async () => {
    const { home, dbPath, file } = fakeHome();
    const before = dumpDatabase(dbPath);
    const result = await liveApply(home, file, { running: false }, (calls) => ({
      ...recordingHooks(calls),
      afterWrite: () => {
        throw new Error("disk on fire");
      },
    }));
    assert.equal(result.code, 1);
    assert.deepEqual(result.calls, ["check", "check", "holders", "backup"]);
    assert.match(result.stderr[0] ?? "", /disk on fire/);
    assert.deepEqual(dumpDatabase(dbPath), before);
  });
});

describe("live-install mode: failures before the quit", () => {
  const cases: Array<[string, FixtureOptions, string | null, RegExp]> = [
    [
      "an invalid description",
      {},
      "kind: variables\nvariables:\n  - name: bad-name\n    default: 1\n",
      /variables\[0\]\.name: invalid variable name/,
    ],
    [
      "an unsupported version",
      { version: 18 },
      null,
      /page_config_version is 18/,
    ],
    [
      "a failing writer check",
      {},
      'kind: button\nlocation: { page: 2, row: 0, column: 0 }\ntext: x\nbackground: "#000000"\n',
      /page 2 does not exist/,
    ],
  ];
  for (const [name, fixture, yaml, expected] of cases) {
    it(`${name} never touches the process and leaves the files byte-identical`, async () => {
      const { home, dbPath } = fakeHome({ wal: true, ...fixture });
      const file = writeDescription(home, yaml ?? VARIABLES_YAML, "case.yaml");
      const before = fileState(dbPath);
      const result = await liveApply(home, file, { running: true });
      assert.equal(result.code, 1);
      assert.equal(result.stderr.length, 1);
      assert.match(result.stderr[0] ?? "", expected);
      assert.deepEqual(result.calls, ["check"]);
      assert.deepEqual(fileState(dbPath), before);
      assert.equal(
        existsSync(join(installDir(home), "companion-cli-backups")),
        false,
      );
    });
  }

  it("a missing database never touches the process", async () => {
    const home = tempDir();
    const file = writeDescription(home, VARIABLES_YAML);
    const result = await liveApply(home, file, { running: true });
    assert.equal(result.code, 1);
    assert.match(result.stderr[0] ?? "", /^error: database not found: .*v5\.1/);
    assert.deepEqual(result.calls, ["check"]);
  });

  it("an unreadable snapshot never touches the process", async () => {
    const home = tempDir();
    mkdirSync(installDir(home), { recursive: true });
    const dbPath = join(installDir(home), "db.sqlite");
    writeFileSync(dbPath, "not a database, just text");
    const before = fileState(dbPath);
    const result = await liveApply(
      home,
      writeDescription(home, VARIABLES_YAML),
      { running: true },
    );
    assert.equal(result.code, 1);
    assert.deepEqual(result.calls, ["check"]);
    assert.deepEqual(fileState(dbPath), before);
  });

  it("a failing running check refuses without quitting", async () => {
    const { home, dbPath, file } = fakeHome();
    const before = fileState(dbPath);
    const result = await liveApply(home, file, {
      running: true,
      failCheck: true,
    });
    assert.equal(result.code, 1);
    assert.match(
      result.stderr[0] ?? "",
      /cannot tell whether Companion is running.*ps exploded/,
    );
    assert.deepEqual(result.calls, ["check"]);
    assert.deepEqual(fileState(dbPath), before);
  });
});

describe("live-install mode: failures after the quit restart Companion", () => {
  function setVersion(path: string, version: number) {
    const db = new DatabaseSync(path);
    db.prepare(
      "UPDATE main SET value = ? WHERE id = 'page_config_version'",
    ).run(JSON.stringify(version));
    db.close();
  }

  const cases: Array<
    [string, (calls: string[]) => ApplyHooks, RegExp, string[]]
  > = [
    [
      "a failure after the backup",
      (calls) => ({
        ...recordingHooks(calls),
        afterBackup: () => {
          calls.push("backup");
          throw new Error("backup went sideways");
        },
      }),
      /backup went sideways/,
      ["check", "check", "quit", "wait", "holders", "backup", "start"],
    ],
    [
      "the repeated check under the write lock",
      (calls) => ({
        ...recordingHooks(calls),
        afterBackup: (path) => {
          calls.push("backup");
          setVersion(path, 18);
        },
      }),
      /page_config_version is 18; .*nothing written/,
      ["check", "check", "quit", "wait", "holders", "backup", "start"],
    ],
    [
      "the write",
      (calls) => ({
        ...recordingHooks(calls),
        afterWrite: () => {
          calls.push("write");
          throw new Error("disk on fire");
        },
      }),
      /write failed, rolled back.*disk on fire/,
      ["check", "check", "quit", "wait", "holders", "backup", "write", "start"],
    ],
    [
      "the integrity check",
      (calls) => ({
        ...recordingHooks(calls),
        integrityCheck: () => {
          calls.push("integrity");
          return ["Page 3: btreeInitPage() returns error code 11"];
        },
      }),
      /integrity check failed: Page 3/,
      [
        "check",
        "check",
        "quit",
        "wait",
        "holders",
        "backup",
        "write",
        "integrity",
        "start",
      ],
    ],
  ];
  for (const [name, hooks, expected, order] of cases) {
    it(`${name}: content unchanged, Companion started, original reason`, async () => {
      const { home, dbPath, file } = fakeHome({ wal: true });
      const before = dumpDatabase(dbPath);
      const result = await liveApply(home, file, { running: true }, hooks);
      assert.equal(result.code, 1);
      assert.equal(result.stderr.length, 1);
      assert.match(result.stderr[0] ?? "", expected);
      assert.deepEqual(result.calls, order);
      if (name === "the repeated check under the write lock") {
        assert.equal(customVariables(dbPath)["live_one"], undefined);
      } else {
        assert.deepEqual(dumpDatabase(dbPath), before);
      }
    });
  }

  it("a failing backup starts Companion and leaves the files byte-identical", async () => {
    const { home, dbPath, file } = fakeHome({ wal: true });
    const before = fileState(dbPath);
    const blocker = join(tempDir(), "not-a-dir");
    writeFileSync(blocker, "");
    const result = await liveApply(home, file, { running: true }, undefined, {
      backupRoot: blocker,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr[0] ?? "", /cannot create backup directory/);
    assert.deepEqual(result.calls, [
      "check",
      "check",
      "quit",
      "wait",
      "holders",
      "start",
    ]);
    assert.deepEqual(fileState(dbPath), before);
  });

  it("reports both reasons when the restart also fails", async () => {
    const { home, file } = fakeHome();
    const result = await liveApply(
      home,
      file,
      { running: true, failStart: true },
      (calls) => ({
        ...recordingHooks(calls),
        afterWrite: () => {
          throw new Error("disk on fire");
        },
      }),
    );
    assert.equal(result.code, 1);
    assert.equal(result.stderr.length, 1);
    assert.match(
      result.stderr[0] ?? "",
      /write failed, rolled back.*disk on fire.*start Companion manually.*open failed/,
    );
  });
});

describe("live-install mode: quit, wait and start failures", () => {
  it("a wait timeout aborts without backup, write or start", async () => {
    const { home, dbPath, file } = fakeHome({ wal: true });
    const before = fileState(dbPath);
    const result = await liveApply(home, file, {
      running: true,
      timeout: true,
    });
    assert.equal(result.code, 1);
    assert.equal(result.stderr.length, 1);
    assert.match(
      result.stderr[0] ?? "",
      /did not exit within 30 seconds.*Companion may be partly stopped/,
    );
    assert.deepEqual(result.calls, ["check", "check", "quit", "wait"]);
    assert.deepEqual(fileState(dbPath), before);
    assert.equal(
      existsSync(join(installDir(home), "companion-cli-backups")),
      false,
    );
  });

  it("a failed start after a committed write says the change was written", async () => {
    const { home, dbPath, file } = fakeHome();
    const result = await liveApply(home, file, {
      running: true,
      failStart: true,
    });
    assert.equal(result.code, 1);
    assert.equal(result.stderr.length, 1);
    assert.match(
      result.stderr[0] ?? "",
      /change was written.*start Companion manually.*open failed/,
    );
    assert.ok(customVariables(dbPath)["live_one"]);
  });
});

describe("live-install mode: quit and wait errors start Companion", () => {
  for (const [name, options, expected] of [
    ["quit throws", { failQuit: true }, ["check", "check", "quit", "start"]],
    [
      "wait throws",
      { failWait: true },
      ["check", "check", "quit", "wait", "start"],
    ],
  ] as const) {
    it(`${name}: nothing written, start attempted, original reason`, async () => {
      const { home, dbPath, file } = fakeHome({ wal: true });
      const before = fileState(dbPath);
      const result = await liveApply(home, file, { running: true, ...options });
      assert.equal(result.code, 1);
      assert.equal(result.stderr.length, 1);
      assert.match(
        result.stderr[0] ?? "",
        /cannot quit Companion: (osascript failed|ps vanished); nothing written/,
      );
      assert.deepEqual(result.calls, expected);
      assert.deepEqual(fileState(dbPath), before);
    });
  }

  it("reports both reasons when the start after a failed quit also fails", async () => {
    const { home, file } = fakeHome();
    const result = await liveApply(home, file, {
      running: true,
      failQuit: true,
      failStart: true,
    });
    assert.equal(result.code, 1);
    assert.equal(result.stderr.length, 1);
    assert.match(
      result.stderr[0] ?? "",
      /osascript failed.*start Companion manually.*open failed/,
    );
  });
});

describe("live-install mode: pipeline order with the snapshot check", () => {
  it("runs the writer's snapshot check before the quit and its locked check after the backup", async () => {
    const { home, dbPath } = fakeHome();
    const fake = fakeProcessControl({ running: true });
    await apply(
      {
        descriptionPath: writeDescription(home, VARIABLES_YAML),
        writers: {
          variables: {
            ...variablesWriter,
            check: (db) =>
              void fake.calls.push(
                db.isTransaction ? "locked check" : "snapshot check",
              ),
          } as Writer,
        },
      },
      {
        homedir: home,
        platform: "darwin",
        processControl: fake.control,
        hooks: recordingHooks(fake.calls),
      },
    );
    assert.deepEqual(fake.calls, [
      "check",
      "snapshot check",
      "check",
      "quit",
      "wait",
      "holders",
      "backup",
      "locked check",
      "write",
      "integrity",
      "start",
    ]);
    assert.ok(customVariables(dbPath)["live_one"]);
  });

  it("starts Companion when opening the database for writing fails", async () => {
    const { home, file } = fakeHome();
    const result = await liveApply(home, file, { running: true }, (calls) => ({
      ...recordingHooks(calls),
      afterBackup: (path) => {
        calls.push("backup");
        // A directory in place of the database file cannot be opened.
        rmSync(path);
        mkdirSync(path);
      },
    }));
    assert.equal(result.code, 1);
    assert.equal(result.stderr.length, 1);
    assert.match(
      result.stderr[0] ?? "",
      /cannot open database .* for writing.*backup kept at/,
    );
    assert.deepEqual(result.calls, [
      "check",
      "check",
      "quit",
      "wait",
      "holders",
      "backup",
      "start",
    ]);
  });
});

describe("live-install mode: platform", () => {
  it("refuses a non-macOS platform before touching any file or process", async () => {
    const { home, dbPath } = fakeHome();
    const before = fileState(dbPath);
    const fake = fakeProcessControl({ running: true });
    const result = await runCli(
      ["apply", join(home, "missing-description.yaml")],
      { homedir: home, platform: "linux", processControl: fake.control },
    );
    assert.equal(result.code, 1);
    assert.equal(result.stderr.length, 1);
    assert.match(result.stderr[0] ?? "", /unsupported platform "linux"/);
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(fileState(dbPath), before);
  });

  it("accepts --db on a non-macOS platform with no process check, even at the install path", async () => {
    const { home, dbPath, file } = fakeHome();
    const fake = fakeProcessControl({ running: true, holders: [999] });
    const result = await runCli(["apply", file, "--db", dbPath], {
      homedir: home,
      platform: "linux",
      processControl: fake.control,
    });
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(fake.calls, []);
    assert.ok(customVariables(dbPath)["live_one"]);
  });
});

/**
 * Why a file symlink cannot be created here, or `false` when it can. Windows
 * refuses file symlinks without Developer Mode or elevation (`EPERM`).
 */
function fileSymlinkSkip(): string | false {
  const dir = tempDir();
  const target = join(dir, "target");
  writeFileSync(target, "");
  try {
    symlinkSync(target, join(dir, "link"), "file");
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    return "file symlinks need Developer Mode or elevation on Windows (EPERM); see #34";
  }
}

describe("--db: the install's database and the running guard", () => {
  const FILE_SYMLINK_SKIP = fileSymlinkSkip();

  /**
   * The install's database directly, through a directory link and through
   * `~`. The directory link is a junction on Windows, which needs no Developer
   * Mode; the type is ignored elsewhere.
   */
  function targets(home: string, dbPath: string): string[] {
    const linkDir = join(tempDir(), "linked");
    symlinkSync(
      join(home, "Library", "Application Support", "companion"),
      linkDir,
      "junction",
    );
    return [
      dbPath,
      join(linkDir, "v5.1", "db.sqlite"),
      "~/Library/Application Support/companion/v5.1/db.sqlite",
    ];
  }

  function fileSymlink(dbPath: string): string {
    const link = join(tempDir(), "link.sqlite");
    symlinkSync(dbPath, link, "file");
    return link;
  }

  async function assertRefusedWhileRunning(
    { home, dbPath, file }: ReturnType<typeof fakeHome>,
    target: string,
  ): Promise<void> {
    const before = fileState(dbPath);
    const fake = fakeProcessControl({ running: true });
    const result = await runCli(["apply", file, "--db", target], {
      homedir: home,
      processControl: fake.control,
    });
    assert.equal(result.code, 1, target);
    assert.equal(result.stderr.length, 1);
    assert.match(
      result.stderr[0] ?? "",
      /^error: refusing to write the Companion install's database .* while Companion is running/,
    );
    assert.deepEqual(fake.calls, ["check"], target);
    assert.deepEqual(fileState(dbPath), before, target);
  }

  async function assertWrittenWhileStopped(
    { home, dbPath, file }: ReturnType<typeof fakeHome>,
    target: string,
  ): Promise<void> {
    const fake = fakeProcessControl({ running: false });
    const result = await runCli(["apply", file, "--db", target], {
      homedir: home,
      processControl: fake.control,
      now: () => new Date("2026-10-14T12:34:56.789Z"),
    });
    assert.equal(result.code, 0, `${target}: ${result.stderr.join("\n")}`);
    assert.deepEqual(fake.calls, ["check", "holders"], target);
    assert.ok(customVariables(dbPath)["live_one"]);
  }

  it("refuses the install's database (direct, symlinked directory, ~) while Companion runs", async () => {
    const env = fakeHome({ wal: true });
    for (const target of targets(env.home, env.dbPath)) {
      await assertRefusedWhileRunning(env, target);
    }
  });

  it(
    "refuses a file symlink to the install's database while Companion runs",
    {
      skip: FILE_SYMLINK_SKIP,
    },
    async () => {
      const env = fakeHome({ wal: true });
      await assertRefusedWhileRunning(env, fileSymlink(env.dbPath));
    },
  );

  it("refuses a hard link to the install's database while Companion runs", async () => {
    const { home, dbPath, file } = fakeHome();
    const hard = join(home, "hard.sqlite");
    linkSync(dbPath, hard);
    const fake = fakeProcessControl({ running: true });
    const result = await runCli(["apply", file, "--db", hard], {
      homedir: home,
      processControl: fake.control,
    });
    assert.equal(result.code, 1);
    assert.deepEqual(fake.calls, ["check"]);
  });

  it("writes the install's database with only the running and in-use checks while Companion is stopped", async () => {
    const env = fakeHome();
    for (const target of targets(env.home, env.dbPath)) {
      await assertWrittenWhileStopped(env, target);
    }
    assert.ok(
      readdirSync(join(installDir(env.home), "companion-cli-backups")).length >
        0,
    );
  });

  it(
    "writes the install's database through a file symlink while Companion is stopped",
    {
      skip: FILE_SYMLINK_SKIP,
    },
    async () => {
      const env = fakeHome();
      await assertWrittenWhileStopped(env, fileSymlink(env.dbPath));
    },
  );

  it("fails closed when the running check fails", async () => {
    const { home, dbPath, file } = fakeHome();
    const before = fileState(dbPath);
    const fake = fakeProcessControl({ running: false, failCheck: true });
    const result = await runCli(["apply", file, "--db", dbPath], {
      homedir: home,
      processControl: fake.control,
    });
    assert.equal(result.code, 1);
    assert.match(
      result.stderr[0] ?? "",
      /cannot tell whether Companion is running.*ps exploded/,
    );
    assert.deepEqual(fileState(dbPath), before);
  });

  it("checks only whether a copy elsewhere is in use, never Companion's process", async () => {
    const { home, file } = fakeHome();
    const copyDir = join(home, "copies");
    mkdirSync(copyDir);
    const copy = buildFixtureDb(copyDir);
    const fake = fakeProcessControl({ running: true });
    const result = await runCli(["apply", file, "--db", copy], {
      homedir: home,
      processControl: fake.control,
    });
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(fake.calls, ["check", "holders"]);
    assert.deepEqual(
      customVariables(copy)["fx_label"],
      FIXTURE_VARIABLES.fx_label,
    );
  });
});

describe("in-use guard: refuse a database another process holds", () => {
  function copyIn(home: string) {
    const copyDir = join(home, "copies");
    mkdirSync(copyDir);
    return buildFixtureDb(copyDir, { wal: true });
  }

  it("--db refuses a copy held by another process and leaves it byte-identical", async () => {
    const { home, file } = fakeHome();
    const copy = copyIn(home);
    const before = fileState(copy);
    const fake = fakeProcessControl({ running: false, holders: [999, 1000] });
    const result = await runCli(["apply", file, "--db", copy], {
      homedir: home,
      processControl: fake.control,
    });
    assert.equal(result.code, 1);
    assert.equal(result.stderr.length, 1);
    assert.match(
      result.stderr[0] ?? "",
      /^error: refusing to write .*: the database is open in another process \(PID 999, 1000\)/,
    );
    assert.deepEqual(fake.calls, ["check", "holders"]);
    assert.deepEqual(fileState(copy), before);
    assert.equal(
      existsSync(join(home, "copies", "companion-cli-backups")),
      false,
    );
  });

  it("ignores this process as a holder", async () => {
    const { home, file } = fakeHome();
    const copy = copyIn(home);
    const fake = fakeProcessControl({ running: false, holders: [process.pid] });
    const result = await runCli(["apply", file, "--db", copy], {
      homedir: home,
      processControl: fake.control,
    });
    assert.equal(result.code, 0, result.stderr.join("\n"));
  });

  it("--db fails closed when the in-use check fails", async () => {
    const { home, file } = fakeHome();
    const copy = copyIn(home);
    const before = fileState(copy);
    const fake = fakeProcessControl({ running: false, failHolders: true });
    const result = await runCli(["apply", file, "--db", copy], {
      homedir: home,
      processControl: fake.control,
    });
    assert.equal(result.code, 1);
    assert.match(
      result.stderr[0] ?? "",
      /cannot tell whether the database is in use.*lsof exploded/,
    );
    assert.deepEqual(fileState(copy), before);
  });

  it("Windows --db runs the in-use check, and nothing else of the process control", async () => {
    const { home, file } = fakeHome();
    const copy = copyIn(home);
    const fake = fakeProcessControl({ running: true });
    const result = await runCli(["apply", file, "--db", copy], {
      homedir: home,
      platform: "win32",
      processControl: fake.control,
    });
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(fake.calls, ["check", "holders"]);
  });

  /**
   * The Windows control with an injected opener that fails every open of the
   * database file with `code` and finds no `-wal` / `-shm`, and a listing
   * with no Companion running.
   */
  function windowsControlFailing(dbPath: string, code: string) {
    return windowsProcessControl({
      run: async () => ({ status: 0, stdout: "[]", stderr: "" }),
      open: async (path) => {
        throw Object.assign(new Error(`${code}: open ${path}`), {
          code: path === dbPath ? code : "ENOENT",
        });
      },
      sleep: async () => {},
    });
  }

  for (const [name, code, message] of [
    [
      "refuses a database another process holds",
      "EBUSY",
      /^refusing to write .*: the database is open in another process; close it first$/,
    ],
    [
      "fails closed on an unexpected probe error",
      "EACCES",
      /^cannot tell whether the database is in use \(EACCES: open .*\); refusing to write /,
    ],
  ] as const) {
    it(`Windows --db ${name}, byte-identical`, async () => {
      const { home, file } = fakeHome();
      const copy = copyIn(home);
      const before = fileState(copy);
      const result = await runCli(["apply", file, "--db", copy, "--json"], {
        homedir: home,
        platform: "win32",
        processControl: windowsControlFailing(copy, code),
      });
      assert.equal(result.code, 1);
      const doc = JSON.parse(result.stdout.join("\n")) as {
        error: { code: string; message: string };
      };
      assert.equal(doc.error.code, "companion_running");
      assert.match(doc.error.message, message);
      assert.deepEqual(fileState(copy), before);
      assert.equal(
        existsSync(join(home, "copies", "companion-cli-backups")),
        false,
      );
    });
  }

  it("live mode, not running: refuses a held database without quitting or starting", async () => {
    const { home, dbPath, file } = fakeHome({ wal: true });
    const before = fileState(dbPath);
    const result = await liveApply(home, file, {
      running: false,
      holders: [999],
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr[0] ?? "", /open in another process \(PID 999\)/);
    assert.deepEqual(result.calls, ["check", "check", "holders"]);
    assert.deepEqual(fileState(dbPath), before);
  });

  for (const [name, options] of [
    ["held after the quit", { holders: [999] }],
    ["the in-use check fails after the quit", { failHolders: true }],
  ] as const) {
    it(`live mode: ${name} refuses, leaves the files byte-identical and starts Companion`, async () => {
      const { home, dbPath, file } = fakeHome({ wal: true });
      const before = fileState(dbPath);
      const result = await liveApply(home, file, { running: true, ...options });
      assert.equal(result.code, 1);
      assert.equal(result.stderr.length, 1);
      assert.match(
        result.stderr[0] ?? "",
        /open in another process|cannot tell whether the database is in use/,
      );
      assert.deepEqual(result.calls, [
        "check",
        "check",
        "quit",
        "wait",
        "holders",
        "start",
      ]);
      assert.deepEqual(fileState(dbPath), before);
      assert.equal(
        existsSync(join(installDir(home), "companion-cli-backups")),
        false,
      );
    });
  }
});

describe("apply: command line", () => {
  it("documents both forms and no longer requires --db", async () => {
    assert.match(
      USAGE,
      /apply <description-file> \[--db <path-to-db\.sqlite>\]/,
    );
    const home = tempDir();
    const result = await runCli(["apply", join(home, "missing.yaml")], {
      homedir: home,
    });
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr[0] ?? "", /--db is required/);
    assert.match(result.stderr[0] ?? "", /cannot read description file/);
  });
});
