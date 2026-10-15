/**
 * `kind: connection`: one existing connection's label, enabled flag, config
 * and secrets. The fixture databases are temporary copies; the running
 * Companion is a fake local HTTP server, and no test contacts a real one.
 */
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { readConfigFields } from "../src/rest/commands.ts";
import type { ConfigField } from "../src/core/writer.ts";
import {
  compileFieldRegex,
  fieldValueProblem,
} from "../src/writers/connection.ts";
import { buildFixtureDb } from "./fixtures/companion-db.ts";
import {
  applyTo,
  type CliRun,
  dumpDatabase,
  type FixtureEnv,
  fileState,
  fakeProcessControl,
  forbiddenProcessControl,
  installDir,
  type Json,
  rows,
  runCli,
  setup,
  tempDir,
  writeDescription,
} from "./helpers.ts";
import { insert } from "./list-fixture.ts";

const CAM = "ConnCamAAAAAAAAAAAAAA";
const OTHER = "ConnOtherAAAAAAAAAAAA";
const TWIN_A = "ConnTwinAAAAAAAAAAAAA";
const TWIN_B = "ConnTwinBBBBBBBBBBBBB";
const SURFACE = "SurfaceInstanceAAAAAA";

/** Recognisable values that must never be printed. */
const OLD_SECRET = "OLD-SECRET-VALUE-7f3e";
const NEW_SECRET = "NEW-SECRET-VALUE-91ac";
const KEY = "stub-key-connection-5b1e";

function connection(label: string, extra: Json = {}): Json {
  return {
    moduleInstanceType: "connection",
    moduleId: `${label}-module`,
    moduleVersionId: "1.2.0",
    label,
    config: {},
    secrets: {},
    isFirstInit: false,
    lastUpgradeIndex: 0,
    enabled: true,
    sortOrder: 1,
    updatePolicy: "stable",
    ...extra,
  };
}

function seed(db: DatabaseSync): void {
  insert(
    db,
    "instances",
    CAM,
    connection("cam", {
      config: {
        host: "10.0.0.1",
        port: 9910,
        flag: true,
        nested: { list: [1, { deep: "x" }] },
      },
      secrets: { password: OLD_SECRET },
    }),
  );
  insert(db, "instances", OTHER, connection("other", { enabled: false }));
  insert(db, "instances", TWIN_A, connection("twin"));
  insert(db, "instances", TWIN_B, connection("twin"));
  insert(db, "instances", SURFACE, {
    ...connection("surf"),
    moduleInstanceType: "surface",
  });
}

function seeded(change?: (db: DatabaseSync) => void): FixtureEnv {
  return setup({}, (db) => {
    seed(db);
    change?.(db);
  });
}

function instance(env: FixtureEnv, id: string): Json {
  const row = rows(dumpDatabase(env.dbPath), "instances").get(id);
  assert.ok(row, id);
  return row;
}

/** Every line a run printed. */
const printed = (result: CliRun) => [...result.stdout, ...result.stderr];

function assertNoSecret(result: CliRun, ...values: string[]): void {
  for (const line of printed(result))
    for (const value of [OLD_SECRET, NEW_SECRET, KEY, ...values])
      assert.ok(!line.includes(value), `leaked ${value}: ${line}`);
}

function okRun(result: CliRun): void {
  assert.equal(result.code, 0, printed(result).join("\n"));
}

/** The JSON error document of a failed `--json` run. */
function errorOf(result: CliRun): Json {
  assert.equal(result.code, 1, printed(result).join("\n"));
  return (JSON.parse(result.stdout.at(-1) ?? "") as { error: Json }).error;
}

/** Applies with `--db`, unchanged rows checked: only the named row may change. */
async function applyOne(
  env: FixtureEnv,
  yaml: string,
  id: string,
  extra: string[] = [],
  envVars: Record<string, string> = {},
): Promise<CliRun> {
  const before = dumpDatabase(env.dbPath);
  const result = await applyTo(env, yaml, { env: envVars }, extra);
  const afterDump = dumpDatabase(env.dbPath);
  for (const [table, list] of Object.entries(afterDump)) {
    if (table === "instances") continue;
    assert.deepEqual(list, before[table], `${table} unchanged`);
  }
  const others = (dump: typeof before) =>
    (dump["instances"] ?? []).filter((row) => row.id !== id);
  assert.deepEqual(others(afterDump), others(before), "other rows unchanged");
  return result;
}

