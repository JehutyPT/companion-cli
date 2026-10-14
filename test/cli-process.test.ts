import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildFixtureDb } from "./fixtures/companion-db.ts";
import { customVariables, tempDir, writeDescription } from "./helpers.ts";

const BIN = fileURLToPath(
  new URL("../src/bin/companion-cli.ts", import.meta.url),
);

/** The parent environment without any `COMPANION_*` variable. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("COMPANION_")) env[name] = value;
  }
  return env;
}

/** Runs the executable in `home`, so it never sees the repository's `.env.local`. */
function cli(args: string[], home: string) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    cwd: home,
    env: { ...cleanEnv(), HOME: home },
  });
}

describe("companion-cli executable", () => {
  it("exits 0 on success and prints the backup path", () => {
    const dir = tempDir();
    const dbPath = buildFixtureDb(join(dir, "copy"));
    const file = writeDescription(
      dir,
      "kind: variables\nvariables:\n  - {name: from_bin, default: 1}\n",
    );
    const result = cli(["apply", file, "--db", dbPath], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^backup: .*companion-cli-backups/m);
    assert.equal(
      (customVariables(dbPath)["from_bin"] as { defaultValue: number })
        .defaultValue,
      1,
    );
  });

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

  it("exits 2 without --db", () => {
    const result = cli(["apply", "x.yaml"], tempDir());
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--db is required/);
  });

  it("exits 1 with one stderr line when Companion is not reachable", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) =>
      probe.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const key = "process-test-key-42d1";
    const env = cleanEnv();
    const dir = tempDir();
    const result = spawnSync(process.execPath, [BIN, "press", "1", "-1", "0"], {
      encoding: "utf8",
      cwd: dir,
      env: {
        ...env,
        HOME: dir,
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
