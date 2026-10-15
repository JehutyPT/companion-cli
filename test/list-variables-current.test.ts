import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { buildFixtureDb } from "./fixtures/companion-db.ts";
import {
  type CliRun,
  fileState,
  forbiddenProcessControl,
  installDir,
  runCli,
  tempDir,
} from "./helpers.ts";

/**
 * `list variables` without `--db` reads the install's database and then asks
 * a running Companion for each listed variable's current value. Companion is
 * a fake local HTTP server here; no test contacts a real one.
 */

const KEY = "stub-key-list-4d2a9c";

type Responder = (request: IncomingMessage, response: ServerResponse) => void;

let server: Server;
let baseUrl: string;
let paths: string[] = [];
let responder: Responder;

/** Answers `value-of-<name>` for every variable. */
const VALUES: Responder = (request, response) => {
  const match = /^\/api\/custom-variable\/([^/]+)\/value$/.exec(
    request.url ?? "",
  );
  if (!match) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": "text/plain" });
  response.end(`value-of-${decodeURIComponent(match[1] ?? "")}`);
};

before(async () => {
  server = createServer((request, response) => {
    paths.push(request.url ?? "");
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
      // A test leaves a request hanging on purpose: close it too.
      server.closeAllConnections();
      server.close(() => resolve());
    }),
);

beforeEach(() => {
  paths = [];
  responder = VALUES;
});

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) =>
    probe.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

interface Install {
  home: string;
  dbPath: string;
  tmpdir: string;
}

/** A temporary home with the standard fixture at the install path. */
function install(): Install {
  const home = tempDir();
  const dbPath = buildFixtureDb(installDir(home));
  return { home, dbPath, tmpdir: tempDir() };
}

interface ListRun {
  env?: Record<string, string | undefined>;
  cwd?: string;
  restTimeoutMs?: number;
}

/**
 * Runs `list variables [...args]` on the install and checks what every read
 * must leave behind: the database byte-identical, no temporary copy, no
 * process-control call and no API key in the output.
 */
async function listVariables(
  target: Install,
  args: string[] = [],
  run: ListRun = {},
): Promise<CliRun> {
  const before = fileState(target.dbPath);
  const { control, calls } = forbiddenProcessControl();
  const result = await runCli(["list", "variables", ...args], {
    homedir: target.home,
    tmpdir: target.tmpdir,
    processControl: control,
    env: run.env ?? { COMPANION_URL: baseUrl, COMPANION_API_KEY: KEY },
    ...(run.cwd !== undefined ? { cwd: run.cwd } : {}),
    ...(run.restTimeoutMs !== undefined
      ? { restTimeoutMs: run.restTimeoutMs }
      : {}),
  });
  assert.deepEqual(calls, [], "no process-control call");
  assert.deepEqual(fileState(target.dbPath), before, "database unchanged");
  assert.deepEqual(readdirSync(target.tmpdir), [], "temporary copy removed");
  for (const line of [...result.stdout, ...result.stderr]) {
    assert.ok(!line.includes(KEY), `key leaked: ${line}`);
  }
  return result;
}

function ok(result: CliRun): string[] {
  assert.equal(result.code, 0, result.stderr.join("\n"));
  assert.deepEqual(result.stderr, []);
  return result.stdout;
}

function json(result: CliRun): Record<string, unknown> & {
  variables: Array<Record<string, unknown>>;
} {
  const stdout = ok(result);
  assert.equal(stdout.length, 1);
  return JSON.parse(stdout[0] ?? "");
}