describe("kind: connection: apply --db", () => {
  it("merges config, sets enabled and isFirstInit, keeps every other key", async () => {
    const env = seeded((db) =>
      db
        .prepare(
          "UPDATE instances SET value = json_set(value, '$.isFirstInit', json('true')) WHERE id = ?",
        )
        .run(CAM),
    );
    const was = instance(env, CAM);
    const result = await applyOne(
      env,
      "kind: connection\nconnection: cam\nenabled: false\nconfig:\n  host: 10.0.0.9\n  nested: { list: [] }\n",
      CAM,
    );
    okRun(result);
    assertNoSecret(result);
    assert.match(
      result.stdout.at(-1) ?? "",
      /connection ConnCam\w+ \("cam"\) replaced: disabled, 2 config keys/,
    );
    assert.deepEqual(instance(env, CAM), {
      ...was,
      enabled: false,
      isFirstInit: false,
      config: {
        host: "10.0.0.9",
        port: 9910,
        flag: true,
        nested: { list: [] },
      },
    });
  });

  it("sets enabled alone, without touching config or isFirstInit", async () => {
    const env = seeded();
    const was = instance(env, OTHER);
    okRun(
      await applyOne(
        env,
        "kind: connection\nconnection: other\nenabled: true\n",
        OTHER,
      ),
    );
    assert.deepEqual(instance(env, OTHER), { ...was, enabled: true });
  });

  it("renames a connection nothing references", async () => {
    const env = seeded();
    const was = instance(env, OTHER);
    okRun(
      await applyOne(
        env,
        "kind: connection\nconnection: other\nlabel: other_2\n",
        OTHER,
      ),
    );
    assert.deepEqual(instance(env, OTHER), { ...was, label: "other_2" });
  });

  it("may take a surface instance's label: only connections count", async () => {
    const env = seeded();
    okRun(
      await applyOne(
        env,
        "kind: connection\nconnection: other\nlabel: surf\n",
        OTHER,
      ),
    );
    assert.equal(instance(env, OTHER)["label"], "surf");
  });

  it("selects by id:<id> when a label is shared", async () => {
    const env = seeded();
    okRun(
      await applyOne(
        env,
        `kind: connection\nconnection: id:${TWIN_B}\nlabel: twin_b\n`,
        TWIN_B,
      ),
    );
    assert.equal(instance(env, TWIN_B)["label"], "twin_b");
    assert.equal(instance(env, TWIN_A)["label"], "twin");
  });

  const references: Array<[string, Json]> = [
    [
      "button text",
      { type: "button-layered", style: { text: "In: $(other:input)" } },
    ],
    [
      "an expression",
      {
        type: "button-layered",
        style: {
          text: { value: "concat($(other:a), 'x')", isExpression: true },
        },
      },
    ],
    [
      "a trigger variableId",
      {
        type: "trigger",
        events: [
          { type: "variable_changed", options: { variableId: "other:tally" } },
        ],
      },
    ],
  ];
  for (const [name, control] of references) {
    it(`refuses a rename while ${name} references the old label`, async () => {
      const env = seeded((db) => {
        insert(db, "controls", "bank:RefAAAAAAAAAAAAAAAAAA", control);
        insert(db, "controls", "bank:RefBBBBBBBBBBBBBBBBBB", control);
      });
      const before = fileState(env.dbPath);
      const result = await applyTo(
        env,
        "kind: connection\nconnection: other\nlabel: renamed\n",
        {},
        ["--json"],
      );
      const error = errorOf(result);
      assert.equal(error["code"], "check_failed");
      assert.equal(error["path"], "label");
      assert.equal(
        error["message"],
        'label: cannot rename "other": 2 controls reference it (bank:RefAAAAAAAAAAAAAAAAAA, bank:RefBBBBBBBBBBBBBBBBBB), and only Companion\'s own rename rewrites references',
      );
      assert.equal(error["hint"], "companion-cli list connections other");
      assert.deepEqual(fileState(env.dbPath), before);
    });
  }

  it("does not count a label that merely starts the same", async () => {
    const env = seeded((db) =>
      insert(db, "controls", "bank:RefAAAAAAAAAAAAAAAAAA", {
        type: "button-layered",
        style: { text: "$(other_x:a) $(custom:other)" },
        options: { variableId: "otherwise:a" },
      }),
    );
    okRun(
      await applyOne(
        env,
        "kind: connection\nconnection: other\nlabel: renamed\n",
        OTHER,
      ),
    );
  });

  const invalid: Array<[string, string, string]> = [
    [
      "a label with a space",
      "label: 'has space'",
      "label: may hold only letters, digits, _ and -",
    ],
    [
      "a reserved label in any case",
      "label: Custom",
      'label: "Custom" is reserved by Companion',
    ],
    ["an empty label", "label: ''", "label: must not be empty"],
    ["no change", "", "set at least one of label, enabled, config or secrets"],
    ["an unknown field", "module: x", "module: unknown field"],
    [
      "a literal secret",
      "secrets: { password: hunter2-literal }",
      "secrets.password: a secret must be {env: NAME}, never a literal",
    ],
    [
      "a bad env name",
      "secrets: { password: { env: 1BAD } }",
      "secrets.password.env: must be an environment variable name",
    ],
  ];
  for (const [name, line, message] of invalid) {
    it(`refuses ${name} before reading the database`, async () => {
      const env = seeded();
      const result = await applyTo(
        env,
        `kind: connection\nconnection: cam\n${line}\n`,
        {},
        ["--json"],
      );
      const error = errorOf(result);
      assert.equal(error["code"], "invalid_description");
      assert.ok(
        String(error["message"]).includes(message),
        String(error["message"]),
      );
      assertNoSecret(result, "hunter2-literal");
    });
  }

  const refusals: Array<[string, string, string, string, string]> = [
    [
      "an unknown label",
      "connection: nope\nenabled: true",
      "not_found",
      "connection",
      'connection: no connection labelled "nope"',
    ],
    [
      "an unknown id",
      "connection: id:Nope\nenabled: true",
      "not_found",
      "connection",
      'connection: no connection with id "Nope"',
    ],
    [
      "a shared label",
      "connection: twin\nenabled: true",
      "not_found",
      "connection",
      `connection: 2 connections are labelled "twin" (${TWIN_A}, ${TWIN_B}); name one as id:<id>`,
    ],
    [
      "a surface instance",
      "connection: surf\nenabled: true",
      "not_found",
      "connection",
      'connection: no connection labelled "surf"',
    ],
    [
      "a surface instance by id",
      `connection: id:${SURFACE}\nenabled: true`,
      "not_found",
      "connection",
      `connection: no connection with id "${SURFACE}"`,
    ],
    [
      "a duplicate label",
      "connection: cam\nlabel: other",
      "check_failed",
      "label",
      `label: "other" is already the label of ${OTHER}`,
    ],
  ];
  for (const [name, body, code, path, message] of refusals) {
    it(`refuses ${name}`, async () => {
      const env = seeded();
      const before = fileState(env.dbPath);
      const error = errorOf(
        await applyTo(env, `kind: connection\n${body}\n`, {}, ["--json"]),
      );
      assert.deepEqual(
        [error["code"], error["path"], error["message"]],
        [code, path, message],
      );
      assert.deepEqual(fileState(env.dbPath), before);
    });
  }
});

