import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { type CliRun, runCli, tempDir } from "./helpers.ts";

const KEY = "stub-key-7f3c9e1a5b";

interface Recorded {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

type Responder = (request: Recorded, response: ServerResponse) => void;

let server: Server;
let baseUrl: string;
let requests: Recorded[] = [];
let responder: Responder = (_request, response) => response.end("OK");

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: Recorded = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      responder(recorded, res);
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
);

beforeEach(() => {
  requests = [];
  responder = (_request, response) => response.end("OK");
});

function reply(status: number, body = "", contentType = "text/plain") {
  responder = (_request, response) => {
    response.writeHead(status, { "Content-Type": contentType });
    response.end(body);
  };
}

function replyJson(status: number, body: unknown) {
  reply(status, JSON.stringify(body), "application/json");
}

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

function rest(
  argv: string[],
  env: Record<string, string | undefined> = {
    COMPANION_URL: baseUrl,
    COMPANION_API_KEY: KEY,
  },
  cwd = tempDir(),
  homedir = tempDir(),
): Promise<CliRun> {
  return runCli(argv, { env, cwd, homedir });
}

/** Writes `text` to the user config file under `home` (or `configHome`). */
function writeUserConfig(text: string, home: string, configHome?: string) {
  const dir = join(configHome ?? join(home, ".config"), "companion-cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env.local"), text);
}

function assertNoKey(result: CliRun) {
  for (const line of [...result.stdout, ...result.stderr]) {
    assert.ok(!line.includes(KEY), `key leaked: ${line}`);
  }
}

/** Exit 1, exactly one `error: ` line on stderr matching `pattern`, no key. */
function assertFailure(result: CliRun, pattern: RegExp) {
  assert.equal(result.code, 1, result.stderr.join("\n"));
  assert.equal(result.stderr.length, 1, result.stderr.join("\n"));
  assert.match(result.stderr[0] ?? "", /^error: /);
  assert.doesNotMatch(result.stderr[0] ?? "", /unexpected error/);
  assert.match(result.stderr[0] ?? "", pattern);
  assertNoKey(result);
}

function only(): Recorded {
  assert.equal(requests.length, 1);
  return requests[0] as Recorded;
}

describe("location commands", () => {
  for (const action of ["press", "down", "up", "rotate-left", "rotate-right"]) {
    it(`${action} posts to the location's ${action} endpoint`, async () => {
      const result = await rest([action, "2", "1", "3"]);
      assert.equal(result.code, 0, result.stderr.join("\n"));
      assert.deepEqual(result.stdout, []);
      assert.deepEqual(result.stderr, []);
      const request = only();
      assert.equal(request.method, "POST");
      assert.equal(request.url, `/api/location/2/1/3/${action}`);
      assert.equal(request.headers.authorization, `Bearer ${KEY}`);
      assert.equal(request.body, "");
    });
  }

  it("accepts negative rows and columns as positionals", async () => {
    const result = await rest(["press", "1", "-1", "-2"]);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(only().url, "/api/location/1/-1/-2/press");
  });

  it("keeps a path prefix from COMPANION_URL", async () => {
    const result = await rest(["press", "1", "0", "0"], {
      COMPANION_URL: `${baseUrl}/companion/`,
      COMPANION_API_KEY: KEY,
    });
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(only().url, "/companion/api/location/1/0/0/press");
  });

  it("exits 2 on bad location arguments without a request", async () => {
    for (const argv of [
      ["press"],
      ["press", "1", "2"],
      ["press", "1", "2", "3", "4"],
      ["press", "1", "x", "3"],
      ["press", "1.5", "2", "3"],
      ["press", "1", "2", ""],
      ["rotate-left", "1", "2", "0x3"],
      ["press", "1", "2", "3", "--nope"],
      ["down", "-x", "1", "2", "3"],
    ]) {
      const result = await rest(argv);
      assert.equal(result.code, 2, argv.join(" "));
      assert.equal(result.stderr.length, 1, argv.join(" "));
      assert.match(result.stderr[0] ?? "", /^error: .*usage: companion-cli/);
    }
    assert.equal(requests.length, 0);
  });

  it("reports a 204 as no control at the location", async () => {
    reply(204);
    assertFailure(
      await rest(["press", "3", "-1", "4"]),
      /no control at page 3, row -1, column 4/,
    );
  });

  it("reports an HTTP API 403 as the HTTP API being disabled", async () => {
    reply(403);
    assertFailure(await rest(["up", "1", "0", "0"]), /HTTP API is disabled/);
  });

  it("reports any other status with the status", async () => {
    reply(500, "boom");
    assertFailure(await rest(["press", "1", "0", "0"]), /500/);
    reply(201);
    assertFailure(await rest(["press", "1", "0", "0"]), /201/);
  });
});

