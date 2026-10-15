/**
 * Companion's configuration folder (#43): without `--db`, the install's
 * database is `<root>/v5.1/db.sqlite`, with the root from the running
 * server's `--config-dir`, else `COMPANION_CONFIG_BASEDIR`, else the platform
 * default. Each case keeps a fixture at the default path too, so a command
 * that ignored the folder would read or write the wrong database.
 *
 * Windows paths use Windows path rules on every host, so the Windows cases
 * that need files on disk run on a Windows host only (the Windows CI job);
 * the paths they resolve are asserted everywhere.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join, win32 } from "node:path";
import { describe, it } from "node:test";
import type { ProcessControl } from "../src/core/process.ts";
import { buildFixtureDb } from "./fixtures/companion-db.ts";
import {
  customVariables,
  fakeProcessControl,
  fileState,
  installDir,
  runCli,
  tempDir,
  WINDOWS_HOST_ONLY,
  windowsInstallDir,
  writeDescription,
} from "./helpers.ts";

const VARIABLES_YAML =
  "kind: variables\nvariables:\n  - {name: folder_var, default: 1}\n";

type Platform = "darwin" | "win32";

/** How the custom folder is chosen. */
type Rule = "environment" | "server";

/**
 * A temp home with a fixture at the platform's default path and another in a
 * custom folder with a space in its name, chosen by `rule`.
 */
function customInstall(platform: Platform, rule: Rule) {
  const home = tempDir();
  const appData = tempDir();
  const pathOf = platform === "win32" ? win32 : { join };
  const root = pathOf.join(tempDir(), "stream configs");
  const defaultDb = buildFixtureDb(
    platform === "win32" ? windowsInstallDir(appData) : installDir(home),
    { wal: true },
  );
  const dbPath = buildFixtureDb(pathOf.join(root, "v5.1"), { wal: true });
  const fake = fakeProcessControl({
    running: rule === "server",
    // As the launcher passes it: with a trailing separator.
    configDir: `${root}${platform === "win32" ? "\\" : "/"}`,
  });
  return {
    root,
    dbPath,
    defaultDb,
    calls: fake.calls,
    options: {
      homedir: home,
      platform,
      env: {
        APPDATA: appData,
        ...(rule === "environment" ? { COMPANION_CONFIG_BASEDIR: root } : {}),
      },
      processControl: fake.control,
    },
  };
}

const SOURCE = { environment: "environment", server: "server" } as const;

const READ_COMMANDS: Array<[string, (dir: string) => string[], boolean]> = [
  ["list pages", () => ["list", "pages", "--json"], true],
  ["list variables", () => ["list", "variables", "--json"], true],
  ["find", () => ["find", "--variable", "fx_*", "--json"], true],
  ["export page", () => ["export", "page", "1"], false],
  [
    "validate",
    (dir) => ["validate", writeDescription(dir, VARIABLES_YAML), "--json"],
    true,
  ],
  [
    "apply --dry-run",
    (dir) => [
      "apply",
      writeDescription(dir, VARIABLES_YAML),
      "--dry-run",
      "--json",
    ],
    true,
  ],
];