describe("kind: connection: config without definitions (--db)", () => {
  it("accepts an existing key with a value of the same type", async () => {
    const env = seeded();
    okRun(
      await applyOne(
        env,
        "kind: connection\nconnection: cam\nconfig: { port: 1, flag: false }\n",
        CAM,
      ),
    );
    assert.deepEqual(instance(env, CAM)["config"], {
      host: "10.0.0.1",
      port: 1,
      flag: false,
      nested: { list: [1, { deep: "x" }] },
    });
  });

  const strict: Array<[string, string, string]> = [
    [
      "a new key",
      "config: { fresh: 1 }",
      'config.fresh: cannot be checked without the module\'s config fields (--db names a database the running Companion does not use), and the stored config has no key "fresh"',
    ],
    [
      "another type",
      "config: { port: '9910' }",
      "config.port: cannot be checked without the module's config fields (--db names a database the running Companion does not use), and the stored value is a number, not a string",
    ],
  ];
  for (const [name, body, message] of strict) {
    it(`refuses ${name}, and --unchecked accepts it with a warning`, async () => {
      const env = seeded();
      const yaml = `kind: connection\nconnection: cam\n${body}\n`;
      const error = errorOf(await applyTo(env, yaml, {}, ["--json"]));
      assert.deepEqual(
        [error["code"], error["message"], error["hint"]],
        [
          "check_failed",
          message,
          "start Companion and enable the connection so its config fields can be read, or pass --unchecked",
        ],
      );

      const key = message.slice(0, message.indexOf(":"));
      const warning = `warning: ${key}: not checked (--db names a database the running Companion does not use; ${message.slice(message.lastIndexOf(", and ") + 6)})`;
      const dry = await runCli(
        [
          "apply",
          writeDescription(env.dir, yaml),
          "--db",
          env.dbPath,
          "--dry-run",
          "--unchecked",
          "--json",
        ],
        { tmpdir: env.tmpdir },
      );
      okRun(dry);
      assert.deepEqual(dry.stderr, [warning]);
      assert.deepEqual(JSON.parse(dry.stdout.join("\n")).warnings, [warning]);

      const validated = await runCli(
        [
          "validate",
          writeDescription(env.dir, yaml),
          "--db",
          env.dbPath,
          "--unchecked",
          "--json",
        ],
        { tmpdir: env.tmpdir },
      );
      okRun(validated);
      assert.deepEqual(validated.stderr, [warning]);
      assert.deepEqual(JSON.parse(validated.stdout.join("\n")).warnings, [
        warning,
      ]);

      const applied = await applyOne(env, yaml, CAM, ["--unchecked", "--json"]);
      okRun(applied);
      assert.deepEqual(
        applied.stderr.filter((line) => line.startsWith("warning:")),
        [warning],
      );
      assert.deepEqual(JSON.parse(applied.stdout.at(-1) ?? "").warnings, [
        warning,
      ]);
    });
  }
});