describe("variable commands", () => {
  it("get prints the plain-text body verbatim", async () => {
    reply(200, "hello world");
    const result = await rest(["variable", "get", "fx_label"]);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(result.stdout, ["hello world"]);
    assert.deepEqual(result.stderr, []);
    const request = only();
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/api/custom-variable/fx_label/value");
    assert.equal(request.headers.authorization, `Bearer ${KEY}`);
  });

  it("get prints an empty value as an empty line", async () => {
    reply(200, "");
    const result = await rest(["variable", "get", "empty"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, [""]);
  });

  it("percent-encodes the variable name", async () => {
    await rest(["variable", "get", "a b/c?d"]);
    assert.equal(only().url, "/api/custom-variable/a%20b%2Fc%3Fd/value");
  });

  const typed: Array<[string[], string]> = [
    [["0"], "0"],
    [["-5"], "-5"],
    [["1.5"], "1.5"],
    [["true"], "true"],
    [["false"], "false"],
    [["abc"], '"abc"'],
    [["null"], '"null"'],
    [["[1]"], '"[1]"'],
    [['{"a":1}'], '"{\\"a\\":1}"'],
    [['"q"'], '"\\"q\\""'],
    [[""], '""'],
    [["--string", "0"], '"0"'],
    [["--string", "true"], '"true"'],
  ];
  for (const [args, body] of typed) {
    it(`set ${JSON.stringify(args)} sends ${body} as JSON`, async () => {
      const value = args.at(-1) as string;
      const argv = ["variable", "set", ...args.slice(0, -1), "v_1", value];
      const result = await rest(argv);
      assert.equal(result.code, 0, result.stderr.join("\n"));
      assert.deepEqual(result.stdout, []);
      assert.deepEqual(result.stderr, []);
      const request = only();
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/api/custom-variable/v_1/value");
      assert.equal(request.headers["content-type"], "application/json");
      assert.equal(request.headers.authorization, `Bearer ${KEY}`);
      assert.equal(request.body, body);
    });
  }

  it("set accepts --string after the positionals", async () => {
    const result = await rest(["variable", "set", "v_1", "7", "--string"]);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(only().body, '"7"');
  });

  it("set percent-encodes the name and never uses the query string", async () => {
    await rest(["variable", "set", "x y", "1"]);
    assert.equal(only().url, "/api/custom-variable/x%20y/value");
  });

  it("reports 404 as an unknown custom variable", async () => {
    reply(404, "Not found");
    assertFailure(
      await rest(["variable", "get", "nope"]),
      /custom variable "nope" does not exist/,
    );
    reply(404, "Not found");
    assertFailure(
      await rest(["variable", "set", "nope", "1"]),
      /custom variable "nope" does not exist/,
    );
  });

  it("reports 400 with Companion's reason", async () => {
    reply(400, "No value");
    assertFailure(await rest(["variable", "set", "v", "1"]), /400.*No value/);
  });

  it("reports an HTTP API 403 as the HTTP API being disabled", async () => {
    reply(403);
    assertFailure(await rest(["variable", "get", "v"]), /HTTP API is disabled/);
  });

  it("exits 2 on bad variable arguments", async () => {
    for (const argv of [
      ["variable"],
      ["variable", "frob"],
      ["variable", "get"],
      ["variable", "get", "a", "b"],
      ["variable", "set", "a"],
      ["variable", "set", "a", "b", "c"],
      ["variable", "get", "--string", "a"],
      ["variable", "set", "--nope", "a", "b"],
    ]) {
      const result = await rest(argv);
      assert.equal(result.code, 2, argv.join(" "));
      assert.equal(result.stderr.length, 1, argv.join(" "));
    }
    assert.equal(requests.length, 0);
  });
});

const SURFACES = [
  {
    id: "streamdeck:AB12",
    isConnected: true,
    size: { rows: 3, columns: 5 },
    page: { number: 2, name: "Lights" },
  },
  { id: "satellite-x", isConnected: false, size: null, page: null },
  {
    id: "emu",
    isConnected: true,
    size: { rows: 4, columns: 8 },
    page: { number: null, name: null },
  },
];

describe("surface commands", () => {
  it("list prints one line per surface, with - for nulls", async () => {
    replyJson(200, { data: SURFACES });
    const result = await rest(["surface", "list"]);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(result.stdout, [
      'streamdeck:AB12 connected 3x5 page 2 "Lights"',
      "satellite-x disconnected - -",
      "emu connected 4x8 page - -",
    ]);
    const request = only();
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/api/v2/surfaces/v1");
    assert.equal(request.headers.authorization, `Bearer ${KEY}`);
  });

  it("list prints nothing for no surfaces", async () => {
    replyJson(200, { data: [] });
    const result = await rest(["surface", "list"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, []);
  });

  it("get prints one line and percent-encodes the id", async () => {
    replyJson(200, { data: SURFACES[0] });
    const result = await rest(["surface", "get", "streamdeck:AB 12"]);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(result.stdout, [
      'streamdeck:AB12 connected 3x5 page 2 "Lights"',
    ]);
    assert.equal(only().url, "/api/v2/surfaces/v1/streamdeck%3AAB%2012");
    assert.equal(only().headers.authorization, `Bearer ${KEY}`);
  });

  it("reports v2 errors with status, code and message", async () => {
    replyJson(404, { error: { code: "NOT_FOUND", message: "No surface" } });
    assertFailure(
      await rest(["surface", "get", "x"]),
      /404 NOT_FOUND: No surface/,
    );
  });

  it("explains a 403 API_DISABLED", async () => {
    replyJson(403, {
      error: { code: "API_DISABLED", message: "REST API is disabled" },
    });
    assertFailure(
      await rest(["surface", "list"]),
      /403 API_DISABLED.*enable the REST API in Companion's settings/,
    );
  });

  it("explains a 401 without printing the key", async () => {
    replyJson(401, { error: { code: "UNAUTHORIZED", message: KEY } });
    const result = await rest(["surface", "list"]);
    assertFailure(result, /401 UNAUTHORIZED.*COMPANION_API_KEY was rejected/);
  });

  it("reports malformed v2 bodies with the status", async () => {
    for (const [status, body] of [
      [200, "not json"],
      [200, '{"data": 1}'],
      [200, '{"data": [{"id": 1}]}'],
      [500, "oops"],
      [502, '{"error": "x"}'],
    ] as const) {
      reply(status, body, "application/json");
      assertFailure(
        await rest(["surface", "list"]),
        new RegExp(String(status)),
      );
    }
    reply(200, '{"data": []}', "application/json");
    assertFailure(await rest(["surface", "get", "x"]), /200/);
  });

  it("exits 2 on bad surface arguments", async () => {
    for (const argv of [
      ["surface"],
      ["surface", "frob"],
      ["surface", "list", "x"],
      ["surface", "get"],
      ["surface", "get", "a", "b"],
    ]) {
      const result = await rest(argv);
      assert.equal(result.code, 2, argv.join(" "));
      assert.equal(result.stderr.length, 1, argv.join(" "));
    }
    assert.equal(requests.length, 0);
  });
});

describe("configuration", () => {
  it("reads COMPANION_URL and COMPANION_API_KEY from .env.local", async () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, ".env.local"),
      `COMPANION_URL=${baseUrl}\nCOMPANION_API_KEY=${KEY}\n`,
    );
    const result = await rest(["press", "1", "0", "0"], {}, cwd);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(only().headers.authorization, `Bearer ${KEY}`);
  });

  it("lets the environment override the file", async () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, ".env.local"),
      `COMPANION_URL=http://127.0.0.1:1\nCOMPANION_API_KEY=file-key\n`,
    );
    const result = await rest(
      ["press", "1", "0", "0"],
      { COMPANION_URL: baseUrl, COMPANION_API_KEY: KEY },
      cwd,
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(only().headers.authorization, `Bearer ${KEY}`);
  });

  it("treats an empty environment value as set, overriding the file", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, ".env.local"), `COMPANION_API_KEY=${KEY}\n`);
    assertFailure(
      await rest(
        ["press", "1", "0", "0"],
        { COMPANION_URL: baseUrl, COMPANION_API_KEY: "" },
        cwd,
      ),
      /COMPANION_API_KEY is not set/,
    );
    assert.equal(requests.length, 0);
  });

  it("mixes file and environment values", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, ".env.local"), `COMPANION_API_KEY=${KEY}\n`);
    const result = await rest(
      ["press", "1", "0", "0"],
      { COMPANION_URL: baseUrl },
      cwd,
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(only().headers.authorization, `Bearer ${KEY}`);
  });

  it("requires both values for every command", async () => {
    for (const argv of [
      ["press", "1", "0", "0"],
      ["variable", "get", "v"],
      ["surface", "list"],
    ]) {
      assertFailure(
        await rest(argv, { COMPANION_URL: baseUrl }),
        /COMPANION_API_KEY is not set.*\.env\.local/,
      );
      assertFailure(
        await rest(argv, { COMPANION_URL: baseUrl, COMPANION_API_KEY: "" }),
        /COMPANION_API_KEY is not set.*\.env\.local/,
      );
      assertFailure(
        await rest(argv, { COMPANION_API_KEY: KEY }),
        /COMPANION_URL is not set.*\.env\.local/,
      );
    }
    assert.equal(requests.length, 0);
  });

  it("falls back to the user config file when the working directory has none", async () => {
    const home = tempDir();
    writeUserConfig(
      `COMPANION_URL=${baseUrl}\nCOMPANION_API_KEY=${KEY}\n`,
      home,
    );
    const result = await rest(["press", "1", "0", "0"], {}, tempDir(), home);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(only().headers.authorization, `Bearer ${KEY}`);
  });

  it("prefers .env.local in the working directory over the user config file, whole file", async () => {
    const home = tempDir();
    writeUserConfig(
      `COMPANION_URL=${baseUrl}\nCOMPANION_API_KEY=user-key\n`,
      home,
    );
    const cwd = tempDir();
    writeFileSync(join(cwd, ".env.local"), `COMPANION_API_KEY=${KEY}\n`);
    const used = await rest(
      ["press", "1", "0", "0"],
      { COMPANION_URL: baseUrl },
      cwd,
      home,
    );
    assert.equal(used.code, 0, used.stderr.join("\n"));
    assert.equal(only().headers.authorization, `Bearer ${KEY}`);
    // The user file's URL is not merged in when the working directory has a file.
    assertFailure(
      await rest(["press", "1", "0", "0"], {}, cwd, home),
      /COMPANION_URL is not set/,
    );
  });

  it("uses $XDG_CONFIG_HOME for the user config file when set", async () => {
    const home = tempDir();
    const configHome = tempDir();
    writeUserConfig(`COMPANION_API_KEY=home-key\n`, home);
    writeUserConfig(`COMPANION_API_KEY=${KEY}\n`, home, configHome);
    const result = await rest(
      ["press", "1", "0", "0"],
      { COMPANION_URL: baseUrl, XDG_CONFIG_HOME: configHome },
      tempDir(),
      home,
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(only().headers.authorization, `Bearer ${KEY}`);
  });

  it("ignores an empty $XDG_CONFIG_HOME", async () => {
    const home = tempDir();
    writeUserConfig(`COMPANION_API_KEY=${KEY}\n`, home);
    const result = await rest(
      ["press", "1", "0", "0"],
      { COMPANION_URL: baseUrl, XDG_CONFIG_HOME: "" },
      tempDir(),
      home,
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(only().headers.authorization, `Bearer ${KEY}`);
  });

  it("lets the environment override the user config file", async () => {
    const home = tempDir();
    writeUserConfig(
      `COMPANION_URL=http://127.0.0.1:1\nCOMPANION_API_KEY=file-key\n`,
      home,
    );
    const result = await rest(
      ["press", "1", "0", "0"],
      { COMPANION_URL: baseUrl, COMPANION_API_KEY: KEY },
      tempDir(),
      home,
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(only().headers.authorization, `Bearer ${KEY}`);
  });

  it("redacts a key read from the user config file", async () => {
    const home = tempDir();
    writeUserConfig(
      `COMPANION_URL=${baseUrl}\nCOMPANION_API_KEY="${KEY}\\nx"\n`,
      home,
    );
    const result = await rest(["press", "1", "0", "0"], {}, tempDir(), home);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.length, 1);
    assert.doesNotMatch(result.stderr[0] ?? "", /unexpected error/);
    assertNoKey(result);
  });

  it("names both files when a value is set in neither", async () => {
    const home = tempDir();
    const result = await rest(
      ["press", "1", "0", "0"],
      { COMPANION_URL: baseUrl },
      tempDir(),
      home,
    );
    assertFailure(
      result,
      /COMPANION_API_KEY is not set: set it in \.env\.local, .+ or the environment/,
    );
    assert.ok(
      (result.stderr[0] ?? "").includes(
        join(home, ".config", "companion-cli", ".env.local"),
      ),
      result.stderr[0],
    );
  });

  it("names the file that cannot be read", async () => {
    const home = tempDir();
    mkdirSync(join(home, ".config", "companion-cli", ".env.local"), {
      recursive: true,
    });
    const result = await rest(["press", "1", "0", "0"], {}, tempDir(), home);
    assertFailure(result, /cannot read .*companion-cli\/\.env\.local/);
  });

  it("refuses a non-http URL", async () => {
    for (const url of ["ftp://127.0.0.1:8000", "not a url"]) {
      assertFailure(
        await rest(["surface", "list"], {
          COMPANION_URL: url,
          COMPANION_API_KEY: KEY,
        }),
        /COMPANION_URL/,
      );
    }
  });

  it("refuses a non-loopback host before any request", async () => {
    for (const url of [
      "http://192.168.1.10:8000",
      "http://example.com",
      "http://127.0.0.2:8000",
    ]) {
      const result = await rest(["press", "1", "0", "0"], {
        COMPANION_URL: url,
        COMPANION_API_KEY: KEY,
      });
      assertFailure(result, /only a local Companion is allowed/);
      assert.match(
        result.stderr[0] ?? "",
        new RegExp(new URL(url).hostname.replaceAll(".", "\\.")),
      );
    }
    assert.equal(requests.length, 0);
  });

  it("allows localhost, 127.0.0.1 and [::1] and attempts the request", async () => {
    const port = await closedPort();
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const result = await rest(["surface", "list"], {
        COMPANION_URL: `http://${host}:${port}`,
        COMPANION_API_KEY: KEY,
      });
      assertFailure(result, /not reachable/);
      assert.match(result.stderr[0] ?? "", new RegExp(`:${port}`));
    }
  });

  it("reports connection refused naming the origin", async () => {
    const port = await closedPort();
    assertFailure(
      await rest(["press", "1", "0", "0"], {
        COMPANION_URL: `http://127.0.0.1:${port}/prefix`,
        COMPANION_API_KEY: KEY,
      }),
      new RegExp(
        `Companion is not reachable at http://127\\.0\\.0\\.1:${port}`,
      ),
    );
  });

  it("does not print a key that is not a valid header value", async () => {
    const result = await rest(["press", "1", "0", "0"], {
      COMPANION_URL: baseUrl,
      COMPANION_API_KEY: `${KEY}\nx`,
    });
    assert.equal(result.code, 1);
    assert.equal(result.stderr.length, 1);
    assert.doesNotMatch(result.stderr[0] ?? "", /unexpected error/);
    assertNoKey(result);
  });
});

