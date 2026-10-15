import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  FIXTURE_CONTROL_A,
  FIXTURE_CONTROL_B,
} from "./fixtures/companion-db.ts";
import { type FixtureEnv, runCli, setup } from "./helpers.ts";
import {
  button,
  insert,
  listReadOnly,
  ok,
  seedConnections,
} from "./list-fixture.ts";
import { seededPageId, seedEmptyPages, widenGrid } from "./skaarhoj-fixture.ts";

const listPages = (env: FixtureEnv, args: string[] = []) =>
  listReadOnly(env, "pages", args);

const PAGE_UP = "bank:SeedNavUpAAAAAAAAAAAA";
const PAGE_NUM = "bank:SeedNavNumAAAAAAAAAAA";
const PAGE_DOWN = "bank:SeedNavDownAAAAAAAAAA";
const NO_ROW = "bank:SeedNoRowAAAAAAAAAAAA";

/**
 * Page 2 holds Companion's navigation buttons, a cell whose control has no
 * row and a cell in row 1 that comes after them; page 3 is empty; page 5 is a
 * stray row after the missing page 4.
 */
function seedDisplay(db: DatabaseSync): void {
  insert(db, "controls", PAGE_UP, { type: "pageup" });
  insert(db, "controls", PAGE_NUM, { type: "pagenum" });
  insert(db, "controls", PAGE_DOWN, { type: "pagedown" });
  insert(db, "controls", "bank:SeedLaterAAAAAAAAAAAA", button("later"));
  insert(db, "pages", "2", {
    id: "SeedPageNavAAAAAAAAAA",
    name: "NAV",
    controls: {
      "1": { "0": "bank:SeedLaterAAAAAAAAAAAA" },
      "0": { "10": NO_ROW, "0": PAGE_UP, "1": PAGE_NUM, "2": PAGE_DOWN },
    },
  });
  insert(db, "pages", "3", {
    id: "SeedPageEmptyAAAAAAAA",
    name: "EMPTY",
    controls: {},
  });
  insert(db, "pages", "5", {
    id: "SeedPageStrayAAAAAAAA",
    name: "STRAY",
    controls: {},
  });
}

