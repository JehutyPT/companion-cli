import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  type CommandResult,
  type CommandRunner,
  type CompanionServer,
  companionServers,
  DatabaseInUseError,
  defaultProcessControl,
  EXCLUSIVE_OPEN_FLAG,
  type FileOpener,
  isProcessAlive,
  parseWin32Processes,
  sessionIdOf,
  WIN32_PROCESS_LISTING,
  type Win32Process,
  windowsProcessControl,
} from "../src/core/process.ts";

/**
 * `Get-CimInstance Win32_Process` as JSON, built from the processes the #36
 * spike captured on a Windows 11 box running Companion 5.1.0 per-machine at
 * `D:\Data\Bitfocus Companion` (user name and machine id replaced, Electron
 * helper switches trimmed). 3832 is the launcher (session 1), 3176 the
 * server, 1924 and 5240 surface threads, 10576/8128/7096/10152 Electron
 * helpers, 5556 and 5596 unrelated "Companion" services. 6100 is a connection
 * module: the spike captured none, so it is the macOS module shape with
 * Windows paths (to check in the acceptance run, #41). 7000 is a CLI in
 * session 0 (over SSH).
 */
const LISTING = readFileSync(
  new URL("./fixtures/win32-processes.json", import.meta.url),
  "utf8",
);

const INSTALL = "D:\\Data\\Bitfocus Companion";

/** One listed process, for variants of the fixture's server. */
function proc(
  pid: number,
  commandLine: string | null,
  executablePath: string | null,
): Win32Process {
  return { pid, parentPid: 1, sessionId: 1, executablePath, commandLine };
}

