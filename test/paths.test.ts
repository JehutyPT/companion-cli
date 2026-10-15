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
  configDirOf,
  databaseInRoot,
  defaultConfigRoot,
  defaultDatabasePath,
  describeDatabase,
  expandHome,
  isInstallDatabase,
  normaliseRoot,
  resolveConfigRoot,
  resolveDatabaseTarget,
  sameRoot,
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
    const root = "C:\\Users\\someone\\AppData\\Roaming\\companion";
    assert.deepEqual(
      resolveDatabaseTarget(undefined, {
        homedir: WIN_HOME,
        platform: "win32",
        env: {},
        servers: [],
      }),
      {
        dbPath: `${root}\\v5.1\\db.sqlite`,
        live: true,
        root: { root, source: "default" },
      },
    );
  });

  it("keeps the macOS target unchanged", () => {
    const root = join(
      "/Users/someone",
      "Library",
      "Application Support",
      "companion",
    );
    assert.deepEqual(
      resolveDatabaseTarget(undefined, {
        homedir: "/Users/someone",
        platform: "darwin",
        env: {},
        servers: [],
      }),
      {
        dbPath: join(root, "v5.1", "db.sqlite"),
        live: true,
        root: { root, source: "default" },
      },
    );
  });

  it("takes --db as given, without listing the servers", () => {
    assert.deepEqual(
      resolveDatabaseTarget("/elsewhere/copy.sqlite", {
        homedir: "/Users/someone",
        platform: "darwin",
        env: { COMPANION_CONFIG_BASEDIR: "/cfg" },
      }),
      { dbPath: resolve("/elsewhere/copy.sqlite"), live: false, root: null },
    );
  });

  it("refuses Linux without --db and takes --db there", () => {
    const install = {
      homedir: "/home/x",
      platform: "linux",
      env: {},
      servers: [],
    } as const;
    assert.throws(
      () => resolveDatabaseTarget(undefined, install),
      /the local install is found on macOS and Windows only/,
    );
    assert.deepEqual(resolveDatabaseTarget("~/copy.sqlite", install), {
      dbPath: resolve(join("/home/x", "copy.sqlite")),
      live: false,
      root: null,
    });
  });

  it("names the rule that chose the database in messages", () => {
    const target = resolveDatabaseTarget(undefined, {
      homedir: WIN_HOME,
      platform: "win32",
      env: { COMPANION_CONFIG_BASEDIR: "D:\\Repos\\cfg\\" },
      servers: [],
    });
    assert.equal(
      describeDatabase(target),
      "D:\\Repos\\cfg\\v5.1\\db.sqlite (from COMPANION_CONFIG_BASEDIR)",
    );
    assert.equal(
      describeDatabase({ dbPath: "/copy.sqlite", root: null }),
      "/copy.sqlite",
    );
  });
});

/** The macOS server's command line, as `ps` prints it (never quoted). */
const macServer = (configDir: string, pid = 35454) => ({
  pid,
  commandLine: `/Applications/Companion.app/Contents/Resources/node-runtimes/node26/bin/node --use-system-ca /Applications/Companion.app/Contents/Resources/main.js --machine-id=xxxx --config-dir=${configDir} --admin-port=8000 --admin-address=::`,
});

/** The Windows server's command line, as the #36 spike listed it. */
const windowsServer = (configDirArgument: string, pid = 4242) => ({
  pid,
  commandLine: `"D:\\Data\\Bitfocus Companion\\resources\\node-runtimes\\node26\\node.exe" --use-system-ca "D:\\Data\\Bitfocus Companion\\resources\\main.js" --machine-id=xxxx ${configDirArgument} --admin-port=8000 --admin-address=127.0.0.1 --log-level=info`,
});

