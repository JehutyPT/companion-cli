/**
 * `companion-cli schema --connection <label>` (#22): one connection's live
 * module action and feedback definitions, read over Companion's tRPC
 * WebSocket. Every test runs against an in-process fake server and a
 * temporary BUILD file; none reaches a real Companion or reads /Applications.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { type CliRun, runCli, tempDir } from "./helpers.ts";
import { type FakeTrpc, startFakeTrpc } from "./fake-trpc.ts";

type Json = Record<string, unknown>;

const BUILD = "5.1.0+9981-stable-257b325d09";
const MIXER = "mixer-conn-id-1";
const CONFIG_SECRET = "cfg-pass-Zq81xK";
const SECRET = "secret-token-Wm4pL7";

const DEFINITIONS = JSON.parse(
  readFileSync(
    new URL("./fixtures/module-definitions.json", import.meta.url),
    "utf8",
  ),
) as { actions: Json; feedbacks: Json };

function connection(id: string, label: string, extra: Json = {}): Json {
  return {
    id,
    moduleType: "connection",
    moduleId: "vb-voicemeeter",
    moduleVersionId: "2.1.0",
    updatePolicy: "stable",
    label,
    enabled: true,
    sortOrder: 0,
    collectionId: null,
    hasRecordActionsHandler: false,
    // Not in Companion's payload: planted to prove nothing leaks.
    config: { host: "10.0.0.9", password: CONFIG_SECRET },
    secrets: { token: SECRET },
    ...extra,
  };
}

let fake: FakeTrpc;

before(async () => {
  fake = await startFakeTrpc();
});

after(() => fake.stop());

beforeEach(() => {
  fake.reset();
  fake.state.connections = {
    [MIXER]: connection(MIXER, "mixer"),
    "cam-1": connection("cam-1", "camera", { moduleId: "sony-visca" }),
  };
  fake.state.actions = DEFINITIONS.actions;
  fake.state.feedbacks = DEFINITIONS.feedbacks;
});

/** A temporary BUILD file holding `content`; `null` leaves it missing. */
function buildFile(content: string | null = `${BUILD}\n`): string {
  const path = join(tempDir(), "BUILD");
  if (content !== null) writeFileSync(path, content);
  return path;
}

interface Run {
  url?: string;
  build?: string | null;
  timeoutMs?: number;
}

function schemaConnection(args: string[], run: Run = {}): Promise<CliRun> {
  return runCli(["schema", ...args], {
    env: { COMPANION_URL: run.url ?? fake.url },
    companionBuildFile: buildFile(run.build),
    socketTimeoutMs: run.timeoutMs ?? 2000,
  });
}

function parseJson(result: CliRun): Json {
  return JSON.parse(result.stdout.join("\n")) as Json;
}

function assertNoSecrets(result: CliRun): void {
  const output = [...result.stdout, ...result.stderr].join("\n");
  assert.doesNotMatch(output, new RegExp(CONFIG_SECRET));
  assert.doesNotMatch(output, new RegExp(SECRET));
  assert.doesNotMatch(output, /10\.0\.0\.9/);
}

/** The socket rules: subscribe and stop only, each subscription stopped, closed. */
function assertSocketDiscipline(expectedPaths: string[]): void {
  assert.equal(fake.upgrades.length, 1);
  assert.equal(fake.upgrades[0]?.["origin"], undefined);
  assert.equal(fake.upgrades[0]?.["cookie"], undefined);
  for (const message of fake.messages) {
    assert.ok(
      message["method"] === "subscription" ||
        message["method"] === "subscription.stop",
      `unexpected method ${String(message["method"])}`,
    );
  }
  const subscribed = fake.messages.filter(
    (message) => message["method"] === "subscription",
  );
  assert.deepEqual(
    subscribed.map((message) => (message["params"] as Json)["path"]).sort(),
    [...expectedPaths].sort(),
  );
  const stopped = new Set(
    fake.messages
      .filter((message) => message["method"] === "subscription.stop")
      .map((message) => message["id"]),
  );
  for (const message of subscribed) {
    assert.ok(stopped.has(message["id"]), `subscription not stopped`);
  }
  assert.equal(fake.closes, 1, "socket not closed by the client");
}

const ALL_PATHS = [
  "instances.connections.watch",
  "instances.definitions.actions",
  "instances.definitions.feedbacks",
];

