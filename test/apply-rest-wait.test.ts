import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { buildFixtureDb } from "./fixtures/companion-db.ts";
import {
  type CliRun,
  fakeProcessControl,
  type FakeProcessOptions,
  installDir,
  runCli,
  tempDir,
  writeDescription,
} from "./helpers.ts";

/**
 * After a live-install apply starts Companion again, it waits for Companion's
 * REST API. Companion is a fake local HTTP server and fake process control
 * here; no test contacts or starts a real one.
 */

const KEY = "stub-key-rest-wait-7f3e1b";
const PROBE = "/api/v2/openapi.json";
const NOTE = "note: REST not configured; not waiting for Companion's API";
const READY = /^Companion REST ready after \d+\.\ds$/;

type Responder = (request: IncomingMessage, response: ServerResponse) => void;

let server: Server;
let baseUrl: string;
let paths: string[] = [];
let auth: (string | undefined)[] = [];
let responder: Responder;

/** Drops the connection without an answer, as a server still starting does. */
const DROP: Responder = (request) => request.socket.destroy();

/** Answers `status` to every probe. */
const answer =
  (status: number): Responder =>
  (_request, response) =>
    response.writeHead(status).end();

/** Uses `first` for the first `count` requests, then `then`. */
function afterRequests(
  count: number,
  first: Responder,
  then: Responder,
): Responder {
  let seen = 0;
  return (request, response) =>
    (seen++ < count ? first : then)(request, response);
}

