import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  type CommandRunner,
  companionServers,
  DatabaseInUseError,
  defaultProcessControl,
  EXCLUSIVE_OPEN_FLAG,
  type FileOpener,
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

  it("does not support quitting, waiting for or starting Companion yet", async () => {
    const control = windowsProcessControl();
    for (const call of [
      () => control.quit(),
      () => control.waitForExit([1], 10),
      () => control.start(),
    ]) {
      await assert.rejects(call(), /not supported on Windows yet/);
    }
  });
});

describe("default process control", () => {
  // The macOS control's command runner refuses inside the test runner, so its
  // quit names osascript; the Windows control's quit is not supported yet.
  it("is the macOS control on macOS", async () => {
    await assert.rejects(
      defaultProcessControl("darwin").quit(),
      /refusing to run osascript/,
    );
  });

  it("is the Windows control on Windows", async () => {
    await assert.rejects(
      defaultProcessControl("win32").quit(),
      /not supported on Windows yet/,
    );
  });

  it("stays the macOS control elsewhere, which apply never calls there", async () => {
    await assert.rejects(
      defaultProcessControl("linux").quit(),
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
