/**
 * The database target resolver: where the install's database is on each
 * platform. Windows paths use Windows path rules on every host, so the
 * Windows cases assert exact strings everywhere.
 */
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { CliError } from "../src/core/errors.ts";
import {
  databaseInRoot,
  defaultConfigRoot,
  defaultDatabasePath,
  expandHome,
  isDefaultInstallDatabase,
  resolveDatabaseTarget,
} from "../src/core/paths.ts";

const WIN_HOME = "C:\\Users\\someone";

describe("install discovery: the default configuration root", () => {
  it("is APPDATA\\companion on Windows", () => {
    assert.equal(
      defaultConfigRoot({
        homedir: WIN_HOME,
        platform: "win32",
        env: { APPDATA: "D:\\Profiles\\someone\\Roaming" },
      }),
      "D:\\Profiles\\someone\\Roaming\\companion",
    );
  });

  for (const [label, env] of [
    ["unset", {}],
    ["empty", { APPDATA: "" }],
  ] as const) {
    it(`falls back to <home>\\AppData\\Roaming on Windows when APPDATA is ${label}`, () => {
      assert.equal(
        defaultConfigRoot({ homedir: WIN_HOME, platform: "win32", env }),
        "C:\\Users\\someone\\AppData\\Roaming\\companion",
      );
    });
  }

  it("is ~/Library/Application Support/companion on macOS, whatever APPDATA says", () => {
    assert.equal(
      defaultConfigRoot({
        homedir: "/Users/someone",
        platform: "darwin",
        env: { APPDATA: "/elsewhere" },
      }),
      join("/Users/someone", "Library", "Application Support", "companion"),
    );
  });

  it("is refused on Linux, naming the supported platforms", () => {
    assert.throws(
      () =>
        defaultConfigRoot({ homedir: "/home/x", platform: "linux", env: {} }),
      (error: unknown) =>
        error instanceof CliError &&
        error.code === "unsupported_platform" &&
        error.message ===
          'unsupported platform "linux": the local install is found on macOS and Windows only; pass --db with a database path',
    );
  });
});

describe("install discovery: the database inside a root", () => {
  it("is <root>\\v5.1\\db.sqlite on Windows", () => {
    assert.equal(
      databaseInRoot("D:\\Repos\\cfg", "win32"),
      "D:\\Repos\\cfg\\v5.1\\db.sqlite",
    );
    // A trailing separator, as the launcher passes it, changes nothing.
    assert.equal(
      databaseInRoot("C:\\Users\\x\\AppData\\Roaming\\companion\\", "win32"),
      "C:\\Users\\x\\AppData\\Roaming\\companion\\v5.1\\db.sqlite",
    );
  });

  it("is <root>/v5.1/db.sqlite on macOS", () => {
    assert.equal(
      databaseInRoot(join("/tmp", "cfg"), "darwin"),
      join("/tmp", "cfg", "v5.1", "db.sqlite"),
    );
  });

  it("composes the default database path on both platforms", () => {
    assert.equal(
      defaultDatabasePath({
        homedir: WIN_HOME,
        platform: "win32",
        env: { APPDATA: "C:\\Users\\someone\\AppData\\Roaming" },
      }),
      "C:\\Users\\someone\\AppData\\Roaming\\companion\\v5.1\\db.sqlite",
    );
    assert.equal(
      defaultDatabasePath({
        homedir: "/Users/someone",
        platform: "darwin",
        env: {},
      }),
      join(
        "/Users/someone",
        "Library",
        "Application Support",
        "companion",
        "v5.1",
        "db.sqlite",
      ),
    );
  });
});

describe("install discovery: the database target", () => {
  it("targets the Windows install's database without --db", () => {
    assert.deepEqual(
      resolveDatabaseTarget(undefined, {
        homedir: WIN_HOME,
        platform: "win32",
        env: {},
      }),
      {
        dbPath:
          "C:\\Users\\someone\\AppData\\Roaming\\companion\\v5.1\\db.sqlite",
        live: true,
      },
    );
  });

  it("keeps the macOS target unchanged", () => {
    assert.deepEqual(
      resolveDatabaseTarget(undefined, {
        homedir: "/Users/someone",
        platform: "darwin",
        env: {},
      }),
      {
        dbPath: join(
          "/Users/someone",
          "Library",
          "Application Support",
          "companion",
          "v5.1",
          "db.sqlite",
        ),
        live: true,
      },
    );
  });

  it("refuses Linux without --db and takes --db there", () => {
    const install = { homedir: "/home/x", platform: "linux", env: {} } as const;
    assert.throws(
      () => resolveDatabaseTarget(undefined, install),
      /the local install is found on macOS and Windows only/,
    );
    assert.deepEqual(resolveDatabaseTarget("~/copy.sqlite", install), {
      dbPath: resolve(join("/home/x", "copy.sqlite")),
      live: false,
    });
  });
});

describe("install discovery: ~ expansion", () => {
  it("expands ~\\ and ~/ on Windows", () => {
    assert.equal(
      expandHome("~\\copy\\db.sqlite", WIN_HOME, "win32"),
      "C:\\Users\\someone\\copy\\db.sqlite",
    );
    assert.equal(
      expandHome("~/copy/db.sqlite", WIN_HOME, "win32"),
      "C:\\Users\\someone\\copy\\db.sqlite",
    );
    assert.equal(expandHome("~", WIN_HOME, "win32"), WIN_HOME);
  });

  it("leaves ~\\ as it is elsewhere", () => {
    assert.equal(expandHome("~\\copy", "/Users/someone", "darwin"), "~\\copy");
    assert.equal(
      expandHome("~/copy", "/Users/someone", "darwin"),
      join("/Users/someone", "copy"),
    );
  });
});

describe("install discovery: is this the install's database", () => {
  const install = {
    homedir: WIN_HOME,
    platform: "win32",
    env: { APPDATA: "C:\\Users\\someone\\AppData\\Roaming" },
  } as const;

  it("matches the Windows default path case-insensitively", () => {
    assert.ok(
      isDefaultInstallDatabase(
        "c:\\users\\SOMEONE\\appdata\\roaming\\Companion\\V5.1\\DB.sqlite",
        install,
      ),
    );
  });

  it("does not match another Windows database", () => {
    assert.ok(
      !isDefaultInstallDatabase("C:\\Users\\someone\\copy\\db.sqlite", install),
    );
  });

  it("stays case-sensitive by path on macOS", () => {
    const mac = {
      homedir: "/nowhere-home",
      platform: "darwin",
      env: {},
    } as const;
    const path = defaultDatabasePath(mac);
    assert.ok(isDefaultInstallDatabase(path, mac));
    assert.ok(!isDefaultInstallDatabase(path.toUpperCase(), mac));
  });
});
