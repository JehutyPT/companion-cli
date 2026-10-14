import { execFile } from "node:child_process";
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
   * renamed bundle, a development build) and any other SQLite client.
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