describe("list pages", () => {
  it("lists the standard fixture's page", async () => {
    const env = setup();
    assert.deepEqual(ok(await listPages(env)), [
      "PAGE  NAME     BUTTONS  CONNECTIONS  LABELS",
      `1     FIXTURE  2        internal     "Count\\n$(custom:fx_…", "$(custom:fx_label)"`,
    ]);
  });

  it("prints one JSON document with every cell and unloadedRows", async () => {
    const env = setup();
    const stdout = ok(await listPages(env, ["--json"]));
    assert.equal(stdout.length, 1);
    assert.deepEqual(JSON.parse(stdout[0] ?? ""), {
      database: env.dbPath,
      databaseSource: null,
      pages: [
        {
          page: 1,
          name: "FIXTURE",
          id: "FixturePageIdAAAAAAAA",
          buttons: 2,
          connections: [{ id: "internal", label: "internal" }],
          cells: [
            {
              row: 0,
              column: 0,
              controlId: FIXTURE_CONTROL_A,
              type: "button-layered",
              text: "Count\\n$(custom:fx_counter)",
            },
            {
              row: 0,
              column: 1,
              controlId: FIXTURE_CONTROL_B,
              type: "button-layered",
              text: "$(custom:fx_label)",
            },
          ],
        },
      ],
      unloadedRows: [],
    });
  });

  it("shows navigation buttons, missing controls, empty pages, and skips a stray row", async () => {
    const env = setup({}, seedDisplay);
    assert.deepEqual(ok(await listPages(env)), [
      "PAGE  NAME     BUTTONS  CONNECTIONS  LABELS",
      `1     FIXTURE  2        internal     "Count\\n$(custom:fx_…", "$(custom:fx_label)"`,
      "2     NAV      5        -            <pageup>, <pagenum>, <pagedown>, …",
      "3     EMPTY    0        -",
    ]);
    const document = JSON.parse(ok(await listPages(env, ["--json"]))[0] ?? "");
    assert.deepEqual(document.unloadedRows, ["5"]);
    assert.deepEqual(document.pages[1].cells, [
      { row: 0, column: 0, controlId: PAGE_UP, type: "pageup", text: null },
      { row: 0, column: 1, controlId: PAGE_NUM, type: "pagenum", text: null },
      { row: 0, column: 2, controlId: PAGE_DOWN, type: "pagedown", text: null },
      { row: 0, column: 10, controlId: NO_ROW, type: null, text: null },
      {
        row: 1,
        column: 0,
        controlId: "bank:SeedLaterAAAAAAAAAAAA",
        type: "button-layered",
        text: "later",
      },
    ]);
  });

  it("shows <missing> for a cell without a control row", async () => {
    const env = setup({}, (db) => {
      seedDisplay(db);
      db.prepare("DELETE FROM controls WHERE id = ?").run(PAGE_UP);
    });
    assert.equal(
      ok(await listPages(env))[2],
      "2     NAV      5        -            <missing>, <pagenum>, <pagedown>, …",
    );
  });

  it("lists the connections a page's controls reference, sorted by label", async () => {
    const env = setup({}, seedConnections);
    assert.deepEqual(ok(await listPages(env)), [
      "PAGE  NAME     BUTTONS  CONNECTIONS                       LABELS",
      `1     FIXTURE  2        internal                          "Count\\n$(custom:fx_…", "$(custom:fx_label)"`,
      `2     CONNS    4        ?, alpha, beta, echo, twin, twin  "S1", "F", "$(echo:volume)\\n$(t…", …`,
    ]);
  });

  it("filters by name patterns", async () => {
    const env = setup({}, seedDisplay);
    const names = async (...patterns: string[]) =>
      ok(await listPages(env, patterns))
        .slice(1)
        .map((line) => line.split(/ +/)[1]);
    assert.deepEqual(await names("NAV"), ["NAV"]);
    assert.deepEqual(await names("*X*", "EMPTY"), ["FIXTURE", "EMPTY"]);
    assert.deepEqual(await names("STRAY"), []);
    const json = JSON.parse(
      ok(await listPages(env, ["NAV", "--json"]))[0] ?? "",
    );
    assert.deepEqual(
      json.pages.map((page: { page: number }) => page.page),
      [2],
    );
    assert.deepEqual(json.unloadedRows, ["5"]);
  });

  it("gives byte-identical output on every run", async () => {
    const env = setup({}, seedDisplay);
    for (const args of [[], ["--json"]]) {
      const first = ok(await listPages(env, args));
      assert.deepEqual(ok(await listPages(env, args)), first);
    }
  });

  it("lists 99 pages with the SKAARHOJ page applied at page 99", async () => {
    const env = setup({}, (db) => {
      seedEmptyPages(db, 98);
      widenGrid(db);
    });
    for (const name of ["variables.yaml", "page.yaml"]) {
      const file = fileURLToPath(
        new URL(`../examples/skaarhoj-test-page/${name}`, import.meta.url),
      );
      const result = await runCli(["apply", file, "--db", env.dbPath], {
        backupRoot: env.backupRoot,
        tmpdir: env.tmpdir,
      });
      assert.equal(result.code, 0, result.stderr.join("\n"));
    }
    const lines = ok(await listPages(env));
    assert.equal(lines.length, 100);
    assert.equal(lines[2], "2     PAGE           0        -");
    assert.equal(
      lines[99],
      `99    SKAARHOJ TEST  47       internal     "Last\\n$(custom:sk_l…", "Iris $(custom:sk_ir…", "$(internal:time_hms)", …`,
    );
    const document = JSON.parse(ok(await listPages(env, ["--json"]))[0] ?? "");
    assert.equal(document.pages[1].id, seededPageId(2));
    assert.equal(document.pages[98].cells.length, 47);
  });
});
