import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type CommandRunner,
  type CompanionServer,
  holderPidsFromLsof,
  isServerCommand,
  macosProcessControl,
  serverPidsFromPs,
  serversFromPs,
  type ProcessControl,
} from "../src/core/process.ts";
import type { Env } from "../src/rest/endpoint.ts";

/**
 * `ps -axww -o pid=,command=` from a Mac running Companion 5.1 (user name and
 * machine id replaced, long helper lines shortened). 35428 is the launcher,
 * 35454 the server; 35825-35831 are connection modules and 35830/35833 surface
 * threads, all children of the server.
 */
const PS_RUNNING = [
  "35428 /Applications/Companion.app/Contents/MacOS/Companion",
  "35450 /Applications/Companion.app/Contents/Frameworks/Companion Helper.app/Contents/MacOS/Companion Helper --type=gpu-process --user-data-dir=/Users/someone/Library/Application Support/@companion-app/launcher",
  "35454 /Applications/Companion.app/Contents/Resources/node-runtimes/node26/bin/node --use-system-ca /Applications/Companion.app/Contents/Resources/main.js --machine-id=xxxx --config-dir=/Users/someone/Library/Application Support/companion/ --admin-port=8000 --admin-address=::",
  "35825 /Applications/Companion.app/Contents/Resources/node-runtimes/node18/bin/node /Users/someone/Library/Application Support/companion/modules/canon-ptz-2.5.0/main.js",
  "35827 /Applications/Companion.app/Contents/Resources/node-runtimes/node22/bin/node --use-system-ca --no-warnings=SecurityWarning --permission --allow-fs-read=/Users/someone/Library/Application Support/companion/modules/studiocoast-vmix-4.1.2 --allow-fs-read=/Applications/Companion.app/Contents/Resources /Users/someone/Library/Application Support/companion/modules/studiocoast-vmix-4.1.2/main.js",
  "35830 /Applications/Companion.app/Contents/Resources/node-runtimes/node26/bin/node --enable-source-maps /Applications/Companion.app/Contents/Resources/SurfaceThread.js",
  "  401 /usr/sbin/cfprefsd agent",
].join("\n");

const PS_LAUNCHER_ONLY = [
  "35428 /Applications/Companion.app/Contents/MacOS/Companion",
  "35450 /Applications/Companion.app/Contents/Frameworks/Companion Helper.app/Contents/MacOS/Companion Helper --type=gpu-process",
].join("\n");

const PS_ARGS = ["-axww", "-o", "pid=,command="];

type Reply = { status: number; stdout: string; stderr?: string };

/**
 * A runner that records every command, answers `ps` from a queue and any
 * other command from `replies` (default: exit 0, no output).
 */
function fakeRunner(psOutputs: string[], replies: Record<string, Reply> = {}) {
  const commands: Array<[string, string[]]> = [];
  const envs: Array<Env | undefined> = [];
  const run: CommandRunner = async (file, args, options) => {
    commands.push([file, [...args]]);
    envs.push(options?.env);
    if (file === "ps") {
      const stdout = psOutputs.length > 1 ? psOutputs.shift() : psOutputs[0];
      return { status: 0, stdout: stdout ?? "", stderr: "" };
    }
    const reply = replies[file] ?? { status: 0, stdout: "" };
    return { stderr: "", ...reply };
  };
  return { run, commands, envs };
}

/** The server of `PS_RUNNING`, as `servers()` lists it. */
const SERVER = serversFromPs(PS_RUNNING)[0] as CompanionServer;

/** A launch with a custom configuration folder. */
const LAUNCH = {
  env: { PATH: "/usr/bin", COMPANION_CONFIG_BASEDIR: "/srv/companion" },
  launcherPath: null,
};

/** A clock that advances by `step` ms on every sleep. */
function fakeClock(step: number) {
  let time = 0;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += step;
    },
    sleeps,
  };
}

