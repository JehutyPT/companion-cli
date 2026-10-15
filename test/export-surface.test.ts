/**
 * `export surface <id>` (#32, ADR 0006): one stored surface as a
 * `kind: surface` file that round-trips through apply.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SCHEMA_MODELINE } from "../src/schema.ts";
import {
  assertRefused,
  exportFrom,
  exportRoundTrip,
  mutate,
  ok,
} from "./export-helpers.ts";
import { setup } from "./helpers.ts";
import {
  insertSurface,
  SKAARHOJ,
  SKAARHOJ_ROW,
  STREAMDECK,
  seedSurfaces,
} from "./surface-fixture.ts";

describe("export surface", () => {
  it("exports the fixture surface", async () => {
    const env = setup();
    const yaml = await exportRoundTrip(env, ["surface", "fixture-surface"]);
    assert.equal(
      yaml,
      `${SCHEMA_MODELINE}\n# companion-cli export: surface (1)\n# kept as stored by apply, not exported: groupConfig\nkind: surface\nsurface: fixture-surface\nname: Fixture surface\nbrightness: 100\n`,
    );
  });

  it("exports a SKAARHOJ panel with its transfer variables and plugin settings", async () => {
    const env = setup({}, seedSurfaces);
    const yaml = await exportRoundTrip(env, ["surface", SKAARHOJ]);
    assert.ok(!yaml.includes("groupId"), "a null groupId is not emitted");
    const json = ok(await exportFrom(env, ["surface", SKAARHOJ, "--json"]));
    assert.deepEqual(JSON.parse(json), {
      kind: "surface",
      surface: SKAARHOJ,
      name: "Desk panel",
      enabled: true,
      brightness: 100,
      rotation: 0,
      xOffset: 0,
      yOffset: 0,
      transferInputs: { hwc_12: "fx_label", hwc_13: "" },
      transferOutputs: { hwc_40: "$(custom:fx_counter) > 0" },
      plugin: { sleepTimer: 0 },
    });
    assert.deepEqual(yaml.split("\n").slice(1, 3), [
      "# companion-cli export: surface (1)",
      "# kept as stored by apply, not exported: groupConfig, type, integrationType, gridSize",
    ]);
  });

  it("exports a Stream Deck's other config keys under config", async () => {
    const env = setup({}, seedSurfaces);
    await exportRoundTrip(env, ["surface", STREAMDECK]);
    const json = ok(await exportFrom(env, ["surface", STREAMDECK, "--json"]));
    assert.deepEqual(JSON.parse(json), {
      kind: "surface",
      surface: STREAMDECK,
      name: "",
      enabled: true,
      brightness: 50,
      rotation: "surface90",
      xOffset: 1,
      yOffset: 0,
      config: { canChangePage: true },
    });
  });

  it("refuses a surface in a manual group", async () => {
    const env = setup({}, (db) => {
      seedSurfaces(db);
      mutate(db, "surfaces", SKAARHOJ, (value) => ({
        ...value,
        config: { ...(value["config"] as object), groupId: "group:abc" },
      }));
      insertSurface(db, "streamdeck:GROUPED", {
        ...SKAARHOJ_ROW,
        groupId: "group:abc",
      });
    });
    const inConfig = await assertRefused(
      env,
      ["surface", SKAARHOJ],
      `cannot export surface "${SKAARHOJ}": config.groupId is set: the surface is in a manual surface group, which the description format does not support (see docs/support-matrix.md, surface)`,
      "config.groupId",
      "see docs/support-matrix.md (surface)",
    );
    assert.equal(inConfig.code, "export_unsupported");
    const topLevel = await assertRefused(
      env,
      ["surface", "streamdeck:GROUPED"],
      'cannot export surface "streamdeck:GROUPED": groupId is set: the surface is in a manual surface group, which the description format does not support (see docs/support-matrix.md, surface)',
      "groupId",
      "see docs/support-matrix.md (surface)",
    );
    assert.equal(topLevel.code, "export_unsupported");
  });

  it("refuses an unknown surface", async () => {
    const env = setup();
    const error = await assertRefused(
      env,
      ["surface", "streamdeck:NOPE"],
      'surface: no surface "streamdeck:NOPE" in the database',
      "surface",
      "run companion-cli list surfaces",
    );
    assert.equal(error.code, "not_found");
  });
});