describe("install discovery: a server's --config-dir", () => {
  it("reads the macOS default, spaces included, without the trailing /", () => {
    assert.equal(
      configDirOf(
        macServer("/Users/someone/Library/Application Support/companion/")
          .commandLine,
        "darwin",
      ),
      "/Users/someone/Library/Application Support/companion",
    );
  });

  it("reads a macOS custom folder with spaces", () => {
    assert.equal(
      configDirOf(
        macServer("/Users/someone/My Repos/stream configs").commandLine,
        "darwin",
      ),
      "/Users/someone/My Repos/stream configs",
    );
  });

  it("reads the Windows lines the #36 spike observed", () => {
    assert.equal(
      configDirOf(
        windowsServer(
          "--config-dir=C:\\Users\\someone\\AppData\\Roaming\\companion\\",
        ).commandLine,
        "win32",
      ),
      "C:\\Users\\someone\\AppData\\Roaming\\companion",
    );
    assert.equal(
      configDirOf(
        windowsServer(
          "--config-dir=C:\\Users\\someone\\companion-cli-spike\\cfg",
        ).commandLine,
        "win32",
      ),
      "C:\\Users\\someone\\companion-cli-spike\\cfg",
    );
  });

  it("reads a Windows argument quoted whole, with the doubled trailing backslash", () => {
    assert.equal(
      configDirOf(
        windowsServer('"--config-dir=D:\\My Repos\\cfg\\\\"').commandLine,
        "win32",
      ),
      "D:\\My Repos\\cfg",
    );
  });

  it("reads a Windows value quoted alone", () => {
    assert.equal(
      configDirOf(
        windowsServer('--config-dir="D:\\My Repos\\cfg"').commandLine,
        "win32",
      ),
      "D:\\My Repos\\cfg",
    );
  });

  it("reads an unquoted Windows value with spaces up to the next argument", () => {
    assert.equal(
      configDirOf(
        windowsServer("--config-dir=D:\\My Repos\\cfg\\").commandLine,
        "win32",
      ),
      "D:\\My Repos\\cfg",
    );
  });

  it("is null when the command line has none", () => {
    assert.equal(
      configDirOf(
        "/Applications/Companion.app/Contents/Resources/main.js --admin-port=8000",
        "darwin",
      ),
      null,
    );
    assert.equal(configDirOf("node main.js --config-dir= --x", "darwin"), null);
  });

  it("keeps a bare root when dropping the trailing separator", () => {
    assert.equal(normaliseRoot("C:\\", "win32"), "C:\\");
    assert.equal(normaliseRoot("D:/", "win32"), "D:\\");
    assert.equal(normaliseRoot("/", "darwin"), "/");
    assert.equal(normaliseRoot("/cfg//", "darwin"), "/cfg");
  });

  it("compares Windows roots without case and with / as \\", () => {
    assert.ok(sameRoot("C:\\Repos\\CFG\\", "c:/repos/cfg", "win32"));
    assert.ok(!sameRoot("/Repos/CFG", "/repos/cfg", "darwin"));
  });
});

