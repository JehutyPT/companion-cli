/**
 * `list surfaces` (#32): the stored surface rows by id, with their name,
 * type, enabled flag and config key count; never a config value.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type FixtureEnv, setup } from "./helpers.ts";
import { listReadOnly, ok } from "./list-fixture.ts";
import {
  insertSurface,
  SKAARHOJ,
  SKAARHOJ_ROW,
  STREAMDECK,
  STREAMDECK_ROW,
  seedSurfaces,
} from "./surface-fixture.ts";

const listSurfaces = (env: FixtureEnv, args: string[] = []) =>
  listReadOnly(env, "surfaces", args);

describe("list surfaces", () => {
  it("lists the fixture's surface", async () => {
    const env = setup();
    assert.deepEqual(ok(await listSurfaces(env)), [
      "ID               NAME             TYPE  ENABLED  KEYS",
      "fixture-surface  Fixture surface  -     yes      1",
    ]);
  });

  it("lists every surface by id", async () => {
    const env = setup({}, (db) => {
      seedSurfaces(db);
      insertSurface(db, "emulator:off", { enabled: false, type: "Emulator" });
    });
    assert.deepEqual(ok(await listSurfaces(env)), [
      "ID                        NAME             TYPE                   ENABLED  KEYS",
      "emulator:off              -                Emulator               no       -",
      "fixture-surface           Fixture surface  -                      yes      1",
      `${SKAARHOJ}  Desk panel       SKAARHOJ Raw Panel     yes      9`,
      `${STREAMDECK}        -                Elgato Stream Deck XL  yes      6`,
    ]);
  });

  it("matches patterns against the id or the name", async () => {
    const env = setup({}, seedSurfaces);
    const ids = async (...patterns: string[]) =>
      ok(await listSurfaces(env, patterns))
        .slice(1)
        .map((line) => line.split(" ")[0]);
    assert.deepEqual(await ids("skaarhoj:*"), [SKAARHOJ]);
    assert.deepEqual(await ids("Desk*"), [SKAARHOJ]);
    assert.deepEqual(await ids("streamdeck:*", "Fixture*"), [
      "fixture-surface",
      STREAMDECK,
    ]);
  });

  it("prints one JSON document with --json", async () => {
    const env = setup({}, seedSurfaces);
    const stdout = ok(await listSurfaces(env, ["--json"]));
    assert.equal(stdout.length, 1);
    const document = JSON.parse(stdout[0] ?? "");
    assert.deepEqual(Object.keys(document), ["database", "surfaces"]);
    assert.deepEqual(document.surfaces, [
      {
        id: "fixture-surface",
        name: "Fixture surface",
        type: null,
        integrationType: null,
        enabled: true,
        configKeys: 1,
      },
      {
        id: SKAARHOJ,
        name: "Desk panel",
        type: SKAARHOJ_ROW.type,
        integrationType: SKAARHOJ_ROW.integrationType,
        enabled: true,
        configKeys: 9,
      },
      {
        id: STREAMDECK,
        name: "",
        type: STREAMDECK_ROW.type,
        integrationType: STREAMDECK_ROW.integrationType,
        enabled: true,
        configKeys: 6,
      },
    ]);
  });

  it("never prints a config value", async () => {
    const SECRET = "SEEDED-SURFACE-VALUE-7f3a";
    const env = setup({}, (db) =>
      insertSurface(db, "skaarhoj:PRIVATE", {
        ...SKAARHOJ_ROW,
        config: { ...SKAARHOJ_ROW.config, plugin_cfg_token: SECRET },
      }),
    );
    for (const args of [[], ["--json"]]) {
      const stdout = ok(await listSurfaces(env, args)).join("\n");
      assert.ok(stdout.includes("skaarhoj:PRIVATE"));
      assert.ok(!stdout.includes(SECRET), "config value printed");
      assert.ok(!stdout.includes("plugin_cfg_token"), "config key printed");
    }
  });
});
