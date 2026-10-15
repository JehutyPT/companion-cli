import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type FixtureEnv, setup } from "./helpers.ts";
import {
  ALPHA,
  BETA,
  DELTA,
  ECHO,
  GAMMA,
  GHOST,
  listReadOnly,
  ok,
  SECRETS,
  seedConnections,
  TWIN_A,
  TWIN_Z,
  UNPLACED_GHOST,
  UNUSED,
} from "./list-fixture.ts";

const listConnections = (env: FixtureEnv, args: string[] = []) =>
  listReadOnly(env, "connections", args);

describe("list connections", () => {
  it("lists the standard fixture's connections", async () => {
    const env = setup();
    assert.deepEqual(ok(await listConnections(env)), [
      "LABEL     MODULE          VERSION  ENABLED  BUTTONS  TRIGGERS  ID",
      "internal  (built-in)      -        yes      1        0         internal",
      "fixture   fixture-module  1.0.0    no       0        0         FixtureConnectionAAAA",
    ]);
  });

  it("counts every kind of use, once per control", async () => {
    const env = setup({}, seedConnections);
    assert.deepEqual(ok(await listConnections(env)), [
      "LABEL     MODULE          VERSION  ENABLED  BUTTONS  TRIGGERS  ID",
      "internal  (built-in)      -        yes      1        0         internal",
      "fixture   fixture-module  1.0.0    no       0        0         FixtureConnectionAAAA",
      `beta      beta-module     -        no       1        0         ${BETA}`,
      `alpha     alpha-module    2.1.0    yes      1        0         ${ALPHA}`,
      `gamma     gamma-module    2.1.0    yes      0        1         ${GAMMA}`,
      `delta     delta-module    2.1.0    yes      0        1         ${DELTA}`,
      `twin      twin-module     2.1.0    yes      1        0         ${TWIN_Z}`,
      `twin      twin-module     2.1.0    yes      1        0         ${TWIN_A}`,
      `echo      echo-module     2.1.0    yes      1        0         ${ECHO}`,
      `unused    unused-module   2.1.0    yes      0        0         ${UNUSED}`,
      `?         (missing)       -        -        1        0         ${GHOST}`,
      `?         (missing)       -        -        0        0         ${UNPLACED_GHOST}`,
    ]);
  });

  it("prints one JSON document with --json", async () => {
    const env = setup({}, seedConnections);
    const stdout = ok(await listConnections(env, ["--json"]));
    assert.equal(stdout.length, 1);
    const document = JSON.parse(stdout[0] ?? "");
    assert.equal(document.database, env.dbPath);
    assert.deepEqual(Object.keys(document), ["database", "connections"]);
    const row = (
      id: string,
      label: string | null,
      sortOrder: number | null,
      buttons: number,
      triggers: number,
    ) => ({
      id,
      label,
      moduleId: label === null ? null : `${label}-module`,
      moduleVersionId: label === null ? null : "2.1.0",
      enabled: label === null ? null : true,
      sortOrder,
      buttons,
      triggers,
      missing: label === null,
    });
    assert.deepEqual(document.connections, [
      {
        ...row("internal", "internal", null, 1, 0),
        moduleId: null,
        moduleVersionId: null,
      },
      {
        ...row("FixtureConnectionAAAA", "fixture", 0, 0, 0),
        moduleVersionId: "1.0.0",
        enabled: false,
      },
      { ...row(BETA, "beta", 1, 1, 0), moduleVersionId: null, enabled: false },
      row(ALPHA, "alpha", 2, 1, 0),
      row(GAMMA, "gamma", 3, 0, 1),
      row(DELTA, "delta", 4, 0, 1),
      row(TWIN_Z, "twin", 5, 1, 0),
      row(TWIN_A, "twin", 6, 1, 0),
      row(ECHO, "echo", 7, 1, 0),
      row(UNUSED, "unused", 8, 0, 0),
      row(GHOST, null, null, 1, 0),
      row(UNPLACED_GHOST, null, null, 0, 0),
    ]);
  });

  it("filters by label patterns, internal and ? included", async () => {
    const env = setup({}, seedConnections);
    const labels = async (...patterns: string[]) =>
      ok(await listConnections(env, patterns))
        .slice(1)
        .map((line) => line.split("  ")[0]?.trim());
    assert.deepEqual(await labels("twin"), ["twin", "twin"]);
    assert.deepEqual(await labels("int*"), ["internal"]);
    assert.deepEqual(await labels("?"), ["?", "?"]);
    assert.deepEqual(await labels("*l*", "echo"), [
      "internal",
      "alpha",
      "delta",
      "echo",
    ]);
  });

  it("gives byte-identical output on every run", async () => {
    const env = setup({}, seedConnections);
    for (const args of [[], ["--json"]]) {
      const first = ok(await listConnections(env, args));
      assert.deepEqual(ok(await listConnections(env, args)), first);
    }
  });

  it("never prints connection or surface config and secrets", async () => {
    const env = setup({}, seedConnections);
    for (const kind of ["connections", "pages"]) {
      for (const args of [[], ["--json"]]) {
        const result = await listReadOnly(env, kind, args);
        assert.equal(result.code, 0);
        const output = [...result.stdout, ...result.stderr].join("\n");
        for (const secret of [...SECRETS, "10.0.0.1", "surfacey"])
          assert.ok(!output.includes(secret), `${kind} ${args}: ${secret}`);
        for (const field of [
          "config",
          "secrets",
          "updatePolicy",
          "lastUpgradeIndex",
        ])
          assert.ok(
            !output.includes(`"${field}"`),
            `${kind} ${args}: ${field}`,
          );
      }
    }
  });
});
