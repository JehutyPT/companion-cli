/**
 * `kind: surface` (#32): one stored surface's settings. Without definitions
 * (`--db`, or Companion unreachable) only stored keys may change, keeping
 * their JSON type; with them (live-install mode, the surface connected),
 * each named key must be a declared config field of the right type. Every
 * live test reads definitions from the in-process fake tRPC server.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { buildFixtureDb } from "./fixtures/companion-db.ts";
import { type FakeTrpc, startFakeTrpc } from "./fake-trpc.ts";
import {
  applyTo,
  assertJsonTwin,
  assertRefusalCode,
  type CliRun,
  dumpDatabase,
  fakeProcessControl,
  installDir,
  type Json,
  rows,
  runCli,
  setup,
  tempDir,
  withoutTables,
  writeDescription,
} from "./helpers.ts";
import {
  SKAARHOJ,
  SKAARHOJ_ROW,
  seedSurfaces,
  STREAMDECK,
  STREAMDECK_ROW,
  watchedSurfaces,
} from "./surface-fixture.ts";

const BUILD = "5.1.0+9981-stable-257b325d09";

function seeded() {
  return setup({}, seedSurfaces);
}

function surfaceRow(dbPath: string, id: string): Json {
  return rows(dumpDatabase(dbPath), "surfaces").get(id) as Json;
}

/** Applies `yaml` twice with `--json`, as text and JSON twins of one refusal. */
async function refusal(yaml: string, extra: string[] = []) {
  const env = seeded();
  const before = dumpDatabase(env.dbPath);
  const text = await applyTo(env, yaml, {}, extra);
  const json = await applyTo(env, yaml, {}, [...extra, "--json"]);
  const doc = assertJsonTwin(text, json);
  // `not_found` is the one database refusal that is not check_failed.
  if (doc.code !== "not_found") assertRefusalCode(doc);
  assert.deepEqual(dumpDatabase(env.dbPath), before, "nothing written");
  return doc;
}