describe("hardening", () => {
  it("refuses . and .. as a variable name or surface id before any request", async () => {
    for (const segment of [".", ".."]) {
      for (const argv of [
        ["variable", "get", segment],
        ["variable", "set", segment, "1"],
        ["surface", "get", segment],
      ]) {
        const result = await rest(argv);
        assert.equal(result.code, 2, argv.join(" "));
        assert.equal(result.stderr.length, 1);
        assert.match(result.stderr[0] ?? "", /must not be "\.{1,2}"/);
      }
    }
    assert.equal(requests.length, 0);
  });

  it("keeps dots inside a name in the path", async () => {
    await rest(["variable", "get", "a.b"]);
    assert.equal(only().url, "/api/custom-variable/a.b/value");
  });

  it("refuses to follow a redirect", async () => {
    responder = (_request, response) => {
      response.writeHead(302, { Location: "http://192.168.1.10:8000/x" });
      response.end();
    };
    assertFailure(await rest(["press", "1", "0", "0"]), /redirect/);
    assert.equal(requests.length, 1);
  });

  it("refuses location parts that are not safe integers", async () => {
    for (const [argv, field] of [
      [["press", "1", "0", "1000000000000000000000"], "column"],
      [["press", "1", "-9007199254740993", "0"], "row"],
      [["press", "99999999999999999999", "0", "0"], "page"],
    ] as const) {
      const result = await rest([...argv]);
      assert.equal(result.code, 2, argv.join(" "));
      assert.match(result.stderr[0] ?? "", new RegExp(`^error: ${field} `));
    }
    assert.equal(requests.length, 0);
  });
});

describe("help and usage", () => {
  it("lists every command in --help and in the usage line", async () => {
    const help = await rest(["--help"]);
    assert.equal(help.code, 0);
    const text = help.stdout.join("\n");
    const usage = (await rest(["frobnicate"])).stderr[0] ?? "";
    for (const command of [
      "apply",
      "press",
      "down",
      "up",
      "rotate-left",
      "rotate-right",
      "variable get",
      "variable set [--string]",
      "surface list",
      "surface get",
    ]) {
      assert.ok(text.includes(command), `--help lacks ${command}`);
      assert.ok(usage.includes(command), `usage lacks ${command}`);
    }
  });

  it("prints help for a REST command", async () => {
    const result = await rest(["press", "--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout.join("\n"), /press/);
    assert.equal(requests.length, 0);
  });
});
