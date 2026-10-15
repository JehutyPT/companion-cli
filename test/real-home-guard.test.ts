import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { run } from "../src/cli.ts";
import { apply, prepareApply } from "../src/core/apply.ts";
import { DEFAULT_DATABASE_RELATIVE_PATH } from "../src/core/paths.ts";
import { writers } from "../src/writers/index.ts";
import { buildFixtureDb } from "./fixtures/companion-db.ts";
import {
  customVariables,
  installDir,
  printedBackupDir,
  STOPPED_PROCESS_CONTROL,
  tempDir,
  writeDescription,
} from "./helpers.ts";
import { REAL_HOMES, TEST_HOME } from "./setup.ts";

const YAML =
  "kind: variables\nvariables:\n  - {name: home_guard, default: 1}\n";

/**
 * Reproduces the incident where `runApply` dropped `homedir` and `apply` fell
 * back to `os.homedir()`: with the test bootstrap, that fallback is a temp
 * home, never the real one.
 */
describe("a missing homedir option in tests", () => {
  beforeEach(() =>
    rmSync(join(TEST_HOME, "Library"), { recursive: true, force: true }),
  );

  it("resolves os.homedir() to the test home", () => {
    assert.equal(homedir(), TEST_HOME);
    for (const real of REAL_HOMES) assert.notEqual(homedir(), real);
  });

  it("points the Windows profile and app-data variables at the test home", () => {
    assert.equal(process.env["USERPROFILE"], TEST_HOME);
    assert.equal(process.env["APPDATA"], TEST_HOME);
    assert.equal(process.env["LOCALAPPDATA"], undefined);
    assert.equal(process.env["XDG_CONFIG_HOME"], undefined);
  });

  it("makes a live apply without homedir target the test home", async () => {
    const dir = tempDir();
    const file = writeDescription(dir, YAML);
    const dbPath = join(TEST_HOME, DEFAULT_DATABASE_RELATIVE_PATH);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const cli = () =>
      run(
        ["apply", file],
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
        {
          env: {},
          cwd: dir,
          platform: "darwin",
          processControl: STOPPED_PROCESS_CONTROL,
        },
      );

    // Read-only first: with no database yet, the error names the resolved path.
    assert.equal(await cli(), 1);
    assert.deepEqual(stderr, [`error: database not found: ${dbPath}`]);

    buildFixtureDb(installDir(TEST_HOME));
    assert.equal(await cli(), 0, stderr.join("\n"));
    assert.ok(
      printedBackupDir({ code: 0, stdout, stderr })?.startsWith(TEST_HOME),
    );
    assert.equal(
      (customVariables(dbPath)["home_guard"] as { defaultValue: number })
        .defaultValue,
      1,
    );
  });

  it("makes prepareApply and apply default to the test home", async () => {
    const dir = tempDir();
    const file = writeDescription(dir, YAML);
    const request = { descriptionPath: file, writers };
    const options = {
      platform: "darwin" as const,
      processControl: STOPPED_PROCESS_CONTROL,
      log: () => {},
    };
    buildFixtureDb(installDir(TEST_HOME));
    const prepared = await prepareApply(request, options);
    assert.equal(prepared.homedir, TEST_HOME);
    assert.ok(prepared.dbPath.startsWith(TEST_HOME + sep));
    const result = await apply(request, options);
    assert.ok(result.backupDir.startsWith(TEST_HOME + sep));
  });
});