function currentValues(document: {
  variables: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  return Object.fromEntries(
    document.variables.map((variable) => [
      variable["name"],
      variable["currentValue"],
    ]),
  );
}

const ALL_NULL = { fx_counter: null, fx_label: null, fx_gap: null };

const VALUE_PATHS = ["fx_counter", "fx_label", "fx_gap"].map(
  (name) => `/api/custom-variable/${name}/value`,
);

describe("list variables: current values", () => {
  it("adds each variable's current value from the running Companion", async () => {
    const target = install();
    const document = json(await listVariables(target, ["--json"]));
    assert.deepEqual(document, {
      database: target.dbPath,
      variables: [
        {
          name: "fx_counter",
          defaultValue: 0,
          currentValue: "value-of-fx_counter",
          persistCurrentValue: false,
          description: "Counter",
          sortOrder: 0,
        },
        {
          name: "fx_label",
          defaultValue: "idle",
          currentValue: "value-of-fx_label",
          persistCurrentValue: true,
          description: "Label",
          sortOrder: 1,
        },
        {
          name: "fx_gap",
          defaultValue: "",
          currentValue: "value-of-fx_gap",
          persistCurrentValue: false,
          description: "A custom variable",
          sortOrder: 5,
        },
      ],
      values: "live",
    });
    assert.deepEqual(paths, VALUE_PATHS, "one request per variable, in order");
  });

  it("shows a CURRENT column after DEFAULT, as quoted text", async () => {
    const target = install();
    responder = (request, response) => {
      if (request.url?.includes("fx_label")) {
        response.end("a value that is longer than forty characters, cut");
      } else if (request.url?.includes("fx_gap")) {
        response.end("two\nlines");
      } else {
        response.end("0");
      }
    };
    assert.deepEqual(ok(await listVariables(target)), [
      "NAME        DEFAULT  CURRENT                                   PERSIST  DESCRIPTION",
      'fx_counter  0        "0"                                       no       Counter',
      'fx_label    "idle"   "a value that is longer than forty char…  yes      Label',
      'fx_gap      ""       "two\\nlines"                              no       A custom variable',
    ]);
  });

  it("sends the API key and asks only for the variables the patterns match", async () => {
    const target = install();
    let authorization: string | undefined;
    responder = (request, response) => {
      authorization = request.headers.authorization;
      VALUES(request, response);
    };
    const document = json(
      await listVariables(target, ["fx_gap", "*counter", "--json"]),
    );
    assert.deepEqual(currentValues(document), {
      fx_counter: "value-of-fx_counter",
      fx_gap: "value-of-fx_gap",
    });
    assert.deepEqual(paths, [
      "/api/custom-variable/fx_counter/value",
      "/api/custom-variable/fx_gap/value",
    ]);
    assert.equal(authorization, `Bearer ${KEY}`);
  });

  it("makes no request when no variable matches", async () => {
    const target = install();
    const document = json(await listVariables(target, ["nomatch*", "--json"]));
    assert.deepEqual(document, {
      database: target.dbPath,
      variables: [],
      values: "live",
    });
    assert.deepEqual(paths, []);
  });

  it("gives null for a variable Companion does not know, and reads the others", async () => {
    const target = install();
    responder = (request, response) => {
      if (request.url?.includes("fx_label")) response.writeHead(404).end();
      else VALUES(request, response);
    };
    const document = json(await listVariables(target, ["--json"]));
    assert.equal(document["values"], "live");
    assert.deepEqual(currentValues(document), {
      fx_counter: "value-of-fx_counter",
      fx_label: null,
      fx_gap: "value-of-fx_gap",
    });
    assert.deepEqual(paths, VALUE_PATHS);
    assert.deepEqual(ok(await listVariables(target)).slice(0, 3), [
      "NAME        DEFAULT  CURRENT                PERSIST  DESCRIPTION",
      'fx_counter  0        "value-of-fx_counter"  no       Counter',
      'fx_label    "idle"   -                      yes      Label',
    ]);
  });

  describe("when the values are unavailable", () => {
    /**
     * Checks the JSON and the text output of one unavailable outcome: exit 0,
     * every value null, the reason and note, and the note line after the table.
     */
    async function assertUnavailable(
      target: Install,
      run: ListRun,
      reason: string,
      note: RegExp,
    ): Promise<void> {
      const document = json(await listVariables(target, ["--json"], run));
      assert.equal(document["values"], "unavailable");
      assert.equal(document["reason"], reason);
      assert.match(String(document["note"]), note);
      assert.deepEqual(currentValues(document), ALL_NULL);
      assert.deepEqual(Object.keys(document), [
        "database",
        "variables",
        "values",
        "note",
        "reason",
      ]);

      const text = ok(await listVariables(target, [], run));
      assert.deepEqual(text.slice(0, 2), [
        "NAME        DEFAULT  CURRENT  PERSIST  DESCRIPTION",
        "fx_counter  0        -        no       Counter",
      ]);
      assert.equal(text.length, 5);
      assert.equal(
        text[4],
        `note: current values unavailable (${String(document["note"])}); showing database values only`,
      );
    }

    it("reports not_configured when no endpoint is set", async () => {
      await assertUnavailable(
        install(),
        { env: {} },
        "not_configured",
        /COMPANION_URL is not set/,
      );
      assert.deepEqual(paths, []);
    });

    it("reports not_configured for a non-local URL, without a request", async () => {
      await assertUnavailable(
        install(),
        {
          env: {
            COMPANION_URL: "http://companion.example.com:8000",
            COMPANION_API_KEY: KEY,
          },
        },
        "not_configured",
        /is not local/,
      );
    });

    it("reads the endpoint from the user config file under the test home", async () => {
      const target = install();
      const dir = join(target.home, ".config", "companion-cli");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, ".env.local"),
        `COMPANION_URL=${baseUrl}\nCOMPANION_API_KEY=${KEY}\n`,
      );
      const document = json(
        await listVariables(target, ["fx_gap", "--json"], { env: {} }),
      );
      assert.equal(document["values"], "live");
      assert.deepEqual(currentValues(document), { fx_gap: "value-of-fx_gap" });
    });

    it("reports not_reachable when the connection is refused", async () => {
      const port = await closedPort();
      await assertUnavailable(
        install(),
        {
          env: {
            COMPANION_URL: `http://127.0.0.1:${port}`,
            COMPANION_API_KEY: KEY,
          },
        },
        "not_reachable",
        /not reachable at http:\/\/127\.0\.0\.1/,
      );
    });

    it("reports not_reachable when Companion does not answer in time, after one request", async () => {
      responder = () => {
        // Never answers.
      };
      await assertUnavailable(
        install(),
        { restTimeoutMs: 100 },
        "not_reachable",
        /did not answer .* within 0\.1 s/,
      );
      assert.deepEqual(paths, [VALUE_PATHS[0], VALUE_PATHS[0]]);
    });

    it("reports unauthorised on a 401 and stops", async () => {
      responder = (_request, response) => response.writeHead(401).end();
      await assertUnavailable(install(), {}, "unauthorised", /401/);
      assert.deepEqual(paths, [VALUE_PATHS[0], VALUE_PATHS[0]]);
    });

    it("reports unauthorised on a 403 (the HTTP API is disabled)", async () => {
      responder = (_request, response) => response.writeHead(403).end();
      await assertUnavailable(install(), {}, "unauthorised", /disabled/);
    });

    it("discards values already read when a later request fails", async () => {
      responder = (request, response) => {
        if (request.url?.includes("fx_gap")) response.writeHead(500).end();
        else VALUES(request, response);
      };
      await assertUnavailable(install(), {}, "not_reachable", /HTTP 500/);
    });

    it("redacts the API key from the note", async () => {
      const target = install();
      const document = json(
        await listVariables(target, ["--json"], {
          env: { COMPANION_URL: `not a url ${KEY}`, COMPANION_API_KEY: KEY },
        }),
      );
      assert.equal(document["reason"], "not_configured");
      assert.match(String(document["note"]), /\[redacted\]/);
    });
  });

  describe("skipping the values", () => {
    it("--no-current makes no request and adds no note", async () => {
      const target = install();
      const document = json(
        await listVariables(target, ["--no-current", "--json"]),
      );
      assert.equal(document["values"], "skipped");
      assert.equal(document["note"], undefined);
      assert.equal(document["reason"], undefined);
      assert.deepEqual(currentValues(document), ALL_NULL);
      assert.deepEqual(ok(await listVariables(target, ["--no-current"])), [
        "NAME        DEFAULT  CURRENT  PERSIST  DESCRIPTION",
        "fx_counter  0        -        no       Counter",
        'fx_label    "idle"   -        yes      Label',
        'fx_gap      ""       -        no       A custom variable',
      ]);
      assert.deepEqual(paths, []);
    });

    it("--db makes no request and says why", async () => {
      const target = install();
      const args = ["--db", target.dbPath];
      const document = json(await listVariables(target, [...args, "--json"]));
      assert.deepEqual(Object.keys(document), [
        "database",
        "variables",
        "values",
        "note",
      ]);
      assert.equal(document["values"], "skipped");
      assert.equal(
        document["note"],
        "current values are only read for the install's database",
      );
      assert.deepEqual(currentValues(document), ALL_NULL);
      const text = ok(await listVariables(target, args));
      assert.equal(
        text.at(-1),
        "note: current values are only read for the install's database",
      );
      assert.deepEqual(paths, []);
    });

    it("list triggers refuses --no-current", async () => {
      const target = install();
      const result = await runCli(
        ["list", "triggers", "--no-current", "--json"],
        { homedir: target.home, tmpdir: target.tmpdir },
      );
      assert.equal(result.code, 2);
      const document = JSON.parse(result.stdout[0] ?? "");
      assert.equal(document.error.code, "usage");
      assert.match(document.error.message, /--no-current/);
    });
  });

  it("a database failure is still a JSON error document, with no request", async () => {
    const home = tempDir();
    const result = await runCli(["list", "variables", "--json"], {
      homedir: home,
      env: { COMPANION_URL: baseUrl, COMPANION_API_KEY: KEY },
    });
    assert.equal(result.code, 1);
    const document = JSON.parse(result.stdout[0] ?? "");
    assert.equal(document.error.code, "database_not_found");
    assert.deepEqual(paths, []);
  });
});