describe("kind: connection: secrets", () => {
  const YAML =
    "kind: connection\nconnection: cam\nsecrets:\n  password: { env: CAM_PASSWORD }\n";

  it("writes a secret from the environment and never prints it", async () => {
    const env = seeded();
    const vars = { CAM_PASSWORD: NEW_SECRET };
    const file = writeDescription(env.dir, YAML);

    for (const extra of [[], ["--json"]]) {
      const dry = await runCli(
        ["apply", file, "--db", env.dbPath, "--dry-run", ...extra],
        {
          tmpdir: env.tmpdir,
          env: vars,
        },
      );
      okRun(dry);
      assertNoSecret(dry);
    }
    const dryJson = await runCli(
      ["apply", file, "--db", env.dbPath, "--dry-run", "--json"],
      {
        tmpdir: env.tmpdir,
        env: vars,
      },
    );
    const change = JSON.parse(dryJson.stdout.join("\n")).tables.instances
      .changed[0];
    assert.deepEqual(
      [change.before.secrets, change.after.secrets],
      [{ password: "<secret>" }, { password: "<secret>" }],
    );

    const validated = await runCli(
      ["validate", file, "--db", env.dbPath, "--json"],
      {
        tmpdir: env.tmpdir,
        env: vars,
      },
    );
    okRun(validated);
    assertNoSecret(validated);

    const applied = await applyOne(env, YAML, CAM, ["--json"], vars);
    okRun(applied);
    assertNoSecret(applied);
    assert.deepEqual(instance(env, CAM)["secrets"], { password: NEW_SECRET });
  });

  it("refuses a missing environment variable, naming it", async () => {
    const env = seeded();
    const error = errorOf(await applyTo(env, YAML, { env: {} }, ["--json"]));
    assert.deepEqual(
      [error["code"], error["path"], error["message"]],
      [
        "check_failed",
        "secrets.password",
        "secrets.password: environment variable CAM_PASSWORD is not set",
      ],
    );
  });

  it("never prints a secret in a refusal", async () => {
    const env = seeded();
    const result = await applyTo(
      env,
      "kind: connection\nconnection: cam\nsecrets:\n  token: { env: CAM_TOKEN }\n",
      { env: { CAM_TOKEN: NEW_SECRET } },
      ["--json"],
    );
    const error = errorOf(result);
    assert.equal(error["path"], "secrets.token");
    assertNoSecret(result);
  });

  it("masks secrets of added and removed instances rows in the dry-run diff", async () => {
    const { diffTables, readTables } =
      await import("../src/core/table-diff.ts");
    const env = seeded();
    const db = new DatabaseSync(env.dbPath);
    const beforeRows = readTables(db);
    db.prepare("DELETE FROM instances WHERE id = ?").run(CAM);
    insert(
      db,
      "instances",
      "ConnNewAAAAAAAAAAAAAA",
      connection("new", { secrets: { a: NEW_SECRET } }),
    );
    const afterRows = readTables(db);
    db.close();
    const text = JSON.stringify(diffTables(beforeRows, afterRows));
    assert.ok(!text.includes(OLD_SECRET) && !text.includes(NEW_SECRET), text);
  });
});

