import { execFile } from "node:child_process";
import { open as openFile } from "node:fs/promises";
import { win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Controls the local Companion application. The apply pipeline only talks to
 * Companion's process through this interface (`ApplyOptions.processControl`),
 * which is the test seam: tests pass a fake, so no test quits or starts a real
 * Companion.
 */
export interface ProcessControl {
  /** The running Companion server processes; empty when not running. */
  servers(): Promise<CompanionServer[]>;
  /** PIDs of the running Companion server processes (`servers`' PIDs). */
  serverPids(): Promise<number[]>;
  /**
   * PIDs of processes that have the database or its `-wal` / `-shm` file
   * open; empty when none. Catches a Companion the server match misses (a
   * renamed bundle, a development build) and any other SQLite client. A
   * platform that can tell the database is in use but not by whom throws
   * `DatabaseInUseError` instead.
   */
  databaseHolders(dbPath: string): Promise<number[]>;
  /** Asks Companion to quit. Returns once the request is sent, not when it has exited. */
  quit(): Promise<void>;
  /**
   * Waits until none of `pids` is a running server process. Resolves `true`
   * once they are gone, `false` if `timeoutMs` passes first.
   */
  waitForExit(pids: readonly number[], timeoutMs: number): Promise<boolean>;
  /** Starts Companion. The launcher starts the server on its own. */
  start(): Promise<void>;
}

/** A running Companion server process (see CONTEXT.md). */
export interface CompanionServer {
  pid: number;
  /**
   * The whole command line, trimmed. #43 reads `--config-dir=` from it; its
   * value may be unquoted with spaces, and end in a separator.
   */
  commandLine: string;
  /**
   * The install the server runs from: on Windows the folder holding
   * `resources\main.js`, on macOS the `Companion.app` bundle. Null when the
   * command line does not say.
   */
  install: string | null;
  /** Windows session id; null on macOS. */
  sessionId: number | null;
  /** The launcher, the server's parent process (Windows only; null on macOS or when unlisted). */
  launcher: LauncherProcess | null;
}

/** Companion's launcher process (`Companion.exe` on Windows). */
export interface LauncherProcess {
  pid: number;
  /** Its executable, which #40 starts again; null when unreadable. */
  path: string | null;
  sessionId: number | null;
}

/** Default wait for the server process to exit after a quit. */
export const DEFAULT_QUIT_TIMEOUT_MS = 30_000;

/**
 * The server is `node … Companion.app/Contents/Resources/main.js
 * --config-dir=…`. Connection modules also run a `main.js`, but from the
 * configuration directory's `modules/<module>/`, so they never match; nor do
 * the launcher, its helpers or `SurfaceThread.js`.
 */
const SERVER_SCRIPT = /Companion\.app\/Contents\/Resources\/main\.js(\s|$)/;

export function isServerCommand(command: string): boolean {
  return SERVER_SCRIPT.test(command);
}

/** The bundle of a server run by its own bundled runtime, else null. */
function macosBundle(command: string): string | null {
  const runtime = "/Contents/Resources/node-runtimes/";
  const index = command.indexOf(runtime);
  if (index <= 0) return null;
  const bundle = command.slice(0, index);
  return bundle.endsWith(".app") &&
    command.includes(` ${bundle}/Contents/Resources/main.js`)
    ? bundle
    : null;
}

/** Parses `ps -o pid=,command=` output into the server processes. */
export function serversFromPs(stdout: string): CompanionServer[] {
  const servers: CompanionServer[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    const command = (match?.[2] ?? "").trim();
    if (match && isServerCommand(command)) {
      servers.push({
        pid: Number(match[1]),
        commandLine: command,
        install: macosBundle(command),
        sessionId: null,
        launcher: null,
      });
    }
  }
  return servers;
}

/** Parses `ps -o pid=,command=` output into the PIDs of server processes. */
export function serverPidsFromPs(stdout: string): number[] {
  return serversFromPs(stdout).map((server) => server.pid);
}

/** One process of a Windows listing (`Win32_Process`). */
export interface Win32Process {
  pid: number;
  parentPid: number;
  sessionId: number | null;
  /** Null when Windows does not say (system processes). */
  executablePath: string | null;
  commandLine: string | null;
}

/**
 * The PowerShell script that lists every process as JSON, one array even
 * for a single process, with UTF-8 output so non-ASCII install paths survive.
 * `Get-CimInstance` because WMIC is gone from Windows 11 24H2. It reads
 * `CommandLine` and `ExecutablePath` without elevation (spike #36, row 3).
 * No double quotes, which would need escaping on the command line.
 */
export const WIN32_PROCESS_LISTING =
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
  "ConvertTo-Json -Compress -InputObject @(Get-CimInstance -ClassName Win32_Process | " +
  "Select-Object ProcessId,ParentProcessId,SessionId,ExecutablePath,CommandLine)";

/**
 * Parses `WIN32_PROCESS_LISTING`'s output. A bare object is one process.
 * Anything that is not a list of processes with numeric ids throws, so a
 * caller that gates a write fails closed.
 */
export function parseWin32Processes(stdout: string): Win32Process[] {
  const invalid = (why: string) =>
    new Error(`unexpected Windows process listing: ${why}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw invalid(`not JSON (${JSON.stringify(stdout.slice(0, 80))})`);
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.map((item) => {
    const entry = (
      typeof item === "object" && item !== null ? item : {}
    ) as Record<string, unknown>;
    const { ProcessId, ParentProcessId, SessionId } = entry;
    const { ExecutablePath, CommandLine } = entry;
    if (typeof ProcessId !== "number" || typeof ParentProcessId !== "number") {
      throw invalid(`no process ids in ${JSON.stringify(item)}`);
    }
    const text = (value: unknown, name: string): string | null => {
      if (value === null || value === undefined) return null;
      if (typeof value !== "string")
        throw invalid(`${name} of process ${ProcessId} is not text`);
      return value;
    };
    return {
      pid: ProcessId,
      parentPid: ParentProcessId,
      sessionId: typeof SessionId === "number" ? SessionId : null,
      executablePath: text(ExecutablePath, "ExecutablePath"),
      commandLine: text(CommandLine, "CommandLine"),
    };
  });
}

/**
 * `<install>\resources\main.js` as an argument of its own, quoted or not
 * (libuv quotes arguments with spaces); `\` or `/`, any case.
 */
const WIN32_MAIN_JS =
  /(?:^|\s)(?:"([^"]*[\\/]resources[\\/]main\.js)"|([^\s"]+[\\/]resources[\\/]main\.js))(?=\s|$)/i;

/** A Windows path folded for comparison: lower case, `\` separators. */
export function foldWin32(path: string): string {
  return path.replace(/\//g, "\\").toLowerCase();
}

/** The executable a command line starts with, quoted or not. */
function firstArgument(commandLine: string): string {
  return /^"([^"]*)"|^(\S+)/.exec(commandLine)?.slice(1).find(Boolean) ?? "";
}

/**
 * The install a Windows process runs Companion's server from, or null when
 * it is not a server: a `node.exe` under `<install>\resources\node-runtimes\`
 * running `<install>\resources\main.js` (spike #36, row 3). Connection
 * modules run a `main.js` from the configuration folder's `modules\`, surface
 * threads `resources\SurfaceThread.js`; neither, nor the launcher, its
 * Electron helpers or any other program named after Companion, matches.
 */
function win32ServerInstall(listed: Win32Process): string | null {
  if (listed.commandLine === null) return null;
  const match = WIN32_MAIN_JS.exec(listed.commandLine);
  const mainJs = match?.[1] ?? match?.[2];
  if (mainJs === undefined) return null;
  const install = win32.dirname(win32.dirname(mainJs));
  const executable =
    listed.executablePath ?? firstArgument(listed.commandLine.trim());
  const runtimes = `${foldWin32(install)}\\resources\\node-runtimes\\`;
  const folded = foldWin32(executable);
  return folded.startsWith(runtimes) && folded.endsWith("\\node.exe")
    ? install
    : null;
}

/** The Companion servers in a Windows listing, each with its launcher. */
export function companionServers(
  processes: readonly Win32Process[],
): CompanionServer[] {
  const servers: CompanionServer[] = [];
  for (const listed of processes) {
    const install = win32ServerInstall(listed);
    if (install === null) continue;
    const parent = processes.find((other) => other.pid === listed.parentPid);
    servers.push({
      pid: listed.pid,
      commandLine: (listed.commandLine ?? "").trim(),
      install,
      sessionId: listed.sessionId,
      launcher: parent
        ? {
            pid: parent.pid,
            path: parent.executablePath,
            sessionId: parent.sessionId,
          }
        : null,
    });
  }
  return servers;
}

/**
 * The session of process `pid` in a listing, or null when unlisted. The
 * CLI's own (`process.pid`) is in the same listing as the launcher: #40
 * compares the two before a quit.
 */
export function sessionIdOf(
  processes: readonly Win32Process[],
  pid: number,
): number | null {
  return processes.find((listed) => listed.pid === pid)?.sessionId ?? null;
}

/** Parses `lsof -t` output: one PID per line. Anything else is an error. */
export function holderPidsFromLsof(stdout: string): number[] {
  const pids = new Set<number>();
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    if (!/^\d+$/.test(text)) {
      throw new Error(`unexpected lsof output: ${JSON.stringify(text)}`);
    }
    pids.add(Number(text));
  }
  return [...pids];
}

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command and resolves to its exit status and output. Rejects only
 * when the command cannot run at all.
 */
export type CommandRunner = (
  file: string,
  args: readonly string[],
) => Promise<CommandResult>;

export interface MacosProcessControlOptions {
  run?: CommandRunner;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Delay between process listings while waiting. */
  pollMs?: number;
}

/**
 * Runs real commands. Refuses inside `node --test` (which sets
 * `NODE_TEST_CONTEXT` in every test process, including executables a test
 * spawns), so a test that forgot to inject a fake fails instead of quitting or
 * starting the developer's Companion.
 */
const execRunner: CommandRunner = (file, args) => {
  if (process.env["NODE_TEST_CONTEXT"]) {
    return Promise.reject(
      new Error(
        `refusing to run ${file} inside the test runner; inject a fake process control`,
      ),
    );
  }
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: "utf8", maxBuffer: RUNNER_MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(new Error(`cannot run ${file}: ${error.message}`));
        } else {
          resolve({ status: error ? Number(error.code) : 0, stdout, stderr });
        }
      },
    );
  });
};

/**
 * Output limit of a real command. A full process listing carries every
 * process's command line (Electron and browser helpers have long ones), well
 * past `execFile`'s 1 MB default; exceeding the limit rejects, which fails
 * closed.
 */
const RUNNER_MAX_BUFFER = 64 * 1024 * 1024;

/** Runs a command that must exit 0 and returns its stdout. */
async function succeed(
  run: CommandRunner,
  file: string,
  args: readonly string[],
): Promise<string> {
  const result = await run(file, args);
  if (result.status !== 0) {
    throw new Error(
      `${file} exited ${result.status}: ${result.stderr.trim() || "no output"}`,
    );
  }
  return result.stdout;
}

/**
 * macOS: lists processes with `ps`, finds database holders with `lsof -t`,
 * quits with `osascript -e 'quit app "Companion"'` and starts with
 * `open -a Companion`.
 */
export function macosProcessControl(
  options: MacosProcessControlOptions = {},
): ProcessControl {
  const run = options.run ?? execRunner;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 250;

  const servers = async () =>
    serversFromPs(await succeed(run, "ps", ["-axww", "-o", "pid=,command="]));
  const serverPids = async () => (await servers()).map((server) => server.pid);

  return {
    servers,
    serverPids,
    databaseHolders: async (dbPath) => {
      const result = await run("lsof", [
        "-t",
        "--",
        dbPath,
        `${dbPath}-wal`,
        `${dbPath}-shm`,
      ]);
      // lsof exits 1 when no file is open, and also when a listed file (a
      // missing -wal or -shm) does not exist; the PIDs on stdout still count.
      if (result.status === 0 || result.status === 1) {
        return holderPidsFromLsof(result.stdout);
      }
      throw new Error(
        `lsof exited ${result.status}: ${result.stderr.trim() || "no output"}`,
      );
    },
    quit: async () => {
      await succeed(run, "osascript", ["-e", 'quit app "Companion"']);
    },
    waitForExit: async (pids, timeoutMs) => {
      const deadline = now() + timeoutMs;
      for (;;) {
        const running = await serverPids();
        if (!pids.some((pid) => running.includes(pid))) return true;
        if (now() >= deadline) return false;
        await sleep(pollMs);
      }
    },
    start: async () => {
      await succeed(run, "open", ["-a", "Companion"]);
    },
  };
}

/**
 * The database is open in another process, which the platform cannot name.
 * Thrown by `ProcessControl.databaseHolders`; apply refuses with the in-use
 * message instead of the "cannot tell" one.
 */
export class DatabaseInUseError extends Error {
  override name = "DatabaseInUseError";
}

/**
 * libuv's `UV_FS_O_EXLOCK`: on Windows, open with share mode 0, so the open
 * fails with `EBUSY` (a sharing violation) while any other handle is open.
 * A literal because Node does not export it: `fs.constants.UV_FS_O_EXLOCK` is
 * `undefined`, and `O_RDONLY | undefined` is a plain open that always
 * succeeds (spike #36, row 8).
 */
export const EXCLUSIVE_OPEN_FLAG = 0x10000000;

/** Opens a file with `flags` (`fs.promises.open`'s shape); the probe closes it at once. */
export type FileOpener = (
  path: string,
  flags: number,
) => Promise<{ close(): Promise<void> }>;

export interface WindowsProcessControlOptions {
  run?: CommandRunner;
  open?: FileOpener;
  sleep?: (ms: number) => Promise<void>;
  /** Opens per file before a sharing violation counts as in use. */
  attempts?: number;
  /** Delay between those opens. */
  retryMs?: number;
}

/**
 * Windows: the in-use check opens each of the database, `-wal` and `-shm`
 * that exists with an exclusive share mode and closes it again. A sharing
 * violation that outlasts a few retries (antivirus and the indexer hold files
 * briefly) means another process has it open; it cannot say which.
 *
 * Listing runs `WIN32_PROCESS_LISTING` in PowerShell (no profile, never
 * interactive) through the command runner, which refuses inside the test
 * runner as on macOS. Quitting, waiting for and starting Companion are not
 * supported yet (#40), and apply does not call them on Windows, where
 * live-install mode is refused.
 *
 * Unlike the command runner the probe is not refused inside the test runner:
 * it only opens and closes files.
 *
 * Every handle counts, this process's own included (there is no PID to
 * filter, as macOS filters its own): apply must have closed its snapshot and
 * any other connection to the database before it calls the check. Only
 * `EBUSY` is retried; any other error, `EPERM` and `EACCES` included, fails
 * closed at once.
 */
export function windowsProcessControl(
  options: WindowsProcessControlOptions = {},
): ProcessControl {
  const run = options.run ?? execRunner;
  const open: FileOpener = options.open ?? openFile;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const attempts = options.attempts ?? 5;
  const retryMs = options.retryMs ?? 250;

  /** Whether `path` is free: true when closed or missing, false when locked. */
  const isFree = async (path: string): Promise<boolean> => {
    for (let attempt = 1; ; attempt++) {
      try {
        const handle = await open(path, EXCLUSIVE_OPEN_FLAG);
        await handle.close();
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return true;
        if (code !== "EBUSY") throw error;
        if (attempt >= attempts) return false;
        await sleep(retryMs);
      }
    }
  };

  const unsupported = (what: string) => () =>
    Promise.reject(new Error(`${what} is not supported on Windows yet`));

  const listProcesses = async () =>
    parseWin32Processes(
      await succeed(run, "powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WIN32_PROCESS_LISTING,
      ]),
    );
  const servers = async () => companionServers(await listProcesses());

  return {
    servers,
    serverPids: async () => (await servers()).map((server) => server.pid),
    databaseHolders: async (dbPath) => {
      for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (!(await isFree(path))) {
          throw new DatabaseInUseError(`${path} is open in another process`);
        }
      }
      return [];
    },
    quit: unsupported("quitting Companion"),
    waitForExit: unsupported("waiting for Companion to exit"),
    start: unsupported("starting Companion"),
  };
}

/**
 * The process control for `platform`: Windows gets the Windows control, every
 * other platform the macOS one (apply only calls it on macOS there).
 */
export function defaultProcessControl(
  platform: NodeJS.Platform,
): ProcessControl {
  return platform === "win32" ? windowsProcessControl() : macosProcessControl();
}
