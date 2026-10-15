/**
 * Commands without `--db` on Windows (`platform: "win32"`): read commands and
 * dry runs target `<APPDATA>\companion\v5.1\db.sqlite`, and so do
 * live-install writes (the quit, wait and restart are faked here).
 *
 * Windows paths use Windows path rules on every host, so the tests that need
 * the fixture at the Windows install path run on a Windows host only (the
 * Windows CI job). The refusals and the resolved path run everywhere.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { win32 } from "node:path";
import { describe, it } from "node:test";
import { buildFixtureDb } from "./fixtures/companion-db.ts";
import {
  customVariables,
  fakeProcessControl,
  fileState,
  forbiddenProcessControl,
  windowsInstallDir,
  runCli,
  tempDir,
  WINDOWS_HOST_ONLY,
  writeDescription,
} from "./helpers.ts";

const VARIABLES_YAML =
  "kind: variables\nvariables:\n  - {name: windows_var, default: 1}\n";

/** A temp home and APPDATA, with a fixture database at the Windows install path. */
function windowsInstall() {
  const home = tempDir();
  const appData = tempDir();
  const dbPath = buildFixtureDb(windowsInstallDir(appData), { wal: true });
  const { control, calls } = forbiddenProcessControl();
  return {
    dbPath,
    calls,
    options: {
      homedir: home,
      platform: "win32" as const,
      env: { APPDATA: appData },
      processControl: control,
    },
  };
}

describe("Windows install: read commands and dry runs without --db", () => {
  const commands: Array<[string, (dir: string) => string[]]> = [
    ["list pages", () => ["list", "pages"]],
    ["export page", () => ["export", "page", "1"]],
    ["validate", (dir) => ["validate", writeDescription(dir, VARIABLES_YAML)]],
    [
      "apply --dry-run",
      (dir) => ["apply", writeDescription(dir, VARIABLES_YAML), "--dry-run"],
    ],
  ];
  for (const [name, argv] of commands) {
    it(
      `${name} reads the install's database and leaves it byte-identical`,
      { skip: WINDOWS_HOST_ONLY },
      async () => {
        const { dbPath, calls, options } = windowsInstall();
        const before = fileState(dbPath);
        const files = readdirSync(win32.dirname(dbPath)).sort();
        const result = await runCli(argv(tempDir()), options);
        assert.equal(result.code, 0, result.stderr.join("\n"));
        assert.deepEqual(fileState(dbPath), before);
        assert.deepEqual(calls, []);
        // No backup directory or other file appears next to the database.
        assert.deepEqual(readdirSync(win32.dirname(dbPath)).sort(), files);
      },
    );
  }

  it("names the Windows install's database when it is missing", async () => {
    const { control, calls } = forbiddenProcessControl();
    const result = await runCli(["list", "pages"], {
      homedir: "C:\\Users\\nobody",
      platform: "win32",
      env: { APPDATA: "C:\\Users\\nobody\\AppData\\Roaming" },
      processControl: control,
    });
    assert.equal(result.code, 1);
    assert.deepEqual(result.stderr, [
      "error: database not found: C:\\Users\\nobody\\AppData\\Roaming\\companion\\v5.1\\db.sqlite (from the default configuration folder)",
    ]);
    assert.deepEqual(calls, []);
  });

  it("falls back to <home>\\AppData\\Roaming without APPDATA", async () => {
    const result = await runCli(["list", "pages", "--json"], {
      homedir: "C:\\Users\\nobody",
      platform: "win32",
      env: {},
    });
    assert.equal(result.code, 1);
    const document = JSON.parse(result.stdout[0] ?? "") as {
      error: { code: string; message: string };
    };
    assert.equal(document.error.code, "database_not_found");
    assert.equal(
      document.error.message,
      "database not found: C:\\Users\\nobody\\AppData\\Roaming\\companion\\v5.1\\db.sqlite (from the default configuration folder)",
    );
  });
});

describe("Windows install: apply --db while Companion runs", () => {
  it(
    "refuses the install's database while a server runs, writing nothing",
    { skip: WINDOWS_HOST_ONLY },
    async () => {
      const { dbPath, options } = windowsInstall();
      const before = fileState(dbPath);
      const fake = fakeProcessControl({ running: true });
      const file = writeDescription(tempDir(), VARIABLES_YAML);
      // Another spelling of the same file: NTFS ignores case.
      for (const target of [dbPath, dbPath.toUpperCase()]) {
        fake.calls.length = 0;
        const result = await runCli(["apply", file, "--db", target], {
          ...options,
          processControl: fake.control,
        });
        assert.equal(result.code, 1, target);
        assert.deepEqual(result.stderr, [
          `error: refusing to write the Companion install's database (${target}) while Companion is running; quit Companion or omit --db to let the tool stop and restart it`,
        ]);
        assert.deepEqual(fake.calls, ["check"], target);
      }
      assert.deepEqual(fileState(dbPath), before);
    },
  );

  it(
    "fails closed when the process listing fails",
    { skip: WINDOWS_HOST_ONLY },
    async () => {
      const { dbPath, options } = windowsInstall();
      const before = fileState(dbPath);
      const fake = fakeProcessControl({ running: true, failCheck: true });
      const file = writeDescription(tempDir(), VARIABLES_YAML);
      const result = await runCli(["apply", file, "--db", dbPath, "--json"], {
        ...options,
        processControl: fake.control,
      });
      assert.equal(result.code, 1);
      const document = JSON.parse(result.stdout[0] ?? "") as {
        error: { code: string; message: string };
      };
      assert.equal(document.error.code, "companion_running");
      assert.match(
        document.error.message,
        /^cannot tell whether Companion is running \(ps exploded\); refusing to write$/,
      );
      assert.deepEqual(fake.calls, ["check"]);
      assert.deepEqual(fileState(dbPath), before);
    },
  );

  it("writes another copy while a server runs, after the in-use check", async () => {
    const dbPath = buildFixtureDb(tempDir());
    const fake = fakeProcessControl({ running: true });
    const file = writeDescription(tempDir(), VARIABLES_YAML);
    const result = await runCli(["apply", file, "--db", dbPath], {
      homedir: tempDir(),
      platform: "win32",
      env: { APPDATA: tempDir() },
      processControl: fake.control,
    });
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(fake.calls, ["check", "holders"]);
  });
});

describe("Windows install: live-install writes", () => {
  for (const running of [false, true]) {
    it(
      `apply without --db writes the install's database (Companion ${running ? "running" : "stopped"})`,
      { skip: WINDOWS_HOST_ONLY },
      async () => {
        const appData = tempDir();
        const dbPath = buildFixtureDb(windowsInstallDir(appData), {
          wal: true,
        });
        const fake = fakeProcessControl({ running });
        const file = writeDescription(tempDir(), VARIABLES_YAML);
        const result = await runCli(["apply", file], {
          homedir: tempDir(),
          platform: "win32",
          env: { APPDATA: appData },
          processControl: fake.control,
        });
        assert.equal(result.code, 0, result.stderr.join("\n"));
        assert.ok(customVariables(dbPath)["windows_var"]);
        assert.deepEqual(
          fake.calls,
          running
            ? [
                "check",
                "check",
                "session",
                "quit",
                "wait",
                "holders",
                "start",
                "started",
              ]
            : ["check", "holders"],
        );
        assert.equal(fake.launches.length, running ? 1 : 0);
        assert.ok(
          existsSync(
            win32.join(win32.dirname(dbPath), "companion-cli-backups"),
          ),
        );
      },
    );
  }
});