/** A Node file-system error with `code`, as `fs.promises.open` rejects with. */
function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: open failed`), { code });
}

type Outcome = "free" | NodeJS.ErrnoException;

/**
 * An opener that records each `[path, flags]` call and answers from a script
 * per path: each call takes the next outcome, and the last one repeats.
 */
function scriptedOpener(script: Record<string, Outcome[]>): {
  open: FileOpener;
  calls: Array<[string, number]>;
  closed: string[];
} {
  const calls: Array<[string, number]> = [];
  const closed: string[] = [];
  const seen = new Map<string, number>();
  const open: FileOpener = async (path, flags) => {
    calls.push([path, flags]);
    const outcomes = script[path] ?? [fsError("ENOENT")];
    const index = seen.get(path) ?? 0;
    seen.set(path, index + 1);
    const outcome = outcomes[Math.min(index, outcomes.length - 1)];
    if (outcome !== "free") throw outcome;
    return {
      close: async () => {
        closed.push(path);
      },
    };
  };
  return { open, calls, closed };
}

const DB = "C:\\data\\db.sqlite";

/** A sleep that records its delays instead of waiting. */
function recordingSleep(): {
  sleep: (ms: number) => Promise<void>;
  sleeps: number[];
} {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

describe("Windows process control", () => {
  it("probes with libuv's exclusive-open flag, a non-zero literal", () => {
    // fs.constants.UV_FS_O_EXLOCK is undefined in Node, so a probe built on it
    // would be a plain open that always reports free (spike #36, row 8).
    assert.equal(EXCLUSIVE_OPEN_FLAG, 0x10000000);
    assert.notEqual(EXCLUSIVE_OPEN_FLAG, 0);
  });

  it("opens each existing file exclusively, closes it and reports no holders", async () => {
    const opener = scriptedOpener({
      [DB]: ["free"],
      [`${DB}-wal`]: ["free"],
      // -shm missing: ENOENT counts as free.
    });
    const { sleep } = recordingSleep();
    const control = windowsProcessControl({ open: opener.open, sleep });
    assert.deepEqual(await control.databaseHolders(DB), []);
    assert.deepEqual(opener.calls, [
      [DB, EXCLUSIVE_OPEN_FLAG],
      [`${DB}-wal`, EXCLUSIVE_OPEN_FLAG],
      [`${DB}-shm`, EXCLUSIVE_OPEN_FLAG],
    ]);
    assert.deepEqual(opener.closed, [DB, `${DB}-wal`]);
  });

  it("throws the in-use error when a file stays locked through the retries", async () => {
    const { sleep, sleeps } = recordingSleep();
    const opener = scriptedOpener({
      [DB]: ["free"],
      [`${DB}-wal`]: [fsError("EBUSY")],
    });
    const control = windowsProcessControl({ open: opener.open, sleep });
    await assert.rejects(
      control.databaseHolders(DB),
      (error: unknown) =>
        error instanceof DatabaseInUseError && /-wal/.test(error.message),
    );
    const walOpens = opener.calls.filter(([path]) => path === `${DB}-wal`);
    assert.equal(walOpens.length, 5);
    assert.deepEqual(sleeps, [250, 250, 250, 250]);
  });

  it("reports free once a transient lock clears within the retries", async () => {
    const { sleep, sleeps } = recordingSleep();
    const opener = scriptedOpener({
      [DB]: [fsError("EBUSY"), fsError("EBUSY"), "free"],
    });
    const control = windowsProcessControl({ open: opener.open, sleep });
    assert.deepEqual(await control.databaseHolders(DB), []);
    assert.deepEqual(sleeps, [250, 250]);
  });

  it("rethrows any other probe error, so apply fails closed", async () => {
    const opener = scriptedOpener({ [DB]: [fsError("EACCES")] });
    const { sleep } = recordingSleep();
    const control = windowsProcessControl({ open: opener.open, sleep });
    await assert.rejects(
      control.databaseHolders(DB),
      (error: unknown) =>
        !(error instanceof DatabaseInUseError) && /EACCES/.test(String(error)),
    );
  });
});

describe("Windows quit, wait and start (not run)", () => {
  /** A runner answering the listing with the spike fixture, others with `reply`. */
  function recordingRunner(reply: CommandResult = ok) {
    const commands: Array<[string, string[]]> = [];
    const run: CommandRunner = async (file, args) => {
      commands.push([file, [...args]]);
      return file === "powershell.exe"
        ? { status: 0, stdout: LISTING, stderr: "" }
        : reply;
    };
    return { run, commands };
  }
  const ok: CommandResult = { status: 0, stdout: "", stderr: "" };

  const SERVER = companionServers(
    parseWin32Processes(LISTING),
  )[0] as CompanionServer;
  const LAUNCHER = "D:\\Data\\Bitfocus Companion\\Companion.exe";
  const ENV = { PATH: "C:\\Windows", COMPANION_CONFIG_BASEDIR: "D:\\cfg" };

  /** A clock whose sleeps advance it by `step` ms. */
  function clock(step: number) {
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

  it("the fixture's server has the launcher the quit and start use", () => {
    assert.deepEqual(SERVER.launcher, {
      pid: 3832,
      path: LAUNCHER,
      sessionId: 1,
    });
  });

  it("quits with taskkill /PID <launcher>, never /F", async () => {
    const fake = recordingRunner();
    await windowsProcessControl({ run: fake.run }).quit([SERVER]);
    assert.deepEqual(fake.commands, [["taskkill.exe", ["/PID", "3832"]]]);
  });

  it("asks each launcher once", async () => {
    const fake = recordingRunner();
    const second = { ...SERVER, pid: 9999 };
    const other = {
      ...SERVER,
      pid: 9998,
      launcher: { pid: 7777, path: LAUNCHER, sessionId: 1 },
    };
    await windowsProcessControl({ run: fake.run }).quit([
      SERVER,
      second,
      other,
    ]);
    assert.deepEqual(fake.commands, [
      ["taskkill.exe", ["/PID", "3832"]],
      ["taskkill.exe", ["/PID", "7777"]],
    ]);
    for (const [, args] of fake.commands) assert.ok(!args.includes("/F"));
  });

  it("fails when taskkill exits non-zero, or a server has no launcher", async () => {
    const refused = recordingRunner({
      status: 1,
      stdout: "",
      stderr:
        "ERROR: The process with PID 3832 could not be terminated. Reason: This process can only be terminated forcefully (with /F option).",
    });
    await assert.rejects(
      windowsProcessControl({ run: refused.run }).quit([SERVER]),
      /taskkill\.exe exited 1: .*forcefully/,
    );
    const fake = recordingRunner();
    await assert.rejects(
      windowsProcessControl({ run: fake.run }).quit([
        { ...SERVER, launcher: null },
      ]),
      /launcher of Companion's server \(PID 3176\) is not listed/,
    );
    assert.deepEqual(fake.commands, []);
  });

  it("waits for the server and the launcher by PID, without listing again", async () => {
    const fake = recordingRunner();
    const alive = new Map([
      [3176, 1],
      [3832, 3],
    ]);
    const checked: number[] = [];
    const isAlive = (pid: number) => {
      checked.push(pid);
      const left = alive.get(pid) ?? 0;
      alive.set(pid, left - 1);
      return left > 0;
    };
    const time = clock(100);
    const control = windowsProcessControl({ run: fake.run, isAlive, ...time });
    assert.equal(await control.waitForExit([SERVER], 30_000), true);
    assert.deepEqual(fake.commands, []);
    assert.ok(checked.includes(3176) && checked.includes(3832));
    // The launcher outlives the server: the wait goes on until it is gone.
    assert.deepEqual(time.sleeps, [250, 250, 250, 250]);
  });

  it("returns false once the timeout passes", async () => {
    const time = clock(1_000);
    const control = windowsProcessControl({
      run: recordingRunner().run,
      isAlive: (pid) => pid === 3832,
      ...time,
    });
    assert.equal(await control.waitForExit([SERVER], 5_000), false);
    assert.ok(time.sleeps.length >= 5 && time.sleeps.length <= 6);
  });

  it("probes liveness with signal 0: this process is alive, an unused PID is not", () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(2 ** 30), false);
  });

  it("starts the remembered launcher detached, with the launch environment", async () => {
    const started: Array<[string, unknown]> = [];
    const fake = recordingRunner();
    const control = windowsProcessControl({
      run: fake.run,
      spawn: async (file, env) => {
        started.push([file, env]);
      },
    });
    await control.start({ env: ENV, launcherPath: LAUNCHER });
    assert.deepEqual(started, [[LAUNCHER, ENV]]);
    assert.deepEqual(fake.commands, []);
  });

  it("fails to start without a launcher path, or when the spawn fails", async () => {
    const spawned: string[] = [];
    const control = windowsProcessControl({
      run: recordingRunner().run,
      spawn: async (file) => {
        spawned.push(file);
        throw new Error(`cannot start ${file}: ENOENT`);
      },
    });
    await assert.rejects(
      control.start({ env: ENV, launcherPath: null }),
      /launcher executable is not known/,
    );
    assert.deepEqual(spawned, []);
    await assert.rejects(
      control.start({ env: ENV, launcherPath: LAUNCHER }),
      /cannot start .*ENOENT/,
    );
  });

  it("refuses to start a real launcher inside the test runner", async () => {
    await assert.rejects(
      windowsProcessControl().start({ env: ENV, launcherPath: LAUNCHER }),
      /refusing to run .*Companion\.exe inside the test runner/,
    );
  });

  it("reads its own session from the latest listing", async () => {
    const fake = recordingRunner();
    // 7000 is a CLI over SSH (session 0) in the fixture.
    const overSsh = windowsProcessControl({ run: fake.run, pid: 7000 });
    await overSsh.servers();
    assert.equal(await overSsh.ownSessionId(), 0);
    assert.equal(fake.commands.length, 1, "no second listing");
    // Without a listing yet it lists; an unlisted PID has no session.
    const fresh = windowsProcessControl({ run: fake.run, pid: 3832 });
    assert.equal(await fresh.ownSessionId(), 1);
    assert.equal(fake.commands.length, 2);
    const unlisted = windowsProcessControl({ run: fake.run, pid: 123456 });
    assert.equal(await unlisted.ownSessionId(), null);
  });

  it("waits for a server to be listed after the start", async () => {
    let listings = 0;
    const run: CommandRunner = async () => ({
      status: 0,
      stdout: listings++ < 2 ? "[]" : LISTING,
      stderr: "",
    });
    const time = clock(100);
    const control = windowsProcessControl({ run, ...time });
    assert.deepEqual(
      (await control.waitForStart(30_000)).map((server) => server.pid),
      [3176],
    );
    assert.equal(listings, 3);
    const none = windowsProcessControl({
      run: async () => ({ status: 0, stdout: "[]", stderr: "" }),
      ...clock(1_000),
    });
    assert.deepEqual(await none.waitForStart(5_000), []);
  });
});

describe("default process control", () => {
  // The command runner refuses inside the test runner, so each quit names
  // the command it would have run.
  const server = companionServers(
    parseWin32Processes(LISTING),
  )[0] as CompanionServer;

  it("is the macOS control on macOS", async () => {
    await assert.rejects(
      defaultProcessControl("darwin").quit([server]),
      /refusing to run osascript/,
    );
  });

  it("is the Windows control on Windows", async () => {
    await assert.rejects(
      defaultProcessControl("win32").quit([server]),
      /refusing to run taskkill\.exe/,
    );
  });

  it("stays the macOS control elsewhere, which apply never calls there", async () => {
    await assert.rejects(
      defaultProcessControl("linux").quit([server]),
      /refusing to run osascript/,
    );
  });
});

describe("Windows process matching (spike fixture)", () => {
  const processes = parseWin32Processes(LISTING);

  it("parses every listed process", () => {
    assert.equal(processes.length, 14);
    assert.deepEqual(
      processes.find((p) => p.pid === 0),
      {
        pid: 0,
        parentPid: 0,
        sessionId: 0,
        executablePath: null,
        commandLine: null,
      },
    );
  });

  it("matches the server only, with its install, launcher and sessions", () => {
    assert.deepEqual(companionServers(processes), [
      {
        pid: 3176,
        commandLine:
          '"D:\\Data\\Bitfocus Companion\\resources\\node-runtimes\\node26\\node.exe" --use-system-ca "D:\\Data\\Bitfocus Companion\\resources\\main.js" --machine-id=xxxx --config-dir=C:\\Users\\someone\\companion-cli-spike\\cfg --admin-port=8000 --admin-address=127.0.0.1 --log-level=info',
        install: INSTALL,
        sessionId: 1,
        launcher: {
          pid: 3832,
          path: "D:\\Data\\Bitfocus Companion\\Companion.exe",
          sessionId: 1,
        },
      },
    ]);
  });

  it("does not match surface threads, modules, helpers, the launcher or other Companions", () => {
    for (const listed of processes) {
      assert.deepEqual(
        companionServers([listed]).map((server) => server.pid),
        listed.pid === 3176 ? [3176] : [],
        String(listed.pid),
      );
    }
  });

  it("reads the CLI's own session from the same listing", () => {
    assert.equal(sessionIdOf(processes, 7000), 0);
    assert.equal(sessionIdOf(processes, 3832), 1);
    assert.equal(sessionIdOf(processes, 99999), null);
  });

  it("reports no launcher when the server's parent is not listed", () => {
    const server = processes.find((p) => p.pid === 3176) as Win32Process;
    assert.equal(companionServers([server])[0]?.launcher, null);
  });

  it("ignores case and accepts / separators", () => {
    const server = proc(
      9,
      '"d:\\data\\bitfocus companion\\RESOURCES\\Node-Runtimes\\node26\\NODE.EXE" "D:/Data/Bitfocus Companion/Resources/Main.js" --config-dir=x',
      "d:\\data\\bitfocus companion\\RESOURCES\\Node-Runtimes\\node26\\NODE.EXE",
    );
    assert.deepEqual(
      companionServers([server]).map((found) => [found.pid, found.install]),
      [[9, "D:/Data/Bitfocus Companion"]],
    );
  });

  it("matches an unquoted main.js, using the command line's executable when the path is unreadable", () => {
    const server = proc(
      10,
      "C:\\Companion\\resources\\node-runtimes\\node26\\node.exe --use-system-ca C:\\Companion\\resources\\main.js --config-dir=C:\\Users\\some one\\AppData\\Roaming\\companion\\ --admin-port=8000 ",
      null,
    );
    const [found] = companionServers([server]);
    assert.equal(found?.install, "C:\\Companion");
    // Kept whole for #43 (spaces and the trailing separator), only trimmed.
    assert.equal(
      found?.commandLine,
      "C:\\Companion\\resources\\node-runtimes\\node26\\node.exe --use-system-ca C:\\Companion\\resources\\main.js --config-dir=C:\\Users\\some one\\AppData\\Roaming\\companion\\ --admin-port=8000",
    );
  });

  it("needs the node runtime of the same install, and main.js as an argument", () => {
    const cases: Array<[string, string]> = [
      // One install's main.js run by another install's runtime.
      [
        '"C:\\A\\resources\\node-runtimes\\node26\\node.exe" "C:\\B\\resources\\main.js"',
        "C:\\A\\resources\\node-runtimes\\node26\\node.exe",
      ],
      // A system node running an install's main.js.
      [
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\B\\resources\\main.js"',
        "C:\\Program Files\\nodejs\\node.exe",
      ],
      // main.js only inside an option value.
      [
        '"C:\\B\\resources\\node-runtimes\\node22\\node.exe" --allow-fs-read=C:\\B\\resources\\main.js C:\\cfg\\modules\\x\\main.js',
        "C:\\B\\resources\\node-runtimes\\node22\\node.exe",
      ],
      // Another file beside main.js.
      [
        '"C:\\B\\resources\\node-runtimes\\node26\\node.exe" "C:\\B\\resources\\main.json"',
        "C:\\B\\resources\\node-runtimes\\node26\\node.exe",
      ],
      // Another executable in the install's runtime folder.
      [
        '"C:\\B\\resources\\node-runtimes\\node26\\npx.exe" "C:\\B\\resources\\main.js"',
        "C:\\B\\resources\\node-runtimes\\node26\\npx.exe",
      ],
    ];
    for (const [commandLine, executablePath] of cases) {
      assert.deepEqual(
        companionServers([proc(11, commandLine, executablePath)]),
        [],
        commandLine,
      );
    }
  });

  it("accepts a single process emitted as a bare object", () => {
    const listed = JSON.parse(LISTING) as unknown[];
    assert.deepEqual(
      parseWin32Processes(JSON.stringify(listed[8])).map((p) => p.pid),
      [3176],
    );
  });

  it("rejects output that is not a process listing", () => {
    for (const stdout of [
      "",
      "not json",
      "42",
      '[{"ProcessId":"x","ParentProcessId":1}]',
      '[{"ProcessId":1}]',
      '[{"ProcessId":1,"ParentProcessId":1,"CommandLine":7}]',
    ]) {
      assert.throws(
        () => parseWin32Processes(stdout),
        /process listing/,
        stdout,
      );
    }
  });
});

describe("Windows process listing (PowerShell, not run)", () => {
  function runner(result: { status: number; stdout: string; stderr?: string }) {
    const commands: Array<[string, string[]]> = [];
    const run: CommandRunner = async (file, args) => {
      commands.push([file, [...args]]);
      return { stderr: "", ...result };
    };
    return { run, commands };
  }

  it("lists processes with Get-CimInstance through the command runner", async () => {
    const fake = runner({ status: 0, stdout: LISTING });
    const control = windowsProcessControl({ run: fake.run });
    assert.deepEqual(await control.serverPids(), [3176]);
    assert.deepEqual(
      (await control.servers()).map((server) => server.install),
      [INSTALL],
    );
    assert.deepEqual(fake.commands[0], [
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WIN32_PROCESS_LISTING],
    ]);
    assert.match(
      WIN32_PROCESS_LISTING,
      /Get-CimInstance -ClassName Win32_Process/,
    );
    assert.match(
      WIN32_PROCESS_LISTING,
      /OutputEncoding = \[Text\.Encoding\]::UTF8/,
    );
    // No double quotes: they would need escaping on the command line.
    assert.doesNotMatch(WIN32_PROCESS_LISTING, /"/);
  });

  it("rejects a non-zero exit or unparsable output", async () => {
    const failed = windowsProcessControl({
      run: runner({ status: 1, stdout: "", stderr: "Get-CimInstance broke" })
        .run,
    });
    await assert.rejects(failed.servers(), /Get-CimInstance broke/);
    const garbled = windowsProcessControl({
      run: runner({ status: 0, stdout: "<garbled>" }).run,
    });
    await assert.rejects(garbled.serverPids(), /process listing/);
  });

  it("refuses to run PowerShell inside the test runner", async () => {
    await assert.rejects(
      windowsProcessControl().servers(),
      /refusing to run powershell\.exe inside the test runner/,
    );
  });
});