before(async () => {
  server = createServer((request, response) => {
    paths.push(request.url ?? "");
    auth.push(request.headers.authorization);
    responder(request, response);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
);

beforeEach(() => {
  paths = [];
  auth = [];
  responder = answer(200);
});

const YAML = `kind: variables
variables:
  - name: wait_one
    default: 1
`;

interface WaitRun {
  args?: string[];
  env?: Record<string, string>;
  process?: FakeProcessOptions;
  /** `--db <install db>` instead of live-install mode. */
  db?: boolean;
}

/** Runs `apply` on a fresh install with a 5 ms poll interval. */
async function applyWithWait(run: WaitRun = {}): Promise<CliRun> {
  const home = tempDir();
  const dbPath = buildFixtureDb(installDir(home), { wal: true });
  const file = writeDescription(home, YAML);
  const fake = fakeProcessControl(run.process ?? { running: true });
  const result = await runCli(
    [
      "apply",
      file,
      ...(run.db ? ["--db", dbPath] : []),
      ...(run.args ?? ["--rest-timeout", "2"]),
    ],
    {
      homedir: home,
      processControl: fake.control,
      env: run.env ?? { COMPANION_URL: baseUrl, COMPANION_API_KEY: KEY },
      restPollIntervalMs: 5,
    },
  );
  for (const line of [...result.stdout, ...result.stderr]) {
    assert.ok(!line.includes(KEY), `key leaked: ${line}`);
  }
  return result;
}

function jsonDoc(result: CliRun): Record<string, unknown> {
  assert.equal(result.stdout.length, 1, result.stdout.join("\n"));
  return JSON.parse(result.stdout[0] ?? "") as Record<string, unknown>;
}

describe("apply waits for REST after starting Companion", () => {
  it("ready: polls until the third probe answers, then logs the ready line before the summary", async () => {
    responder = afterRequests(2, DROP, answer(200));
    const result = await applyWithWait();
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(paths, [PROBE, PROBE, PROBE]);
    assert.deepEqual(auth, Array(3).fill(`Bearer ${KEY}`));
    const start = result.stdout.indexOf("starting Companion");
    assert.ok(start >= 0);
    assert.match(result.stdout[start + 1] ?? "", READY);
    assert.equal(
      result.stdout.at(-1),
      "custom variables: 1 created, 0 replaced",
    );
    assert.deepEqual(result.stderr, []);
  });

  it("ready, --json: rest ready, no warnings, the ready line on stderr", async () => {
    responder = afterRequests(2, DROP, answer(200));
    const result = await applyWithWait({
      args: ["--rest-timeout", "2", "--json"],
    });
    assert.equal(result.code, 0);
    const doc = jsonDoc(result);
    assert.equal(doc["restarted"], true);
    assert.equal(doc["rest"], "ready");
    assert.deepEqual(doc["warnings"], []);
    assert.match(result.stderr.at(-1) ?? "", READY);
  });

  for (const status of [401, 403, 204]) {
    it(`a ${status} counts as ready`, async () => {
      responder = answer(status);
      const result = await applyWithWait({
        args: ["--rest-timeout", "2", "--json"],
      });
      assert.equal(jsonDoc(result)["rest"], "ready");
      assert.deepEqual(paths, [PROBE]);
    });
  }

  for (const status of [404, 500]) {
    it(`a ${status} keeps polling`, async () => {
      responder = afterRequests(2, answer(status), answer(200));
      const result = await applyWithWait({
        args: ["--rest-timeout", "2", "--json"],
      });
      assert.equal(jsonDoc(result)["rest"], "ready");
      assert.equal(paths.length, 3);
    });
  }

  it("timeout: warns on stderr and exits 0", async () => {
    responder = DROP;
    const result = await applyWithWait({ args: ["--rest-timeout", "0.1"] });
    assert.equal(result.code, 0);
    assert.deepEqual(result.stderr, [
      "warning: Companion started; REST not ready after 0.1s",
    ]);
    assert.ok(paths.length > 1, `polled ${paths.length} times`);
    assert.ok(!result.stdout.some((line) => READY.test(line)));
    assert.equal(
      result.stdout.at(-1),
      "custom variables: 1 created, 0 replaced",
    );
  });

  it("timeout, --json: rest timeout, the warning in warnings and on stderr", async () => {
    responder = DROP;
    const result = await applyWithWait({
      args: ["--rest-timeout", "0.1", "--json"],
    });
    assert.equal(result.code, 0);
    const warning = "warning: Companion started; REST not ready after 0.1s";
    const doc = jsonDoc(result);
    assert.equal(doc["rest"], "timeout");
    assert.deepEqual(doc["warnings"], [warning]);
    assert.equal(result.stderr.at(-1), warning);
  });

  it("a probe that never answers is cut off at the timeout", async () => {
    responder = () => {};
    const started = performance.now();
    const result = await applyWithWait({
      args: ["--rest-timeout", "0.2", "--json"],
    });
    const elapsed = performance.now() - started;
    assert.equal(jsonDoc(result)["rest"], "timeout");
    // The probe is cut off at the time left; a timer firing a little early
    // can leave room for one more short probe.
    assert.ok(paths.length <= 2, `probed ${paths.length} times`);
    assert.ok(elapsed < 1000, `took ${elapsed} ms`);
  });

  it("not configured: the note, no request", async () => {
    const result = await applyWithWait({ env: {} });
    assert.equal(result.code, 0);
    const start = result.stdout.indexOf("starting Companion");
    assert.equal(result.stdout[start + 1], NOTE);
    assert.deepEqual(paths, []);
    assert.deepEqual(result.stderr, []);
  });

  it("not configured, --json: rest not_configured, the note on stderr", async () => {
    const result = await applyWithWait({
      env: {},
      args: ["--json"],
    });
    const doc = jsonDoc(result);
    assert.equal(doc["rest"], "not_configured");
    assert.deepEqual(doc["warnings"], []);
    assert.equal(result.stderr.at(-1), NOTE);
  });

  it("an invalid endpoint is not configured, with its reason", async () => {
    const result = await applyWithWait({
      env: { COMPANION_URL: "http://example.com", COMPANION_API_KEY: KEY },
      args: ["--json"],
    });
    assert.equal(jsonDoc(result)["rest"], "not_configured");
    assert.match(
      result.stderr.at(-1) ?? "",
      /^note: REST not configured; not waiting for Companion's API \(COMPANION_URL host "example\.com" is not local.*\)$/,
    );
    assert.deepEqual(paths, []);
  });

  it("a tiny positive --rest-timeout still waits", async () => {
    responder = () => {};
    const result = await applyWithWait({
      args: ["--rest-timeout", "0.0001", "--json"],
    });
    assert.equal(jsonDoc(result)["rest"], "timeout");
    assert.ok(paths.length <= 1);
  });

  it("--rest-timeout 0 makes no request and leaves rest null", async () => {
    const result = await applyWithWait({
      args: ["--rest-timeout", "0", "--json"],
    });
    assert.equal(result.code, 0);
    assert.equal(jsonDoc(result)["rest"], null);
    assert.deepEqual(paths, []);
    assert.ok(!result.stderr.includes(NOTE));
  });
});

describe("apply does not wait when it did not start Companion", () => {
  const cases: Array<[string, WaitRun]> = [
    ["--db", { db: true, process: { running: false } }],
    ["a dry run", { args: ["--dry-run", "--json"] }],
    ["Companion not running", { process: { running: false } }],
  ];
  for (const [name, run] of cases) {
    it(`${name}: no request, rest null`, async () => {
      const result = await applyWithWait({
        ...run,
        args: [...(run.args ?? ["--json"]), "--rest-timeout", "2"],
      });
      assert.equal(result.code, 0, result.stdout.join("\n"));
      assert.deepEqual(paths, []);
      const doc = jsonDoc(result);
      if (name !== "a dry run") assert.equal(doc["rest"], null);
    });
  }

  it("a failed restart: no request, restart_failed", async () => {
    const result = await applyWithWait({
      process: { running: true, failStart: true },
      args: ["--json"],
    });
    assert.equal(result.code, 1);
    assert.equal(
      (jsonDoc(result)["error"] as Record<string, unknown>)["code"],
      "restart_failed",
    );
    assert.deepEqual(paths, []);
  });
});

describe("--rest-timeout: usage", () => {
  for (const value of ["-1", "abc", "", "1e3", "Infinity"]) {
    it(`refuses "${value}" with exit 2`, async () => {
      const result = await applyWithWait({
        args: [`--rest-timeout=${value}`],
      });
      assert.equal(result.code, 2);
      assert.match(result.stderr[0] ?? "", /--rest-timeout/);
      assert.deepEqual(paths, []);
    });
  }

  it("refuses a missing value with exit 2", async () => {
    const result = await applyWithWait({ args: ["--rest-timeout"] });
    assert.equal(result.code, 2);
  });

  it("--json: a usage error document", async () => {
    const result = await applyWithWait({
      args: ["--rest-timeout", "-1", "--json"],
    });
    assert.equal(result.code, 2);
    const error = jsonDoc(result)["error"] as Record<string, unknown>;
    assert.equal(error["code"], "usage");
    assert.deepEqual(result.stderr, []);
  });
});