describe("apply surface: writes one surface row", () => {
  it("merges the named settings into the stored row and keeps everything else", async () => {
    const env = seeded();
    const before = dumpDatabase(env.dbPath);
    const result = await applyTo(
      env,
      `kind: surface
surface: "${STREAMDECK}"
name: Producer deck
enabled: false
brightness: 0
rotation: surface-90
xOffset: 2
yOffset: -1
config:
  canChangePage: false
`,
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(
      result.stdout.at(-1),
      `surface "${STREAMDECK}": set name, enabled, 5 config keys`,
    );
    const after = dumpDatabase(env.dbPath);
    assert.deepEqual(
      withoutTables(after, "surfaces"),
      withoutTables(before, "surfaces"),
    );
    assert.deepEqual(surfaceRow(env.dbPath, STREAMDECK), {
      ...STREAMDECK_ROW,
      name: "Producer deck",
      enabled: false,
      config: {
        ...STREAMDECK_ROW.config,
        brightness: 0,
        rotation: "surface-90",
        xOffset: 2,
        yOffset: -1,
        canChangePage: false,
      },
    });
    for (const id of [SKAARHOJ, "fixture-surface"]) {
      assert.equal(
        rows(after, "surfaces").get(id) !== undefined &&
          JSON.stringify(rows(after, "surfaces").get(id)),
        JSON.stringify(rows(before, "surfaces").get(id)),
        `${id} untouched`,
      );
    }
  });

  it("sets transfer inputs and outputs and plugin settings under their config keys", async () => {
    const env = seeded();
    const result = await applyTo(
      env,
      `kind: surface
surface: "${SKAARHOJ}"
transferInputs:
  hwc_12: fx_counter
  hwc_13: fx_gap
transferOutputs:
  hwc_40: "$(custom:fx_label) == 'live'"
plugin:
  sleepTimer: 300
`,
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(surfaceRow(env.dbPath, SKAARHOJ), {
      ...SKAARHOJ_ROW,
      config: {
        ...SKAARHOJ_ROW.config,
        transfer_input_hwc_12: "fx_counter",
        transfer_input_hwc_13: "fx_gap",
        transfer_output_hwc_40: "$(custom:fx_label) == 'live'",
        plugin_cfg_sleepTimer: 300,
      },
    });
  });

  it("clears a transfer input with an empty string", async () => {
    const env = seeded();
    const result = await applyTo(
      env,
      `kind: surface\nsurface: "${SKAARHOJ}"\ntransferInputs: { hwc_12: "" }\n`,
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(
      (surfaceRow(env.dbPath, SKAARHOJ)["config"] as Json)[
        "transfer_input_hwc_12"
      ],
      "",
    );
  });

  it("is idempotent: the same file again changes nothing", async () => {
    const env = seeded();
    const yaml = `kind: surface
surface: "${SKAARHOJ}"
name: Desk
transferInputs: { hwc_12: fx_counter }
`;
    assert.equal((await applyTo(env, yaml)).code, 0);
    const dry = await applyTo(env, yaml, {}, ["--dry-run", "--json"]);
    assert.equal(dry.code, 0, dry.stderr.join("\n"));
    const doc = JSON.parse(dry.stdout[0] ?? "") as Json;
    assert.equal(doc["changed"], false);
    assert.deepEqual(doc["warnings"], []);
  });

  it("a file naming only the surface writes nothing new", async () => {
    const env = seeded();
    const before = dumpDatabase(env.dbPath);
    const result = await applyTo(
      env,
      `kind: surface\nsurface: "${SKAARHOJ}"\n`,
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(result.stdout.at(-1), `surface "${SKAARHOJ}": nothing to set`);
    assert.deepEqual(dumpDatabase(env.dbPath), before);
  });

  it("validate describes the surface and what the file sets", async () => {
    const env = seeded();
    const file = writeDescription(
      env.dir,
      `kind: surface\nsurface: "${SKAARHOJ}"\nname: Desk\nbrightness: 10\n`,
    );
    const result = await runCli(["validate", file, "--db", env.dbPath], {
      tmpdir: env.tmpdir,
    });
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(result.stdout, [
      `valid: surface "${SKAARHOJ}" (name, 1 config key) against ${env.dbPath}`,
    ]);
  });
});

describe("apply surface: refusals before any write", () => {
  it("an unknown surface is not_found, with a hint to list surfaces", async () => {
    const doc = await refusal(`kind: surface\nsurface: nope\nname: X\n`);
    assert.equal(doc.code, "not_found");
    assert.equal(doc.path, "surface");
    assert.equal(doc.hint, "run companion-cli list surfaces");
  });

  it("an unknown custom variable in a transfer input", async () => {
    const doc = await refusal(
      `kind: surface\nsurface: "${SKAARHOJ}"\ntransferInputs: { hwc_12: nope }\n`,
    );
    assert.equal(doc.path, "transferInputs.hwc_12");
    assert.match(doc.message, /unknown custom variable "nope"/);
  });

  it("an unknown custom variable referenced by a transfer output", async () => {
    const doc = await refusal(
      `kind: surface\nsurface: "${SKAARHOJ}"\ntransferOutputs: { hwc_40: "$(custom:nope)" }\n`,
    );
    assert.equal(doc.path, "transferOutputs.hwc_40");
    assert.match(doc.message, /unknown custom variable "nope"/);
  });

  for (const [name, yaml, path, message] of [
    [
      "a raw config key with a named field",
      "config: { brightness: 3 }",
      "config.brightness",
      /use brightness instead of config\.brightness/,
    ],
    [
      "a raw transfer input key",
      "config: { transfer_input_a: fx_label }",
      "config.transfer_input_a",
      /use transferInputs\.a instead/,
    ],
    [
      "a raw transfer key",
      "config: { transfer_output_a: x }",
      "config.transfer_output_a",
      /use transferOutputs\.a instead/,
    ],
    [
      "a raw plugin key",
      "config: { plugin_cfg_a: 1 }",
      "config.plugin_cfg_a",
      /use plugin\.a instead/,
    ],
    [
      "config.groupId",
      "config: { groupId: g }",
      "config.groupId",
      /surface groups are not supported/,
    ],
    ["groupConfig", "groupConfig: {}", "groupConfig", /unknown field/],
    [
      "brightness above 100",
      "brightness: 101",
      "brightness",
      /from 0 to 100, got 101/,
    ],
    [
      "rotation 90",
      "rotation: 90",
      "rotation",
      /must be one of 0, "surface-90"/,
    ],
    ["a fractional offset", "yOffset: 0.5", "yOffset", /integer/],
  ] as const) {
    it(`${name} is invalid_description`, async () => {
      const doc = await refusal(
        `kind: surface\nsurface: "${SKAARHOJ}"\n${yaml}\n`,
      );
      assert.equal(doc.code, "invalid_description");
      assert.equal(doc.path, path);
      assert.match(doc.message, message);
    });
  }
});

describe("apply surface: without definitions", () => {
  it("refuses a key that is not stored yet, naming why and how to proceed", async () => {
    const doc = await refusal(
      `kind: surface\nsurface: "${SKAARHOJ}"\nplugin: { newSetting: 1 }\n`,
    );
    assert.equal(doc.code, "check_failed");
    assert.equal(doc.path, "plugin.newSetting");
    assert.match(
      doc.message,
      /cannot be checked without the surface's config fields \(--db names a database the running Companion does not use\), and the stored config has no key "plugin_cfg_newSetting"/,
    );
    assert.equal(
      doc.hint,
      "connect the surface and start Companion so its config fields can be read, or pass --unchecked",
    );
  });

  it("refuses a stored key whose value changes JSON type", async () => {
    const doc = await refusal(
      `kind: surface\nsurface: "${STREAMDECK}"\nconfig: { canChangePage: "yes" }\n`,
    );
    assert.equal(doc.path, "config.canChangePage");
    assert.match(doc.message, /the stored value is a boolean, not a string/);
  });

  it("Companion's own keys need no definitions, stored or not", async () => {
    const env = setup({}, (db) => {
      seedSurfaces(db);
    });
    const result = await applyTo(
      env,
      `kind: surface\nsurface: fixture-surface\nrotation: surface180\nxOffset: 3\n`,
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(surfaceRow(env.dbPath, "fixture-surface"), {
      config: { brightness: 100, rotation: "surface180", xOffset: 3 },
      groupConfig: {},
      name: "Fixture surface",
    });
  });

  it("--unchecked accepts them with one warning naming each field and the reason", async () => {
    const env = seeded();
    const yaml = `kind: surface
surface: "${SKAARHOJ}"
plugin: { newSetting: 1, sleepTimer: 5 }
config: { emulator_rows: 4 }
transferInputs: { hwc_12: fx_counter }
`;
    const reason = "--db names a database the running Companion does not use";
    const warnings = [
      `warning: plugin.newSetting: not checked (${reason}; the stored config has no key "plugin_cfg_newSetting")`,
      `warning: config.emulator_rows: not checked (${reason}; the stored config has no key "emulator_rows")`,
    ];
    const dry = await applyTo(env, yaml, {}, [
      "--dry-run",
      "--json",
      "--unchecked",
    ]);
    assert.equal(dry.code, 0, dry.stderr.join("\n"));
    assert.deepEqual(dry.stderr, warnings);
    assert.deepEqual(
      (JSON.parse(dry.stdout[0] ?? "") as Json)["warnings"],
      warnings,
    );

    const validate = await runCli(
      [
        "validate",
        writeDescription(env.dir, yaml),
        "--db",
        env.dbPath,
        "--json",
        "--unchecked",
      ],
      { tmpdir: env.tmpdir },
    );
    assert.equal(validate.code, 0, validate.stderr.join("\n"));
    assert.deepEqual(validate.stderr, warnings);
    assert.deepEqual(
      (JSON.parse(validate.stdout[0] ?? "") as Json)["warnings"],
      warnings,
    );

    const result = await applyTo(env, yaml, {}, ["--json", "--unchecked"]);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    for (const warning of warnings)
      assert.ok(result.stderr.includes(warning), result.stderr.join("\n"));
    assert.deepEqual(
      (JSON.parse(result.stdout[0] ?? "") as Json)["warnings"],
      warnings,
    );
    const config = surfaceRow(env.dbPath, SKAARHOJ)["config"] as Json;
    assert.equal(config["plugin_cfg_newSetting"], 1);
    assert.equal(config["emulator_rows"], 4);
  });

  it("--unchecked warns about nothing when every key is stored with its type", async () => {
    const env = seeded();
    const result = await applyTo(
      env,
      `kind: surface\nsurface: "${SKAARHOJ}"\nplugin: { sleepTimer: 5 }\n`,
      {},
      ["--unchecked"],
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(
      result.stderr.filter((line) => line.startsWith("warning:")),
      [],
    );
  });

  it("--db never asks the running Companion, even with COMPANION_URL set", async () => {
    const fake = await startFakeTrpc();
    try {
      const env = seeded();
      const result = await applyTo(
        env,
        `kind: surface\nsurface: "${SKAARHOJ}"\nplugin: { newSetting: 1 }\n`,
        { env: { COMPANION_URL: fake.url }, companionBuildFile: buildFile() },
      );
      assert.equal(result.code, 1);
      assert.deepEqual(fake.upgrades, []);
    } finally {
      await fake.stop();
    }
  });
});

/** A temporary BUILD file holding `content`. */
function buildFile(content = `${BUILD}\n`): string {
  const path = join(tempDir(), "BUILD");
  writeFileSync(path, content);
  return path;
}

describe("apply surface: with the running Companion's definitions", () => {
  let fake: FakeTrpc;
  before(async () => {
    fake = await startFakeTrpc();
  });
  after(() => fake.stop());

  const FIELDS = [
    { id: "brightness", type: "number", min: 0, max: 100 },
    { id: "transfer_input_hwc_12", type: "custom-variable", label: "Enc 1" },
    { id: "transfer_output_hwc_40", type: "expression" },
    { id: "plugin_cfg_sleepTimer", type: "number", min: 0, max: 3600 },
    {
      id: "plugin_cfg_mode",
      type: "dropdown",
      choices: [{ id: "a" }, { id: "b" }],
    },
    { id: "plugin_cfg_free", type: "dropdown", allowCustom: true, choices: [] },
    { id: "plugin_cfg_dim", type: "checkbox" },
    { id: "plugin_cfg_label", type: "textinput" },
    { id: "plugin_cfg_fancy", type: "colorpicker" },
  ];

  beforeEach(() => {
    fake.reset();
    fake.state.surfaces = watchedSurfaces(SKAARHOJ, FIELDS);
  });

  /** A home with the seeded fixture at the install path. */
  function liveHome() {
    const home = tempDir();
    const dbPath = buildFixtureDb(installDir(home));
    const db = new DatabaseSync(dbPath);
    seedSurfaces(db);
    db.close();
    return { home, dbPath };
  }

  async function liveValidate(
    yaml: string,
    extra: string[] = [],
    build = buildFile(),
  ): Promise<CliRun & { dbPath: string }> {
    const { home, dbPath } = liveHome();
    const result = await runCli(
      ["validate", writeDescription(home, yaml), ...extra],
      {
        homedir: home,
        env: { COMPANION_URL: fake.url },
        companionBuildFile: build,
      },
    );
    return { ...result, dbPath };
  }

  it("accepts declared keys of the right type, stored or not", async () => {
    const result = await liveValidate(`kind: surface
surface: "${SKAARHOJ}"
brightness: 40
transferInputs: { hwc_12: fx_counter }
plugin: { sleepTimer: 3600, mode: b, free: anything, dim: true, label: x, fancy: 12 }
`);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(result.stderr, []);
    assert.equal(fake.upgrades.length, 1, "one socket for the definitions");
    assert.equal(fake.upgrades[0]?.["origin"], undefined, "no Origin header");
    assert.deepEqual(
      [...new Set(fake.messages.map((message) => message["method"]))].sort(),
      ["subscription", "subscription.stop"],
      "subscribe-only",
    );
    const subscribed = fake.messages
      .filter((message) => message["method"] === "subscription")
      .map((message) => (message["params"] as Json)["path"]);
    assert.deepEqual(subscribed, ["surfaces.watchSurfaces"]);
  });

  for (const [name, yaml, path, message] of [
    [
      "an undeclared key, listing the declared ones",
      "config: { emulator_rows: 4 }",
      "config.emulator_rows",
      /the surface has no config field "emulator_rows"/,
    ],
    [
      "a number above its max",
      "plugin: { sleepTimer: 3601 }",
      "plugin.sleepTimer",
      /must be at most 3600 \(plugin_cfg_sleepTimer, a number field\)/,
    ],
    [
      "a string for a number",
      "plugin: { sleepTimer: '5' }",
      "plugin.sleepTimer",
      /must be a number, got a string \(plugin_cfg_sleepTimer, a number field\)/,
    ],
    [
      "a dropdown value that is not a choice",
      "plugin: { mode: c }",
      "plugin.mode",
      /"c" is not one of the choices: "a", "b" \(plugin_cfg_mode, a dropdown field\)/,
    ],
    [
      "a non-boolean checkbox",
      "plugin: { dim: 1 }",
      "plugin.dim",
      /must be true or false, got a number \(plugin_cfg_dim, a checkbox field\)/,
    ],
    [
      "a number for a text input",
      "plugin: { label: 1 }",
      "plugin.label",
      /must be a string, got a number \(plugin_cfg_label, a textinput field\)/,
    ],
  ] as const) {
    it(`refuses ${name}`, async () => {
      const result = await liveValidate(
        `kind: surface\nsurface: "${SKAARHOJ}"\n${yaml}\n`,
        ["--json"],
      );
      assert.equal(result.code, 1);
      const doc = (JSON.parse(result.stdout[0] ?? "") as { error: Json }).error;
      assert.equal(doc["code"], "check_failed");
      assert.equal(doc["path"], path);
      assert.match(String(doc["message"]), message);
    });
  }

  it("the undeclared-key refusal hints at the declared keys", async () => {
    const result = await liveValidate(
      `kind: surface\nsurface: "${SKAARHOJ}"\nconfig: { emulator_rows: 4 }\n`,
      ["--json"],
    );
    const doc = (JSON.parse(result.stdout[0] ?? "") as { error: Json }).error;
    assert.match(
      String(doc["hint"]),
      /^its config fields: brightness, transfer_input_hwc_12,/,
    );
  });

  it("--unchecked does not override live definitions", async () => {
    const result = await liveValidate(
      `kind: surface\nsurface: "${SKAARHOJ}"\nconfig: { emulator_rows: 4 }\n`,
      ["--unchecked"],
    );
    assert.equal(result.code, 1);
  });

  for (const [name, change, reason] of [
    [
      "a disconnected surface",
      (f: FakeTrpc) => {
        f.state.surfaces = watchedSurfaces(SKAARHOJ, FIELDS, false);
      },
      `surface "${SKAARHOJ}" is not connected`,
    ],
    [
      "a surface the running Companion does not know",
      (f: FakeTrpc) => {
        f.state.surfaces = watchedSurfaces("other", FIELDS);
      },
      `the running Companion does not know surface "${SKAARHOJ}"`,
    ],
    [
      "a payload of another shape",
      (f: FakeTrpc) => {
        f.state.surfaces = { g: { surfaces: "nope" } };
      },
      "Companion's surfaces.watchSurfaces payload is not the expected shape",
    ],
    [
      "an error reply",
      (f: FakeTrpc) => {
        f.state.failing.add("surfaces.watchSurfaces");
      },
      "Companion answered surfaces.watchSurfaces with an error",
    ],
  ] as const) {
    it(`${name} falls back to the stored-key rule, naming why`, async () => {
      change(fake);
      const result = await liveValidate(
        `kind: surface\nsurface: "${SKAARHOJ}"\nplugin: { newSetting: 1 }\n`,
        ["--json"],
      );
      assert.equal(result.code, 1);
      const doc = (JSON.parse(result.stdout[0] ?? "") as { error: Json }).error;
      assert.ok(
        String(doc["message"]).includes(reason),
        String(doc["message"]),
      );
      const ok = await liveValidate(
        `kind: surface\nsurface: "${SKAARHOJ}"\nplugin: { sleepTimer: 9 }\n`,
      );
      assert.equal(ok.code, 0, ok.stderr.join("\n"));
    });
  }

  it("another Companion build reads no definitions and opens no socket", async () => {
    const result = await liveValidate(
      `kind: surface\nsurface: "${SKAARHOJ}"\nplugin: { newSetting: 1 }\n`,
      ["--json"],
      buildFile("5.2.0+1-beta\n"),
    );
    assert.equal(result.code, 1);
    const doc = (JSON.parse(result.stdout[0] ?? "") as { error: Json }).error;
    assert.match(
      String(doc["message"]),
      /Companion build "5\.2\.0\+1-beta" is not supported: kind: surface reads a private API/,
    );
    assert.deepEqual(fake.upgrades, []);
  });

  it("without COMPANION_URL there are no definitions, and no socket", async () => {
    const { home } = liveHome();
    const result = await runCli(
      [
        "validate",
        writeDescription(
          home,
          `kind: surface\nsurface: "${SKAARHOJ}"\nplugin: { newSetting: 1 }\n`,
        ),
        "--json",
      ],
      { homedir: home, companionBuildFile: buildFile() },
    );
    assert.equal(result.code, 1);
    const doc = (JSON.parse(result.stdout[0] ?? "") as { error: Json }).error;
    assert.match(String(doc["message"]), /COMPANION_URL/);
    assert.deepEqual(fake.upgrades, []);
  });

  it("a live apply reads the definitions before it quits Companion, once", async () => {
    const { home, dbPath } = liveHome();
    const calls: string[] = [];
    const processes = fakeProcessControl({ running: true, calls });
    const result = await runCli(
      [
        "apply",
        writeDescription(
          home,
          `kind: surface\nsurface: "${SKAARHOJ}"\nplugin: { mode: a }\n`,
        ),
        "--rest-timeout",
        "0",
      ],
      {
        homedir: home,
        processControl: processes.control,
        surfaceConfigFields: async (id) => {
          calls.push(`fields ${id}`);
          return { available: true, fields: FIELDS };
        },
      },
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(calls.slice(0, 2), [`fields ${SKAARHOJ}`, "check"]);
    assert.equal(calls.filter((call) => call.startsWith("fields")).length, 1);
    assert.ok(calls.includes("quit"));
    assert.equal(
      (surfaceRow(dbPath, SKAARHOJ)["config"] as Json)["plugin_cfg_mode"],
      "a",
    );
  });

  it("validate --no-db reads no definitions", async () => {
    const result = await liveValidate(
      `kind: surface\nsurface: "${SKAARHOJ}"\nplugin: { newSetting: 1 }\n`,
      ["--no-db"],
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(fake.upgrades, []);
  });
});
