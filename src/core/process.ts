import { execFile } from "node:child_process";
import { open as openFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Controls the local Companion application. The apply pipeline only talks to
 * Companion's process through this interface (`ApplyOptions.processControl`),
 * which is the test seam: tests pass a fake, so no test quits or starts a real
 * Companion.
 */
export interface ProcessControl {
  /** PIDs of the running Companion server processes; empty when not running. */
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

/** Parses `ps -o pid=,command=` output into the PIDs of server processes. */
export function serverPidsFromPs(stdout: string): number[] {
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && isServerCommand(match[2] ?? "")) pids.push(Number(match[1]));
  }
  return pids;
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
    execFile(file, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        reject(new Error(`cannot run ${file}: ${error.message}`));
      } else {
        resolve({ status: error ? Number(error.code) : 0, stdout, stderr });
      }
    });
  });
};

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

  const serverPids = async () =>
    serverPidsFromPs(
      await succeed(run, "ps", ["-axww", "-o", "pid=,command="]),
    );

  return {
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
 * briefly) means another process has it open; it cannot say which. Listing,
 * quitting, waiting for and starting Companion are not supported yet, and
 * apply does not call them on Windows, where live-install mode is refused.
 *
 * Unlike the macOS command runner the probe is not refused inside the test
 * runner: it only opens and closes files.
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

  return {
    serverPids: unsupported("listing Companion's processes"),
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