for (const platform of ["darwin", "win32"] as const) {
  const skip = platform === "win32" ? WINDOWS_HOST_ONLY : false;
  for (const rule of ["environment", "server"] as const) {
    describe(`configuration folder (${platform}, from the ${rule}): read commands and dry runs without --db`, () => {
      for (const [name, argv, json] of READ_COMMANDS) {
        it(
          `${name} reads the folder's database and leaves both byte-identical`,
          { skip },
          async () => {
            const { dbPath, defaultDb, options } = customInstall(
              platform,
              rule,
            );
            const before = [fileState(dbPath), fileState(defaultDb)];
            const files = readdirSync(join(dbPath, "..")).sort();
            const result = await runCli(argv(tempDir()), options);
            assert.equal(result.code, 0, result.stderr.join("\n"));
            if (json) {
              const document = JSON.parse(result.stdout[0] ?? "") as Record<
                string,
                unknown
              >;
              assert.equal(document["database"], dbPath);
              assert.equal(document["databaseSource"], SOURCE[rule]);
            }
            assert.deepEqual([fileState(dbPath), fileState(defaultDb)], before);
            assert.deepEqual(readdirSync(join(dbPath, "..")).sort(), files);
          },
        );
      }
    });
  }

  describe(`configuration folder (${platform}): the resolved path, on any host`, () => {
    const home = platform === "win32" ? "C:\\Users\\nobody" : "/nowhere-home";
    const root = platform === "win32" ? "D:\\Repos\\cfg" : "/nowhere/cfg";
    const missing =
      platform === "win32"
        ? "D:\\Repos\\cfg\\v5.1\\db.sqlite"
        : // macOS paths use host path rules.
          join("/nowhere/cfg", "v5.1", "db.sqlite");
    const cases: Array<[string, Record<string, string>, boolean, string]> = [
      [
        "COMPANION_CONFIG_BASEDIR",
        {
          COMPANION_CONFIG_BASEDIR: `${root}${platform === "win32" ? "\\" : "/"}`,
        },
        false,
        "COMPANION_CONFIG_BASEDIR",
      ],
      [
        "the running server's --config-dir, over the variable",
        {
          COMPANION_CONFIG_BASEDIR:
            platform === "win32" ? "E:\\other" : "/other",
        },
        true,
        "the running Companion's --config-dir",
      ],
    ];
    for (const [name, env, running, rule] of cases) {
      for (const argv of [["list", "pages"], ["census"]]) {
        it(`${argv.join(" ")} names the database in ${name}`, async () => {
          const fake = fakeProcessControl({ running, configDir: root });
          const result = await runCli(argv, {
            homedir: home,
            platform,
            env: { APPDATA: `${home}\\AppData\\Roaming`, ...env },
            processControl: fake.control,
          });
          assert.equal(result.code, 1);
          assert.deepEqual(result.stderr, [
            `error: database not found: ${missing} (from ${rule})`,
          ]);
          assert.deepEqual(fake.calls, ["check"]);
        });
      }
    }

    it("refuses servers on different folders", async () => {
      const control = twoServers(platform, root);
      const result = await runCli(["list", "pages", "--json"], {
        homedir: home,
        platform,
        env: {},
        processControl: control,
      });
      assert.equal(result.code, 1);
      const document = JSON.parse(result.stdout[0] ?? "") as {
        error: { code: string; message: string };
      };
      assert.equal(document.error.code, "companion_running");
      assert.match(
        document.error.message,
        /^Companion servers are running with different configuration folders/,
      );
    });

    it("refuses when the listing that locates the folder fails", async () => {
      const fake = fakeProcessControl({ running: true, failCheck: true });
      const result = await runCli(["list", "pages", "--json"], {
        homedir: home,
        platform,
        env: { COMPANION_CONFIG_BASEDIR: root },
        processControl: fake.control,
      });
      assert.equal(result.code, 1);
      const document = JSON.parse(result.stdout[0] ?? "") as {
        error: { code: string; hint: string };
      };
      assert.equal(document.error.code, "companion_running");
      assert.equal(document.error.hint, "pass --db <path>");
    });
  });

  describe(`configuration folder (${platform}): apply --db while a server runs on it`, () => {
    it(
      "refuses the folder's database and writes nothing",
      { skip },
      async () => {
        const { dbPath, options } = customInstall(platform, "server");
        const before = fileState(dbPath);
        const file = writeDescription(tempDir(), VARIABLES_YAML);
        const result = await runCli(
          ["apply", file, "--db", dbPath, "--json"],
          options,
        );
        assert.equal(result.code, 1);
        const document = JSON.parse(result.stdout[0] ?? "") as {
          error: { code: string; message: string };
        };
        assert.equal(document.error.code, "companion_running");
        assert.match(
          document.error.message,
          /^refusing to write the Companion install's database/,
        );
        assert.deepEqual(fileState(dbPath), before);
      },
    );

    it(
      "writes the default folder's database, which the server does not use",
      { skip },
      async () => {
        const { defaultDb, calls, options } = customInstall(platform, "server");
        const file = writeDescription(tempDir(), VARIABLES_YAML);
        const result = await runCli(
          ["apply", file, "--db", defaultDb],
          options,
        );
        assert.equal(result.code, 0, result.stderr.join("\n"));
        assert.deepEqual(calls, ["check", "holders"]);
        assert.ok(customVariables(defaultDb)["folder_var"]);
      },
    );
  });
}

/** Two servers, on `root` and on another folder. */
function twoServers(platform: Platform, root: string): ProcessControl {
  const other = platform === "win32" ? "E:\\other" : "/other";
  const one = fakeProcessControl({ running: true, configDir: root }).control;
  const two = fakeProcessControl({ running: true, configDir: other }).control;
  return {
    ...one,
    servers: async () => [
      ...(await one.servers()),
      ...(await two.servers()).map((server) => ({ ...server, pid: 4343 })),
    ],
  };
}

describe("configuration folder (darwin): live apply", () => {
  for (const rule of ["environment", "server"] as const) {
    it(`writes the database in the folder from the ${rule}, not the default`, async () => {
      const { dbPath, defaultDb, calls, options } = customInstall(
        "darwin",
        rule,
      );
      const defaultBefore = fileState(defaultDb);
      const file = writeDescription(tempDir(), VARIABLES_YAML);
      const result = await runCli(["apply", file, "--json"], options);
      assert.equal(result.code, 0, result.stderr.join("\n"));
      const document = JSON.parse(result.stdout[0] ?? "") as Record<
        string,
        unknown
      >;
      assert.equal(document["database"], dbPath);
      assert.equal(document["databaseSource"], SOURCE[rule]);
      assert.ok(customVariables(dbPath)["folder_var"]);
      assert.deepEqual(fileState(defaultDb), defaultBefore);
      assert.ok(existsSync(join(dbPath, "..", "companion-cli-backups")));
      assert.deepEqual(
        calls,
        rule === "server"
          ? ["check", "check", "quit", "wait", "holders", "start"]
          : ["check", "check", "holders"],
      );
    });
  }

  it("refuses when the server runs on another folder by the time it would quit", async () => {
    const { dbPath, options } = customInstall("darwin", "environment");
    const before = fileState(dbPath);
    // The first listing finds none; Companion starts on another folder before
    // the second.
    const later = fakeProcessControl({ running: true, configDir: "/other/" });
    let listings = 0;
    const control: ProcessControl = {
      ...later.control,
      servers: async () =>
        listings++ === 0 ? [] : await later.control.servers(),
    };
    const file = writeDescription(tempDir(), VARIABLES_YAML);
    const result = await runCli(["apply", file, "--json"], {
      ...options,
      processControl: control,
    });
    assert.equal(result.code, 1);
    const document = JSON.parse(result.stdout[0] ?? "") as {
      error: { code: string; message: string; hint: string };
    };
    assert.equal(document.error.code, "companion_running");
    assert.equal(
      document.error.message,
      `Companion is running with the configuration folder /other, not ${join(dbPath, "..", "..")}; nothing written`,
    );
    assert.deepEqual(later.calls, ["check"]);
    assert.deepEqual(fileState(dbPath), before);
  });
});