describe("install discovery: the configuration root", () => {
  const mac = {
    homedir: "/Users/someone",
    platform: "darwin",
  } as const;
  const MAC_DEFAULT = join(
    "/Users/someone",
    "Library",
    "Application Support",
    "companion",
  );

  it("is the default when no server runs and the variable is unset or empty", () => {
    for (const env of [{}, { COMPANION_CONFIG_BASEDIR: "" }]) {
      assert.deepEqual(resolveConfigRoot({ ...mac, env, servers: [] }), {
        root: MAC_DEFAULT,
        source: "default",
      });
    }
  });

  it("is COMPANION_CONFIG_BASEDIR as given when no server runs", () => {
    assert.deepEqual(
      resolveConfigRoot({
        ...mac,
        env: { COMPANION_CONFIG_BASEDIR: "/Users/someone/repo cfg/" },
        servers: [],
      }),
      { root: "/Users/someone/repo cfg", source: "environment" },
    );
    assert.deepEqual(
      resolveConfigRoot({
        homedir: WIN_HOME,
        platform: "win32",
        env: { COMPANION_CONFIG_BASEDIR: "D:\\Repos\\cfg" },
        servers: [],
      }),
      { root: "D:\\Repos\\cfg", source: "environment" },
    );
  });

  it("is the running server's --config-dir, before the variable", () => {
    assert.deepEqual(
      resolveConfigRoot({
        ...mac,
        env: { COMPANION_CONFIG_BASEDIR: "/elsewhere" },
        servers: [macServer("/Users/someone/repo cfg/")],
      }),
      { root: "/Users/someone/repo cfg", source: "server" },
    );
    assert.deepEqual(
      resolveConfigRoot({
        homedir: WIN_HOME,
        platform: "win32",
        env: {},
        servers: [
          windowsServer(
            "--config-dir=C:\\Users\\someone\\companion-cli-spike\\cfg",
          ),
        ],
      }),
      {
        root: "C:\\Users\\someone\\companion-cli-spike\\cfg",
        source: "server",
      },
    );
  });

  it("is the server's root when it is the default folder", () => {
    assert.deepEqual(
      resolveConfigRoot({
        ...mac,
        env: {},
        servers: [macServer(`${MAC_DEFAULT}/`)],
      }),
      { root: MAC_DEFAULT, source: "server" },
    );
  });

  it("ignores a server without --config-dir", () => {
    assert.deepEqual(
      resolveConfigRoot({
        ...mac,
        env: { COMPANION_CONFIG_BASEDIR: "/cfg" },
        servers: [{ pid: 1, commandLine: "node main.js --admin-port=8000" }],
      }),
      { root: "/cfg", source: "environment" },
    );
  });

  it("takes servers on the same folder, spelt differently, as one", () => {
    assert.deepEqual(
      resolveConfigRoot({
        homedir: WIN_HOME,
        platform: "win32",
        env: {},
        servers: [
          windowsServer("--config-dir=D:\\Repos\\cfg\\", 1),
          windowsServer("--config-dir=d:/repos/CFG", 2),
        ],
      }).source,
      "server",
    );
  });

  it("refuses servers on different folders", () => {
    assert.throws(
      () =>
        resolveConfigRoot({
          ...mac,
          env: {},
          servers: [macServer("/one/", 1), macServer("/two", 2)],
        }),
      (error: unknown) =>
        error instanceof CliError &&
        error.code === "companion_running" &&
        error.message ===
          "Companion servers are running with different configuration folders (/one, /two); cannot tell which install's database to use" &&
        error.hint === "quit the other Companion servers, or pass --db <path>",
    );
  });

  it("on Windows, is the default when the variable is empty", () => {
    assert.deepEqual(
      resolveConfigRoot({
        homedir: WIN_HOME,
        platform: "win32",
        env: { COMPANION_CONFIG_BASEDIR: "" },
        servers: [],
      }),
      {
        root: "C:\\Users\\someone\\AppData\\Roaming\\companion",
        source: "default",
      },
    );
  });

  it("on Windows, refuses servers on different folders", () => {
    assert.throws(
      () =>
        resolveConfigRoot({
          homedir: WIN_HOME,
          platform: "win32",
          env: {},
          servers: [
            windowsServer(
              "--config-dir=C:\\Users\\someone\\AppData\\Roaming\\companion\\",
              1,
            ),
            windowsServer('"--config-dir=D:\\My Repos\\cfg\\\\"', 2),
          ],
        }),
      (error: unknown) =>
        error instanceof CliError &&
        error.code === "companion_running" &&
        error.message ===
          "Companion servers are running with different configuration folders (C:\\Users\\someone\\AppData\\Roaming\\companion, D:\\My Repos\\cfg); cannot tell which install's database to use",
    );
  });

  it("refuses to resolve without the server list", () => {
    assert.throws(
      () => resolveConfigRoot({ ...mac, env: {} }),
      /the running Companion servers were not listed/,
    );
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
    servers: [],
  } as const;

  it("matches the Windows default path case-insensitively", () => {
    assert.ok(
      isInstallDatabase(
        "c:\\users\\SOMEONE\\appdata\\roaming\\Companion\\V5.1\\DB.sqlite",
        install,
      ),
    );
  });

  it("does not match another Windows database", () => {
    assert.ok(
      !isInstallDatabase("C:\\Users\\someone\\copy\\db.sqlite", install),
    );
  });

  it("stays case-sensitive by path on macOS", () => {
    const mac = {
      homedir: "/nowhere-home",
      platform: "darwin",
      env: {},
      servers: [],
    } as const;
    const path = defaultDatabasePath(mac);
    assert.ok(isInstallDatabase(path, mac));
    assert.ok(!isInstallDatabase(path.toUpperCase(), mac));
  });

  it("is the database in COMPANION_CONFIG_BASEDIR when no server runs", () => {
    const env = { ...install.env, COMPANION_CONFIG_BASEDIR: "D:\\Repos\\cfg" };
    assert.ok(
      isInstallDatabase("D:\\Repos\\cfg\\v5.1\\db.sqlite", { ...install, env }),
    );
    assert.ok(
      !isInstallDatabase(
        "C:\\Users\\someone\\AppData\\Roaming\\companion\\v5.1\\db.sqlite",
        { ...install, env },
      ),
    );
  });

  it("is the database in a running server's --config-dir, not the default's", () => {
    const servers = [windowsServer("--config-dir=D:\\Repos\\cfg\\")];
    assert.ok(
      isInstallDatabase("d:\\repos\\CFG\\v5.1\\db.sqlite", {
        ...install,
        servers,
      }),
    );
    assert.ok(
      !isInstallDatabase(
        "C:\\Users\\someone\\AppData\\Roaming\\companion\\v5.1\\db.sqlite",
        { ...install, servers },
      ),
    );
  });

  it("adds the configured folder's database when a server names no root", () => {
    const servers = [
      windowsServer("--config-dir=D:\\Repos\\cfg"),
      { pid: 7, commandLine: "node main.js" },
    ];
    for (const path of [
      "D:\\Repos\\cfg\\v5.1\\db.sqlite",
      "C:\\Users\\someone\\AppData\\Roaming\\companion\\v5.1\\db.sqlite",
    ]) {
      assert.ok(isInstallDatabase(path, { ...install, servers }), path);
    }
  });
});
