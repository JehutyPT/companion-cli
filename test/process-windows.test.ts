import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DatabaseInUseError,
  defaultProcessControl,
  EXCLUSIVE_OPEN_FLAG,
  type FileOpener,
  windowsProcessControl,
} from "../src/core/process.ts";

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

  it("does not support listing, quitting, waiting for or starting Companion yet", async () => {
    const control = windowsProcessControl();
    for (const call of [
      () => control.serverPids(),
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