// The fake Companion: answers config-fields for CAM and records every path.

let server: Server;
let baseUrl: string;
let requests: string[] = [];
let respond: (request: IncomingMessage, response: ServerResponse) => void;

const FIELDS: ConfigField[] = [
  { id: "host", type: "textinput", label: "Host", regex: "/^[0-9.]+$/" },
  { id: "name", type: "textinput", label: "Name", minLength: 2 },
  { id: "port", type: "number", label: "Port", min: 1, max: 65535 },
  { id: "flag", type: "checkbox", label: "Flag" },
  {
    id: "mode",
    type: "dropdown",
    label: "Mode",
    choices: [
      { id: "a", label: "A" },
      { id: 2, label: "B" },
    ],
  },
  {
    id: "free",
    type: "dropdown",
    label: "Free",
    choices: [{ id: "a", label: "A" }],
    allowCustom: true,
    regex: "^x",
  },
  {
    id: "many",
    type: "multidropdown",
    label: "Many",
    choices: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    maxSelection: 1,
  },
  { id: "color", type: "colorpicker", label: "Color" },
  { id: "device", type: "bonjour-device", label: "Device" },
  { id: "info", type: "static-text", label: "Info" },
  { id: "password", type: "secret-text", label: "Password", minLength: 4 },
];