describe("macOS process matching", () => {
  it("matches the server process only", () => {
    assert.deepEqual(serverPidsFromPs(PS_RUNNING), [35454]);
  });

  it("does not match connection modules, surface threads, helpers or the launcher", () => {
    for (const line of PS_RUNNING.split("\n")) {
      const command = line.trim().replace(/^\d+ /, "");
      assert.equal(
        isServerCommand(command),
        line.trim().startsWith("35454 "),
        line,
      );
    }
  });

  it("treats a launcher without a server as not running", () => {
    assert.deepEqual(serverPidsFromPs(PS_LAUNCHER_ONLY), []);
    assert.deepEqual(serverPidsFromPs(""), []);
  });

  it("matches a server installed outside /Applications", () => {
    assert.deepEqual(
      serverPidsFromPs(
        "77 /Users/x/Apps/Companion.app/Contents/Resources/node-runtimes/node26/bin/node /Users/x/Apps/Companion.app/Contents/Resources/main.js --config-dir=/tmp/c/",
      ),
      [77],
    );
  });

  it("lists the server with its whole command line and its bundle", () => {
    assert.deepEqual(serversFromPs(PS_RUNNING), [
      {
        pid: 35454,
        commandLine:
          "/Applications/Companion.app/Contents/Resources/node-runtimes/node26/bin/node --use-system-ca /Applications/Companion.app/Contents/Resources/main.js --machine-id=xxxx --config-dir=/Users/someone/Library/Application Support/companion/ --admin-port=8000 --admin-address=::",
        install: "/Applications/Companion.app",
        sessionId: null,
        launcher: null,
      },
    ]);
    // A bundle path with a space; another bundle's runtime gives no install.
    const [spaced, other] = serversFromPs(
      [
        "77 /Users/x/My Apps/Companion.app/Contents/Resources/node-runtimes/node26/bin/node /Users/x/My Apps/Companion.app/Contents/Resources/main.js --config-dir=/tmp/c/",
        "78 /usr/local/bin/node /Users/x/Companion.app/Contents/Resources/main.js",
      ].join("\n"),
    );
    assert.equal(spaced?.install, "/Users/x/My Apps/Companion.app");
    assert.equal(other?.pid, 78);
    assert.equal(other?.install, null);
  });
});

describe("macOS process control commands (not run)", () => {
  it("lists processes with ps", async () => {
    const fake = fakeRunner([PS_RUNNING]);
    const control = macosProcessControl({ run: fake.run });
    assert.deepEqual(await control.serverPids(), [35454]);
    assert.deepEqual(fake.commands, [["ps", PS_ARGS]]);
  });

  it("quits with osascript and starts with open -a Companion, handing it the launch environment", async () => {
    const fake = fakeRunner([PS_RUNNING]);
    const control = macosProcessControl({ run: fake.run });
    await control.quit([SERVER]);
    await control.start(LAUNCH);
    assert.deepEqual(fake.commands, [
      ["osascript", ["-e", 'quit app "Companion"']],
      ["open", ["-a", "Companion"]],
    ]);
    assert.deepEqual(fake.envs, [undefined, LAUNCH.env]);
  });

  it("has no Windows session", async () => {
    const fake = fakeRunner([PS_RUNNING]);
    assert.equal(
      await macosProcessControl({ run: fake.run }).ownSessionId(),
      null,
    );
    assert.deepEqual(fake.commands, []);
  });

  it("waits for a server to be listed after the start", async () => {
    const fake = fakeRunner([PS_LAUNCHER_ONLY, PS_LAUNCHER_ONLY, PS_RUNNING]);
    const clock = fakeClock(100);
    const control = macosProcessControl({ run: fake.run, ...clock });
    assert.deepEqual(
      (await control.waitForStart(30_000)).map((server) => server.pid),
      [35454],
    );
    assert.equal(fake.commands.length, 3);
    assert.equal(clock.sleeps.length, 2);
  });

  it("gives an empty list when no server is listed in time after the start", async () => {
    const fake = fakeRunner([PS_LAUNCHER_ONLY]);
    const clock = fakeClock(1_000);
    const control = macosProcessControl({ run: fake.run, ...clock });
    assert.deepEqual(await control.waitForStart(5_000), []);
    assert.ok(clock.sleeps.length >= 5 && clock.sleeps.length <= 6);
  });

  it("waits until the server PIDs seen before the quit are gone", async () => {
    const fake = fakeRunner([PS_RUNNING, PS_RUNNING, PS_LAUNCHER_ONLY]);
    const clock = fakeClock(100);
    const control = macosProcessControl({ run: fake.run, ...clock });
    assert.equal(await control.waitForExit([SERVER], 30_000), true);
    assert.deepEqual(fake.commands, [
      ["ps", PS_ARGS],
      ["ps", PS_ARGS],
      ["ps", PS_ARGS],
    ]);
    assert.equal(clock.sleeps.length, 2);
  });

  it("ignores a new server started under another PID while waiting", async () => {
    const fake = fakeRunner([PS_RUNNING.replace("35454 ", "50000 ")]);
    const control = macosProcessControl({ run: fake.run, ...fakeClock(100) });
    assert.equal(await control.waitForExit([SERVER], 30_000), true);
  });

  it("treats a reused PID running something else as exited", async () => {
    const fake = fakeRunner(["35454 /bin/zsh"]);
    const control = macosProcessControl({ run: fake.run, ...fakeClock(100) });
    assert.equal(await control.waitForExit([SERVER], 30_000), true);
  });

  it("returns false once the timeout passes", async () => {
    const fake = fakeRunner([PS_RUNNING]);
    const clock = fakeClock(1_000);
    const control = macosProcessControl({ run: fake.run, ...clock });
    assert.equal(await control.waitForExit([SERVER], 5_000), false);
    assert.ok(clock.sleeps.length >= 5 && clock.sleeps.length <= 6);
  });

  it("fails when ps, osascript or open exit non-zero", async () => {
    for (const [file, call] of [
      ["ps", (c: ProcessControl) => c.serverPids()],
      ["osascript", (c: ProcessControl) => c.quit([SERVER])],
      ["open", (c: ProcessControl) => c.start(LAUNCH)],
    ] as const) {
      const fake = fakeRunner([], {
        [file]: { status: 1, stdout: "", stderr: `${file} broke` },
      });
      const run: CommandRunner =
        file === "ps"
          ? async () => ({ status: 1, stdout: "", stderr: "ps broke" })
          : fake.run;
      await assert.rejects(
        call(macosProcessControl({ run })),
        new RegExp(`${file} broke`),
      );
    }
  });

  it("refuses to run real commands inside the test runner", async () => {
    // The default runner would run ps (read-only); it must refuse instead.
    const control = macosProcessControl();
    await assert.rejects(control.serverPids(), /test runner/);
  });
});

