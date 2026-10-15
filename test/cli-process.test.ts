import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildFixtureDb } from "./fixtures/companion-db.ts";
import {
  customVariables,
  fileState,
  tempDir,
  writeDescription,
} from "./helpers.ts";

const BIN = fileURLToPath(
  new URL("../src/bin/companion-cli.ts", import.meta.url),
);

/** Variables `homeEnv` points at the test home. */
const HOME_VARIABLES = ["HOME", "USERPROFILE", "APPDATA"] as const;

/**
 * Variables the child must not inherit from the parent, upper-cased because
 * Windows variable names are case-insensitive: they name real profile
 * directories.
 */
const DROPPED = new Set<string>([
  ...HOME_VARIABLES,
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
]);

/**
 * The parent environment without any `COMPANION_*` variable, `XDG_CONFIG_HOME`
 * or `LOCALAPPDATA`, with `HOME`, `USERPROFILE` and `APPDATA` pointing at
 * `home`. The child's home directory, Windows profile, app-data directory and
 * user config file are then all under `home`.
 */
function homeEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase();
    if (!upper.startsWith("COMPANION_") && !DROPPED.has(upper)) {
      env[name] = value;
    }
  }
  for (const name of HOME_VARIABLES) env[name] = home;
  return env;
}

/**
 * Runs the executable in `home` with its home pointing there, so it never
 * sees the repository's `.env.local`, the user's config file or the real
 * Companion install.
 */
function cli(args: string[], home: string) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    cwd: home,
    env: homeEnv(home),
  });
}

/**
 * The executable's `--db` in-use guard runs `lsof` on macOS and an exclusive
 * open on Windows (#38); Linux has none yet (#42).
 */
const LSOF_GUARD_SKIP =
  process.platform === "win32"
    ? "Windows probes with an exclusive open, not lsof (tested below)"
    : process.platform === "linux"
      ? "the --db in-use guard does not run on Linux (#42)"
      : false;

describe("companion-cli executable", () => {
  // The executable uses the real process control, whose command runner
  // refuses inside the test runner (NODE_TEST_CONTEXT is inherited). So a
  // valid apply exercises the in-use guard failing closed instead of running
  // lsof; successful applies are covered in-process with fakes.
  it(
    "fails closed, byte-identical, when the in-use check cannot run",
    {
      skip: LSOF_GUARD_SKIP,
    },
    () => {
      const dir = tempDir();
      const dbPath = buildFixtureDb(join(dir, "copy"));
      const before = fileState(dbPath);
      const file = writeDescription(
        dir,
        "kind: variables\nvariables:\n  - {name: from_bin, default: 1}\n",
      );
      const result = cli(["apply", file, "--db", dbPath], dir);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(
        result.stderr.trimEnd().split("\n").length,
        1,
        result.stderr,
      );
      assert.match(
        result.stderr,
        /^error: cannot tell whether the database is in use \(refusing to run lsof inside the test runner/,
      );
      assert.deepEqual(fileState(dbPath), before);
      assert.equal(
        existsSync(join(dir, "copy", "companion-cli-backups")),
        false,
      );
    },
  );

  // The Windows probe only opens and closes files, so it runs for real inside
  // the test runner.
  it(
    "on Windows, refuses a database another process holds open, then applies once it is closed",
    {
      skip:
        process.platform === "win32"
          ? false
          : "the exclusive-open probe exists only on Windows",
    },
    () => {
      const dir = tempDir();
      const dbPath = buildFixtureDb(join(dir, "copy"), { wal: true });
      const file = writeDescription(
        dir,
        "kind: variables\nvariables:\n  - {name: from_bin, default: 1}\n",
      );
      const holder = new DatabaseSync(dbPath);
      let closed = false;
      try {
        holder.prepare("select count(*) from sqlite_master").get();
        const before = fileState(dbPath);
        const refused = cli(["apply", file, "--db", dbPath], dir);
        assert.equal(refused.status, 1, refused.stderr);
        assert.equal(
          refused.stderr.trimEnd().split("\n").length,
          1,
          refused.stderr,
        );
        assert.match(
          refused.stderr,
          /^error: refusing to write .*: the database is open in another process; close it first/,
        );
        assert.deepEqual(fileState(dbPath), before);
        assert.equal(
          existsSync(join(dir, "copy", "companion-cli-backups")),
          false,
        );
        holder.close();
        closed = true;
        const applied = cli(["apply", file, "--db", dbPath], dir);
        assert.equal(applied.status, 0, applied.stderr);
        assert.ok(customVariables(dbPath)["from_bin"]);
      } finally {
        if (!closed) holder.close();
      }
    },
  );

  it("exits non-zero with exactly one stderr line on failure", () => {
    const dir = tempDir();
    const dbPath = buildFixtureDb(join(dir, "copy"), { version: 18 });
    const file = writeDescription(
      dir,
      "kind: variables\nvariables:\n  - {name: x, default: 1}\n",
    );
    const result = cli(["apply", file, "--db", dbPath], dir);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trimEnd().split("\n").length, 1, result.stderr);
    assert.match(result.stderr, /page_config_version is 18/);
  });

  it("exits 1 with one stderr line when Companion is not reachable", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) =>
      probe.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const key = "process-test-key-42d1";
    const dir = tempDir();
    const result = spawnSync(process.execPath, [BIN, "press", "1", "-1", "0"], {
      encoding: "utf8",
      cwd: dir,
      env: {
        ...homeEnv(dir),
        COMPANION_URL: `http://127.0.0.1:${port}`,
        COMPANION_API_KEY: key,
      },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trimEnd().split("\n").length, 1, result.stderr);
    assert.match(
      result.stderr,
      new RegExp(
        `^error: Companion is not reachable at http://127\\.0\\.0\\.1:${port}`,
      ),
    );
    assert.ok(!result.stderr.includes(key));
  });
});