before(async () => {
  server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    respond(request, response);
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

const answer =
  (status: number, body: unknown) =>
  (_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };

beforeEach(() => {
  requests = [];
  respond = (request, response) => {
    if (
      request.url === `/api/v2/connections/v1/${CAM}/config-fields` &&
      request.headers.authorization === `Bearer ${KEY}`
    )
      answer(200, { data: FIELDS })(request, response);
    else answer(404, { error: "not found" })(request, response);
  };
});

/** `validate` in live-install mode: the install's database, the fake Companion. */
async function validateLive(
  yaml: string,
  extra: string[] = [],
  envVars: Record<string, string> = {},
): Promise<CliRun> {
  const home = tempDir();
  const dbPath = buildFixtureDb(installDir(home));
  const db = new DatabaseSync(dbPath);
  seed(db);
  db.close();
  const before = fileState(dbPath);
  const { control, calls } = forbiddenProcessControl();
  const result = await runCli(
    ["validate", writeDescription(tempDir(), yaml), "--json", ...extra],
    {
      homedir: home,
      processControl: control,
      env: { COMPANION_URL: baseUrl, COMPANION_API_KEY: KEY, ...envVars },
    },
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(fileState(dbPath), before);
  assertNoSecret(result);
  for (const request of requests)
    assert.match(
      request,
      /^GET \/api\/v2\/connections\/v1\/[^/]+\/config-fields$/,
    );
  return result;
}

const cam = (body: string) => `kind: connection\nconnection: cam\n${body}\n`;

describe("kind: connection: config checked against the running Companion", () => {
  const accepted = [
    "config: { host: 10.1.2.3, name: ab, port: 65535, flag: false }",
    "config: { mode: a, free: xyz, many: [b], color: 16711680, device: null }",
    "config: { mode: 2, free: a, color: 'rgba(0,0,0,1)', device: host.local }",
    "config: { host: '1.1' }",
    "secrets: { password: { env: CAM_PASSWORD } }",
  ];
  for (const body of accepted) {
    it(`accepts ${body}`, async () => {
      const result = await validateLive(cam(body), [], {
        CAM_PASSWORD: NEW_SECRET,
      });
      okRun(result);
      assert.deepEqual(result.stderr, []);
      assert.deepEqual(requests, [
        `GET /api/v2/connections/v1/${CAM}/config-fields`,
      ]);
    });
  }

  const refused: Array<[string, string, string]> = [
    [
      "config: { fresh: 1 }",
      "check_failed",
      "config.fresh: the module has no config field of this id",
    ],
    [
      "config: { host: abc }",
      "check_failed",
      'config.host: "abc" does not match the field\'s pattern /^[0-9.]+$/',
    ],
    [
      "config: { host: 1 }",
      "check_failed",
      "config.host: must be a string, got a number",
    ],
    [
      "config: { name: a }",
      "check_failed",
      "config.name: must be at least 2 characters",
    ],
    ["config: { port: 0 }", "check_failed", "config.port: must be at least 1"],
    [
      "config: { port: 70000 }",
      "check_failed",
      "config.port: must be at most 65535",
    ],
    [
      "config: { port: '80' }",
      "check_failed",
      "config.port: must be a number, got a string",
    ],
    [
      "config: { flag: 1 }",
      "check_failed",
      "config.flag: must be true or false, got a number",
    ],
    [
      "config: { mode: c }",
      "check_failed",
      'config.mode: "c" is not one of the choices: "a", 2',
    ],
    [
      "config: { free: yes }",
      "check_failed",
      'config.free: "yes" does not match the field\'s pattern ^x',
    ],
    [
      "config: { many: a }",
      "check_failed",
      "config.many: must be a list, got a string",
    ],
    [
      "config: { many: [a, c] }",
      "check_failed",
      'config.many: "c" is not one of the choices: "a", "b"',
    ],
    [
      "config: { many: [a, b] }",
      "check_failed",
      "config.many: must select at most 1",
    ],
    [
      "config: { color: true }",
      "check_failed",
      "config.color: must be a color number or string, got a boolean",
    ],
    [
      "config: { device: 1 }",
      "check_failed",
      "config.device: must be a string or null, got a number",
    ],
    [
      "config: { info: x }",
      "check_failed",
      "config.info: is static text, which holds no value",
    ],
    [
      "config: { password: x }",
      "invalid_description",
      "config.password: is a secret field, so it cannot be set under config",
    ],
    [
      "secrets: { host: { env: CAM_PASSWORD } }",
      "check_failed",
      "secrets.host: is not a secret field: set it under config",
    ],
    [
      "secrets: { password: { env: SHORT } }",
      "check_failed",
      "secrets.password: must be at least 4 characters",
    ],
  ];
  for (const [body, code, message] of refused) {
    it(`refuses ${body}`, async () => {
      const error = errorOf(
        await validateLive(cam(body), [], {
          CAM_PASSWORD: NEW_SECRET,
          SHORT: "ab",
        }),
      );
      assert.deepEqual([error["code"], error["message"]], [code, message]);
      assert.equal(error["path"], message.slice(0, message.indexOf(":")));
    });
  }

  it("never prints a secret that fails the field's pattern", async () => {
    respond = answer(200, {
      data: [
        { id: "password", type: "secret-text", label: "P", regex: "/^z/" },
      ],
    });
    const result = await validateLive(
      cam("secrets: { password: { env: P } }"),
      [],
      { P: NEW_SECRET },
    );
    assert.equal(
      errorOf(result)["message"],
      "secrets.password: does not match the field's pattern /^z/",
    );
  });

  const unavailable: Array<[string, number, unknown, string]> = [
    [
      "409 (not running)",
      409,
      { error: "Connection is not running" },
      "the connection is not running",
    ],
    ["403", 403, { error: "forbidden" }, "403"],
    ["a malformed answer", 200, { data: [{ id: 1 }] }, "unexpected"],
  ];
  for (const [name, status, body, reason] of unavailable) {
    it(`falls back to the strict rule on ${name}`, async () => {
      respond = answer(status, body);
      okRun(await validateLive(cam("config: { port: 1 }")));
      const error = errorOf(await validateLive(cam("config: { fresh: 1 }")));
      assert.equal(error["code"], "check_failed");
      assert.match(
        String(error["message"]),
        /^config\.fresh: cannot be checked without the module's config fields \(/,
      );
      assert.ok(
        String(error["message"]).toLowerCase().includes(reason.toLowerCase()),
        String(error["message"]),
      );
      const unchecked = await validateLive(cam("config: { fresh: 1 }"), [
        "--unchecked",
      ]);
      okRun(unchecked);
      assert.equal(unchecked.stderr.length, 1);
      assert.match(
        unchecked.stderr[0] ?? "",
        /^warning: config\.fresh: not checked \(/,
      );
    });
  }

  it("falls back when REST is not configured, without a request", async () => {
    const home = tempDir();
    const db = new DatabaseSync(buildFixtureDb(installDir(home)));
    seed(db);
    db.close();
    const error = errorOf(
      await runCli(
        [
          "validate",
          writeDescription(tempDir(), cam("config: { fresh: 1 }")),
          "--json",
        ],
        {
          homedir: home,
          processControl: forbiddenProcessControl().control,
        },
      ),
    );
    assert.match(
      String(error["message"]),
      /\(REST is not configured \(COMPANION_URL is not set/,
    );
    assert.deepEqual(requests, []);
  });

  it("checks during a live dry run too", async () => {
    const home = tempDir();
    const db = new DatabaseSync(buildFixtureDb(installDir(home)));
    seed(db);
    db.close();
    const result = await runCli(
      [
        "apply",
        writeDescription(tempDir(), cam("config: { port: 0 }")),
        "--dry-run",
        "--json",
      ],
      {
        homedir: home,
        processControl: forbiddenProcessControl().control,
        env: { COMPANION_URL: baseUrl, COMPANION_API_KEY: KEY },
      },
    );
    assert.equal(errorOf(result)["message"], "config.port: must be at least 1");
    assert.deepEqual(requests, [
      `GET /api/v2/connections/v1/${CAM}/config-fields`,
    ]);
  });

  it("does not fetch for a label or enabled change", async () => {
    okRun(await validateLive(cam("enabled: false")));
    assert.deepEqual(requests, []);
  });

  it("a live apply fetches the fields before it quits Companion, then writes", async () => {
    const home = tempDir();
    const dbPath = buildFixtureDb(installDir(home));
    const db = new DatabaseSync(dbPath);
    seed(db);
    db.close();
    const calls: string[] = [];
    const served = respond;
    respond = (request, response) => {
      calls.push("config-fields");
      served(request, response);
    };
    const fake = fakeProcessControl({ running: true, calls });
    const result = await runCli(
      [
        "apply",
        writeDescription(tempDir(), cam("config: { port: 80 }")),
        "--rest-timeout",
        "0",
      ],
      {
        homedir: home,
        processControl: fake.control,
        env: { COMPANION_URL: baseUrl, COMPANION_API_KEY: KEY },
      },
    );
    okRun(result);
    assertNoSecret(result);
    assert.ok(calls.indexOf("config-fields") >= 0, calls.join(","));
    assert.ok(
      calls.indexOf("config-fields") < calls.indexOf("quit"),
      calls.join(","),
    );
    assert.deepEqual(requests, [
      `GET /api/v2/connections/v1/${CAM}/config-fields`,
    ]);
    const row = rows(dumpDatabase(dbPath), "instances").get(CAM);
    assert.equal((row?.["config"] as Json)["port"], 80);
  });
});

describe("readConfigFields", () => {
  const endpoint = () => ({ base: baseUrl, origin: baseUrl, apiKey: KEY });

  it("reads the fields with the Bearer key, from config-fields only", async () => {
    assert.deepEqual(await readConfigFields(endpoint(), CAM, 2000), {
      available: true,
      fields: FIELDS,
    });
    assert.deepEqual(requests, [
      `GET /api/v2/connections/v1/${CAM}/config-fields`,
    ]);
  });

  it("never throws", async () => {
    respond = (_request, response) => response.destroy();
    const outcome = await readConfigFields(endpoint(), CAM, 2000);
    assert.equal(outcome.available, false);
  });
});

describe("connection field rules", () => {
  it("compiles /body/flags literals and plain patterns, and skips broken ones", () => {
    assert.equal(compileFieldRegex("/^A$/i")?.test("a"), true);
    assert.equal(compileFieldRegex("^a/b$")?.test("a/b"), true);
    assert.equal(compileFieldRegex("/(/"), undefined);
  });

  it("accepts a field type it does not know", () => {
    assert.equal(
      fieldValueProblem({ id: "x", type: "future-type" }, {}, false),
      undefined,
    );
  });
});