describe("macOS database holders (lsof, not run)", () => {
  const DB =
    "/Users/someone/Library/Application Support/companion/v5.1/db.sqlite";

  it("asks lsof for the PIDs holding the database and its WAL files", async () => {
    const fake = fakeRunner([], {
      lsof: { status: 0, stdout: "35454\n35454\n" },
    });
    const control = macosProcessControl({ run: fake.run });
    assert.deepEqual(await control.databaseHolders(DB), [35454]);
    assert.deepEqual(fake.commands, [
      ["lsof", ["-t", "--", DB, `${DB}-wal`, `${DB}-shm`]],
    ]);
  });

  it("treats exit 1 with no output as no holders", async () => {
    const fake = fakeRunner([], {
      lsof: {
        status: 1,
        stdout: "",
        stderr: `lsof: status error on ${DB}-wal: No such file or directory`,
      },
    });
    const control = macosProcessControl({ run: fake.run });
    assert.deepEqual(await control.databaseHolders(DB), []);
  });

  it("reports holders even when lsof exits 1 for a missing WAL file", async () => {
    const fake = fakeRunner([], {
      lsof: { status: 1, stdout: "812\n", stderr: "status error on -wal" },
    });
    const control = macosProcessControl({ run: fake.run });
    assert.deepEqual(await control.databaseHolders(DB), [812]);
  });

  it("fails on any other exit status", async () => {
    const fake = fakeRunner([], {
      lsof: { status: 2, stdout: "", stderr: "lsof: bad things" },
    });
    const control = macosProcessControl({ run: fake.run });
    await assert.rejects(control.databaseHolders(DB), /lsof.*bad things/);
  });

  it("fails on output that is not a PID list", () => {
    assert.deepEqual(holderPidsFromLsof("1\n22\n"), [1, 22]);
    assert.throws(
      () => holderPidsFromLsof("COMMAND PID\n"),
      /unexpected lsof output/,
    );
  });
});