describe("schema --connection", () => {
  it("prints a module connection's actions and feedbacks as text", async () => {
    const result = await schemaConnection(["--connection", "mixer"]);
    assert.deepEqual(result.stderr, []);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, [
      `connection "mixer" (vb-voicemeeter 2.1.0, id ${MIXER})`,
      "actions (3):",
      '  busMute       "Bus - Mute"  options: bus dropdown=A1 [A1,A2,A3,A4,A5,…], type dropdown=Toggle [Toggle,Mute,Unmute]',
      '  recorderGain  "Recorder - Gain"  options: value number=0 (-60..12)',
      '  stripGain     "Strip - Gain"  options: strip dropdown=1 [Selected], adjustment dropdown=Set [Set,Increase,Decrease], fade number=0 (0..60000), value number=0 (-60..12)',
      "feedbacks (2):",
      '  busEQ      boolean "Bus - EQ"  options: bus dropdown=A1 [A1,A2,A3,A4,A5,…]',
      '  busMeters  advanced "Bus - Meters"  options: bus dropdown=A1 [A1,A2,A3,A4,A5,…]',
      `use: {action: passthrough, connection: ${MIXER}, definition: <id>, options: {…}}`,
      `use: {feedback: passthrough, connection: ${MIXER}, definition: <id>, options: {…}}`,
    ]);
    assertNoSecrets(result);
    assertSocketDiscipline(ALL_PATHS);
  });

  it("prints the allow-listed definitions as JSON", async () => {
    const result = await schemaConnection(["--connection", "mixer", "--json"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stderr, []);
    const document = parseJson(result);
    assert.deepEqual(document["connection"], {
      id: MIXER,
      label: "mixer",
      moduleId: "vb-voicemeeter",
      moduleVersionId: "2.1.0",
    });
    assert.equal(document["build"], BUILD);
    const actions = document["actions"] as Json[];
    assert.deepEqual(
      actions.map((action) => action["id"]),
      ["busMute", "recorderGain", "stripGain"],
    );
    assert.deepEqual(actions[1], {
      id: "recorderGain",
      label: "Recorder - Gain",
      description: "Set Recorder Gain",
      options: [
        {
          id: "value",
          type: "number",
          label: "Volume",
          default: 0,
          min: -60,
          max: 12,
        },
      ],
    });
    const busMute = (actions[0]?.["options"] as Json[])[0] as Json;
    assert.deepEqual(Object.keys(busMute).sort(), [
      "choices",
      "default",
      "id",
      "label",
      "type",
    ]);
    assert.deepEqual((busMute["choices"] as Json[])[0], {
      id: "A1",
      label: "A1",
    });
    const feedbacks = document["feedbacks"] as Json[];
    assert.deepEqual(
      feedbacks.map((feedback) => [feedback["id"], feedback["feedbackType"]]),
      [
        ["busEQ", "boolean"],
        ["busMeters", "advanced"],
      ],
    );
    assertNoSecrets(result);
    assertSocketDiscipline(ALL_PATHS);
  });

  it("lists Companion's built-in entities for internal", async () => {
    const result = await schemaConnection(["--connection", "internal"]);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(result.stdout, [
      'connection "internal" (built-in, id internal)',
      "actions (2):",
      '  custom_log  "Write to companion log"  options: message textinput',
      '  wait        "Wait"  options: time expression=1000',
      "feedbacks (1):",
      '  trigger_enabled  boolean "Trigger: When enabled or disabled"  options: trigger_id internal:trigger, enable dropdown=true [true,false]',
      "use: {action: passthrough, connection: internal, definition: <id>, options: {…}}",
      "use: {feedback: passthrough, connection: internal, definition: <id>, options: {…}}",
    ]);
  });

  it("gives internal's JSON with null module fields", async () => {
    const result = await schemaConnection([
      "--json",
      "--connection",
      "internal",
    ]);
    assert.equal(result.code, 0);
    const document = parseJson(result);
    assert.deepEqual(document["connection"], {
      id: "internal",
      label: "internal",
      moduleId: null,
      moduleVersionId: null,
    });
    assert.equal((document["feedbacks"] as Json[]).length, 1);
  });

  it("accepts --connection before the schema word", async () => {
    const result = await runCli(["--connection", "mixer", "schema"], {
      env: { COMPANION_URL: fake.url },
      companionBuildFile: buildFile(),
    });
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.match(result.stdout[0] ?? "", /^connection "mixer"/);
  });

  it("shows a connection without definitions as empty lists", async () => {
    const result = await schemaConnection(["--connection", "camera"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout.slice(0, 3), [
      'connection "camera" (sony-visca 2.1.0, id cam-1)',
      "actions (0):",
      "feedbacks (0):",
    ]);
  });

  it("needs no COMPANION_API_KEY", async () => {
    const result = await schemaConnection(["--connection", "mixer"]);
    assert.equal(result.code, 0);
  });
});

describe("schema --connection refusals", () => {
  it("refuses an unknown label", async () => {
    const result = await schemaConnection(["--connection", "nope", "--json"]);
    assert.equal(result.code, 1);
    const error = parseJson(result)["error"] as Json;
    assert.equal(error["code"], "not_found");
    assert.match(String(error["message"]), /"nope"/);
    assert.equal(error["hint"], "run companion-cli list connections");
    assertSocketDiscipline(["instances.connections.watch"]);
  });

  it("does not resolve a surface instance's label", async () => {
    fake.state.connections["surf-1"] = connection("surf-1", "deck", {
      moduleType: "surface",
    });
    const result = await schemaConnection(["--connection", "deck"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr.join("\n"), /no connection labelled "deck"/);
  });

  it("refuses a label several connections share, naming their ids", async () => {
    fake.state.connections["mixer-2"] = connection("mixer-2", "mixer");
    const result = await schemaConnection(["--connection", "mixer", "--json"]);
    assert.equal(result.code, 1);
    const error = parseJson(result)["error"] as Json;
    assert.equal(error["code"], "check_failed");
    assert.match(
      String(error["message"]),
      /2 connections labelled "mixer" \(mixer-2, mixer-conn-id-1\); refusing to choose one/,
    );
    assertSocketDiscipline(["instances.connections.watch"]);
  });

  it("fails clearly when Companion is not running", async () => {
    const port = await closedPort();
    const result = await schemaConnection(["--connection", "mixer", "--json"], {
      url: `http://127.0.0.1:${port}`,
    });
    assert.equal(result.code, 1);
    const error = parseJson(result)["error"] as Json;
    assert.equal(error["code"], "companion_not_running");
    assert.equal(error["hint"], "start Companion, or check COMPANION_URL");
  });

  it("refuses another Companion build without connecting", async () => {
    const result = await schemaConnection(["--connection", "mixer", "--json"], {
      build: "5.1.1+10000-stable-abcdef\n",
    });
    assert.equal(result.code, 1);
    const error = parseJson(result)["error"] as Json;
    assert.equal(error["code"], "unsupported_companion_build");
    assert.match(String(error["message"]), /5\.1\.1\+10000-stable-abcdef/);
    assert.equal(fake.upgrades.length, 0);
  });

  it("refuses a missing BUILD file without connecting", async () => {
    const result = await schemaConnection(["--connection", "mixer", "--json"], {
      build: null,
    });
    assert.equal(result.code, 1);
    const error = parseJson(result)["error"] as Json;
    assert.equal(error["code"], "companion_build_unknown");
    assert.match(String(error["message"]), /BUILD/);
    assert.equal(
      error["hint"],
      "this command needs Companion 5.1 installed in /Applications",
    );
    assert.equal(fake.upgrades.length, 0);
  });

  it("refuses a non-loopback COMPANION_URL without connecting", async () => {
    const result = await schemaConnection(["--connection", "mixer"], {
      url: "http://192.168.1.20:8000",
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr.join("\n"), /is not local/);
    assert.equal(fake.upgrades.length, 0);
  });

  it("times out when Companion never sends init, and still cleans up", async () => {
    fake.state.silent.add("instances.definitions.feedbacks");
    const result = await schemaConnection(["--connection", "mixer", "--json"], {
      timeoutMs: 200,
    });
    assert.equal(result.code, 1);
    const error = parseJson(result)["error"] as Json;
    assert.equal(error["code"], "companion_timeout");
    assert.match(String(error["message"]), /instances\.definitions\.feedbacks/);
    assertSocketDiscipline(ALL_PATHS);
  });

  it("reports a tRPC error reply as another Companion", async () => {
    fake.state.failing.add("instances.definitions.actions");
    const result = await schemaConnection(["--connection", "mixer", "--json"]);
    assert.equal(result.code, 1);
    const error = parseJson(result)["error"] as Json;
    assert.equal(error["code"], "unsupported_companion_build");
    assert.match(String(error["message"]), /instances\.definitions\.actions/);
    assert.equal(fake.closes, 1);
  });
});

describe("schema --connection usage", () => {
  for (const [name, args] of [
    ["--db with --connection", ["--connection", "mixer", "--db", "x.sqlite"]],
    ["--db alone", ["--db", "x.sqlite"]],
    ["an empty label", ["--connection", ""]],
    ["a positional argument", ["--connection", "mixer", "extra"]],
  ] as const) {
    it(`refuses ${name} with exit 2 and no connection`, async () => {
      const result = await schemaConnection([...args]);
      assert.equal(result.code, 2);
      assert.equal(fake.upgrades.length, 0);
    });
  }

  it("prints help", async () => {
    const result = await schemaConnection(["--connection", "mixer", "--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout.join("\n"), /schema \[--connection <label>\]/);
    assert.equal(fake.upgrades.length, 0);
  });
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
