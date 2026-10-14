import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  FIXTURE_CONTROL_A,
  FIXTURE_CONTROL_B,
} from "./fixtures/companion-db.ts";
import {
  applyTo,
  assertTablesUnchangedExcept,
  applyYaml,
  CONTROL_ID,
  dumpDatabase,
  fileState,
  ID,
  type Json,
  normaliseIds,
  page,
  printedBackupDir,
  rows,
  setup,
  stripIds,
  type TableDump,
} from "./helpers.ts";

type Cells = Record<string, Record<string, string>>;

function setPage(db: DatabaseSync, id: string, value: unknown): void {
  db.prepare("INSERT OR REPLACE INTO pages (id, value) VALUES (?, ?)").run(
    id,
    JSON.stringify(value),
  );
}

function readPage(db: DatabaseSync, id: string): Json {
  return JSON.parse(
    String(
      db.prepare("SELECT value FROM pages WHERE id = ?").get(id)?.["value"],
    ),
  ) as Json;
}

/** The control at a cell of a page, with its id. */
function controlAt(
  dump: TableDump,
  pageId: string,
  row: number,
  column: number,
): { id: string; control: Json } {
  const cells = page(dump, pageId)["controls"] as Cells;
  const id = cells[String(row)]?.[String(column)];
  assert.ok(id, `control at page ${pageId} ${row}/${column}`);
  const control = rows(dump, "controls").get(id);
  assert.ok(control, `controls row ${id}`);
  return { id, control };
}

function textOf(control: Json): unknown {
  const layers = (control["style"] as { layers: Json[] }).layers;
  return (layers.find((layer) => layer["id"] === "text0")?.["text"] as Json)[
    "value"
  ];
}

const PAGE_1_YAML = `kind: page
page: 1
name: SKAARHOJ TEST
buttons:
  - location: { row: 0, column: 0 }
    text: "Last\\n$(custom:fx_counter)"
    background: "#000080"
    down: [ { action: increment, variable: fx_counter } ]
  - location: { row: 1, column: 5 }
    text: S1
    background: "#FF0000"
  - location: { row: 1, column: 2 }
    text: S2
    background: "#00FF00"
`;

const pageYaml = (pageNumber: number, name = "NEW") => `kind: page
page: ${pageNumber}
name: ${name}
buttons:
  - location: { row: 0, column: 1 }
    text: A
    background: "#000000"
  - location: { row: 2, column: 3 }
    text: B
    background: "#FFFFFF"
`;

describe("apply page: replacing an existing page", () => {
  it("deletes the page's controls, writes the described ones and keeps the page id", async () => {
    const { dbPath, before, result } = await applyYaml(PAGE_1_YAML);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(result.stderr, []);
    assert.ok(printedBackupDir(result));
    assert.equal(result.stdout.length, 2);
    assert.match(result.stdout[0] ?? "", /^backup: /);
    assert.equal(
      result.stdout[1],
      'page 1 "SKAARHOJ TEST": replaced; deleted 2 controls, wrote 3 controls',
    );

    const after = dumpDatabase(dbPath);
    const stored = page(after, "1");
    assert.equal(stored["name"], "SKAARHOJ TEST");
    assert.equal(stored["id"], "FixturePageIdAAAAAAAA");
    assert.deepEqual(Object.keys(stored).sort(), ["controls", "id", "name"]);
    const cells = stored["controls"] as Cells;
    assert.deepEqual(Object.keys(cells), ["0", "1"]);
    assert.deepEqual(Object.keys(cells["0"] ?? {}), ["0"]);
    assert.deepEqual(Object.keys(cells["1"] ?? {}), ["2", "5"]);

    const controls = rows(after, "controls");
    assert.equal(controls.has(FIXTURE_CONTROL_A), false);
    assert.equal(controls.has(FIXTURE_CONTROL_B), false);
    assert.equal(controls.size, 3);
    for (const id of [cells["0"]?.["0"], cells["1"]?.["2"], cells["1"]?.["5"]])
      assert.match(id ?? "", CONTROL_ID);
    assert.equal(
      textOf(controlAt(after, "1", 0, 0).control),
      "Last\\n$(custom:fx_counter)",
    );
    assert.equal(textOf(controlAt(after, "1", 1, 5).control), "S1");
    assert.equal(textOf(controlAt(after, "1", 1, 2).control), "S2");

    assert.deepEqual([...rows(after, "pages").keys()], ["1"]);
    assertTablesUnchangedExcept(before, after, "controls", "pages");
  });

  it("keeps other keys of an existing page row", async () => {
    const { dbPath, result } = await applyYaml(PAGE_1_YAML, {}, (db) =>
      setPage(db, "1", { ...readPage(db, "1"), extra: { keep: true } }),
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    const stored = page(dumpDatabase(dbPath), "1");
    assert.deepEqual(stored["extra"], { keep: true });
    assert.equal(stored["id"], "FixturePageIdAAAAAAAA");
  });

  it("deletes only the page's own controls, not other pages' controls", async () => {
    const other = "bank:OtherPageCtrlAAAAAA";
    const { dbPath, result } = await applyYaml(PAGE_1_YAML, {}, (db) => {
      setPage(db, "2", {
        id: "OtherPageIdAAAAAAAAAA",
        name: "OTHER",
        controls: { "0": { "0": other } },
      });
      db.prepare("INSERT INTO controls (id, value) VALUES (?, ?)").run(
        other,
        JSON.stringify({ type: "button-layered" }),
      );
    });
    assert.equal(result.code, 0, result.stderr.join("\n"));
    const after = dumpDatabase(dbPath);
    assert.ok(rows(after, "controls").has(other));
    assert.deepEqual(page(after, "2")["controls"], { "0": { "0": other } });
  });

  it("writes a cell's control as a kind: button apply of the same fields does", async () => {
    const fields = `text: "Count\\n$(custom:fx_counter)"
background: "#000080"
textColor: "#FFFF00"
steps:
  - { down: [ { action: set, variable: fx_label, value: "on" } ], rotate_left: [] }
  - { down: [ { action: set, variable: fx_label, value: "off" } ] }
feedbacks:
  - feedback: step
    step: 2
    style: { background: "#00FF00", text: "ON" }
  - feedback: expression
    expression: "$(custom:fx_counter) > 2"
    style: { textColor: "#000000" }
`;
    const indented = fields
      .trimEnd()
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    const viaPage = await applyYaml(`kind: page
page: 1
name: P
buttons:
  - location: { row: 0, column: 2 }
${indented}
`);
    const viaButton = await applyYaml(
      `kind: button\nlocation: { page: 1, row: 0, column: 2 }\n${fields}`,
    );
    assert.equal(viaPage.result.code, 0, viaPage.result.stderr.join("\n"));
    assert.equal(viaButton.result.code, 0, viaButton.result.stderr.join("\n"));
    assert.deepEqual(
      stripIds(controlAt(dumpDatabase(viaPage.dbPath), "1", 0, 2).control),
      stripIds(controlAt(dumpDatabase(viaButton.dbPath), "1", 0, 2).control),
    );
  });

  it("clears the page with an empty button list", async () => {
    const { dbPath, before, result } = await applyYaml(
      "kind: page\npage: 1\nname: EMPTY\nbuttons: []\n",
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(
      result.stdout[1],
      'page 1 "EMPTY": replaced; deleted 2 controls, wrote 0 controls',
    );
    const after = dumpDatabase(dbPath);
    assert.deepEqual(page(after, "1"), {
      name: "EMPTY",
      controls: {},
      id: "FixturePageIdAAAAAAAA",
    });
    assert.equal(rows(after, "controls").size, 0);
    assertTablesUnchangedExcept(before, after, "controls", "pages");
  });

  it("is idempotent: two applies are equal modulo ids, and the first apply's controls are gone", async () => {
    const env = setup();
    const first = await applyTo(env, PAGE_1_YAML);
    assert.equal(first.code, 0, first.stderr.join("\n"));
    const once = dumpDatabase(env.dbPath);
    const second = await applyTo(env, PAGE_1_YAML);
    assert.equal(second.code, 0, second.stderr.join("\n"));
    assert.match(
      second.stdout[1] ?? "",
      /deleted 3 controls, wrote 3 controls$/,
    );
    const twice = dumpDatabase(env.dbPath);
    assert.deepEqual(normaliseIds(twice), normaliseIds(once));
    const after = rows(twice, "controls");
    for (const id of rows(once, "controls").keys())
      assert.equal(after.has(id), false, `${id} deleted`);
  });

  it("counts a control referenced from a cell but missing from controls as not deleted", async () => {
    const { result } = await applyYaml(PAGE_1_YAML, {}, (db) =>
      db.prepare("DELETE FROM controls WHERE id = ?").run(FIXTURE_CONTROL_B),
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.match(
      result.stdout[1] ?? "",
      /deleted 1 controls?, wrote 3 controls$/,
    );
  });
});

describe("apply page: creating pages", () => {
  it("creates page N + 1 with a fresh id and no page: control", async () => {
    const { dbPath, before, result } = await applyYaml(pageYaml(2));
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(
      result.stdout[1],
      'page 2 "NEW": created; deleted 0 controls, wrote 2 controls',
    );
    const after = dumpDatabase(dbPath);
    const created = page(after, "2");
    assert.deepEqual(Object.keys(created), ["id", "name", "controls"]);
    assert.match(String(created["id"]), ID);
    assert.notEqual(created["id"], "FixturePageIdAAAAAAAA");
    assert.equal(created["name"], "NEW");
    const cells = created["controls"] as Cells;
    assert.deepEqual(Object.keys(cells), ["0", "2"]);
    assert.deepEqual(Object.keys(cells["0"] ?? {}), ["1"]);
    assert.deepEqual(Object.keys(cells["2"] ?? {}), ["3"]);
    assert.equal(textOf(controlAt(after, "2", 2, 3).control), "B");

    assert.deepEqual(page(after, "1"), page(before, "1"));
    const controls = rows(after, "controls");
    assert.ok(controls.has(FIXTURE_CONTROL_A));
    assert.ok(controls.has(FIXTURE_CONTROL_B));
    assert.equal(controls.size, 4);
    assert.ok(
      [...controls.keys()].every((id) => id.startsWith("bank:")),
      "no page: control written",
    );
    assertTablesUnchangedExcept(before, after, "controls", "pages");
  });

  it("creates the missing pages in between as empty PAGE pages", async () => {
    const { dbPath, before, result } = await applyYaml(pageYaml(4, "FOUR"));
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(
      result.stdout[1],
      'page 4 "FOUR": created; deleted 0 controls, wrote 2 controls; created 2 empty pages: 2, 3',
    );
    const after = dumpDatabase(dbPath);
    assert.deepEqual([...rows(after, "pages").keys()], ["1", "2", "3", "4"]);
    const ids = new Set<unknown>(["FixturePageIdAAAAAAAA"]);
    for (const number of ["2", "3"]) {
      const gap = page(after, number);
      assert.deepEqual(Object.keys(gap), ["id", "name", "controls"]);
      assert.equal(gap["name"], "PAGE");
      assert.deepEqual(gap["controls"], {});
      assert.match(String(gap["id"]), ID);
      ids.add(gap["id"]);
    }
    const four = page(after, "4");
    assert.equal(four["name"], "FOUR");
    assert.match(String(four["id"]), ID);
    ids.add(four["id"]);
    assert.equal(ids.size, 4, "page ids are distinct");
    assert.equal(rows(after, "controls").size, 4);
    assert.deepEqual(page(after, "1"), page(before, "1"));
    assertTablesUnchangedExcept(before, after, "controls", "pages");
  });

  it("leaves a stray row above the described page alone", async () => {
    const stray = { id: "StrayPageIdAAAAAAAAAA", name: "STRAY", controls: {} };
    const { dbPath, result } = await applyYaml(pageYaml(3), {}, (db) =>
      setPage(db, "9", stray),
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    const after = dumpDatabase(dbPath);
    assert.deepEqual(page(after, "9"), stray);
    assert.equal(page(after, "2")["name"], "PAGE");
  });

  it("still refuses a kind: button apply to a missing page", async () => {
    const { dbPath, backupRoot, before, result } = await applyYaml(
      'kind: button\nlocation: { page: 2, row: 0, column: 0 }\ntext: x\nbackground: "#000000"\n',
    );
    assert.equal(result.code, 1);
    assert.match(
      result.stderr[0] ?? "",
      /location\.page: page 2 does not exist; this writer does not create pages/,
    );
    assert.deepEqual(dumpDatabase(dbPath), before);
    assert.equal(existsSync(backupRoot), false);
  });
});

describe("apply page: refusals leave the database byte-identical", () => {
  async function refuse(
    yaml: string,
    expected: RegExp,
    change?: (db: DatabaseSync) => void,
  ) {
    const env = setup({}, change);
    const before = fileState(env.dbPath);
    const result = await applyTo(env, yaml);
    assert.equal(result.code, 1, result.stdout.join("\n"));
    assert.equal(result.stderr.length, 1, result.stderr.join("\n"));
    assert.match(result.stderr[0] ?? "", expected);
    assert.deepEqual(fileState(env.dbPath), before);
    assert.equal(existsSync(env.backupRoot), false, "no backup for a refusal");
  }

  const button = (extra = "", location = "{ row: 0, column: 0 }") =>
    `  - location: ${location}\n    text: x\n    background: "#000000"\n${extra}`;
  const page1 = (buttons: string, head = "page: 1\nname: P\n") =>
    `kind: page\n${head}buttons:\n${buttons}`;

  const parseCases: Array<[string, string, RegExp]> = [
    [
      "unknown top-level field",
      "kind: page\npage: 1\nname: P\nbuttons: []\ngrid: 1\n",
      /: grid: unknown field$/,
    ],
    [
      "missing page",
      "kind: page\nname: P\nbuttons: []\n",
      /: page: is required$/,
    ],
    [
      "missing name",
      "kind: page\npage: 1\nbuttons: []\n",
      /: name: is required$/,
    ],
    [
      "missing buttons",
      "kind: page\npage: 1\nname: P\n",
      /: buttons: is required$/,
    ],
    [
      "page 0",
      "kind: page\npage: 0\nname: P\nbuttons: []\n",
      /: page: must be a positive integer/,
    ],
    [
      "non-integer page",
      "kind: page\npage: 1.5\nname: P\nbuttons: []\n",
      /: page: must be a positive integer/,
    ],
    [
      "empty name",
      'kind: page\npage: 1\nname: ""\nbuttons: []\n',
      /: name: must not be empty$/,
    ],
    [
      "non-string name",
      "kind: page\npage: 1\nname: 12\nbuttons: []\n",
      /: name: must be a string/,
    ],
    [
      "buttons not a list",
      "kind: page\npage: 1\nname: P\nbuttons: {}\n",
      /: buttons: must be a list/,
    ],
    [
      "button not a mapping",
      "kind: page\npage: 1\nname: P\nbuttons: [ 1 ]\n",
      /: buttons\[0\]: must be a mapping/,
    ],
    [
      "page in a button location",
      page1(button("", "{ page: 1, row: 0, column: 0 }")),
      /: buttons\[0\]\.location\.page: unknown field$/,
    ],
    [
      "unknown button field",
      page1(button("    rotate: []\n")),
      /: buttons\[0\]\.rotate: unknown field$/,
    ],
    [
      "unknown field deep in a button",
      page1(
        button() +
          button(
            "    down: [ { action: increment, variable: fx_counter, value: 1 } ]\n",
            "{ row: 0, column: 1 }",
          ),
      ),
      /: buttons\[1\]\.down\[0\]\.value: unknown field$/,
    ],
    [
      "missing column",
      page1(button("", "{ row: 0 }")),
      /: buttons\[0\]\.location\.column: is required$/,
    ],
    [
      "duplicate location",
      page1(
        button() +
          button("", "{ row: 1, column: 1 }") +
          button("", "{ row: 0, column: 0 }"),
      ),
      /: buttons\[2\]\.location: duplicates buttons\[0\] \(row 0, column 0\)$/,
    ],
  ];
  for (const [name, yaml, expected] of parseCases) {
    it(`refuses: ${name}`, async () => {
      await refuse(
        yaml,
        new RegExp(`^error: invalid description .*${expected.source}`),
      );
    });
  }

  it("refuses an out-of-grid row, naming the button", async () => {
    await refuse(
      page1(button() + button("", "{ row: 4, column: 0 }")),
      /^error: buttons\[1\]\.location\.row: 4 is outside the grid \(0\.\.3\)/,
    );
  });

  it("refuses an out-of-grid column, naming the button", async () => {
    await refuse(
      page1(button("", "{ row: 0, column: -1 }")),
      /^error: buttons\[0\]\.location\.column: -1 is outside the grid \(0\.\.7\)/,
    );
  });

  it("refuses an unknown custom variable, naming the button", async () => {
    await refuse(
      page1(
        button() +
          button(
            "    down: [ { action: increment, variable: nope } ]\n",
            "{ row: 0, column: 1 }",
          ),
      ),
      /^error: buttons\[1\]\.down\[0\]\.variable: unknown custom variable "nope"/,
    );
  });

  it("refuses a page cell holding a non-button control id", async () => {
    await refuse(
      page1(button()),
      /^error: page: page 1, row 0, column 1 holds "trigger:FixtureTrigAAAAAAAAAAA", which is not a button control id; refusing to delete it/,
      (db) => {
        const stored = readPage(db, "1");
        (stored["controls"] as Cells)["0"]!["1"] =
          "trigger:FixtureTrigAAAAAAAAAAA";
        setPage(db, "1", stored);
      },
    );
  });

  it("refuses a bank: control shared with another page", async () => {
    await refuse(
      page1(button()),
      /^error: page: control bank:FixtureCtrlBBBBBBBBBBB on page 1 is also on page 2; refusing to delete it/,
      (db) =>
        setPage(db, "2", {
          id: "OtherPageIdAAAAAAAAAA",
          name: "OTHER",
          controls: { "3": { "7": FIXTURE_CONTROL_B } },
        }),
    );
  });

  it("refuses a stray row between the last page and the described page", async () => {
    await refuse(
      pageYaml(4),
      /^error: page: pages row 3 exists but Companion does not load it/,
      (db) =>
        setPage(db, "3", {
          id: "StrayPageIdAAAAAAAAAA",
          name: "STRAY",
          controls: {},
        }),
    );
  });

  it("refuses a stray row at the described page number", async () => {
    await refuse(
      pageYaml(3),
      /^error: page: pages row 3 exists but Companion does not load it/,
      (db) =>
        setPage(db, "3", {
          id: "StrayPageIdAAAAAAAAAA",
          name: "STRAY",
          controls: {},
        }),
    );
  });

  it("refuses a page row that is not a JSON object", async () => {
    await refuse(
      page1(button()),
      /^error: page: pages row 1 holds \[1,2\], which is not a page Companion loads \(pages 1 to 0 load\); refusing to write page 1 over it/,
      (db) => setPage(db, "1", [1, 2]),
    );
  });

  // Companion's loader stops at the first missing or falsy row, so a row
  // holding null ends the run of pages like a missing one, and is a stray
  // row in the way of any page after it.
  it("refuses a null row before the described page", async () => {
    await refuse(
      pageYaml(3),
      /^error: page: pages row 2 holds null, which is not a page Companion loads \(pages 1 to 1 load\); refusing to write page 3 over it/,
      (db) => setPage(db, "2", null),
    );
  });

  it("refuses a null row at the described page number", async () => {
    await refuse(
      pageYaml(2),
      /^error: page: pages row 2 holds null, which is not a page Companion loads/,
      (db) => setPage(db, "2", null),
    );
  });
});

describe("apply page: the checks run again under the write lock", () => {
  async function refuseAfterBackup(
    yaml: string,
    change: (db: DatabaseSync) => void,
    expected: RegExp,
  ) {
    const env = setup();
    const result = await applyTo(env, yaml, {
      hooks: {
        afterBackup: (path) => {
          const db = new DatabaseSync(path);
          change(db);
          db.close();
        },
      },
    });
    assert.equal(result.code, 1, result.stdout.join("\n"));
    assert.equal(result.stderr.length, 1);
    assert.match(result.stderr[0] ?? "", expected);
    assert.match(result.stderr[0] ?? "", /\(nothing written; backup kept at /);
    const after = dumpDatabase(env.dbPath);
    assert.ok(rows(after, "controls").has(FIXTURE_CONTROL_A));
    assert.ok(rows(after, "controls").has(FIXTURE_CONTROL_B));
    assert.equal(page(after, "1")["name"], "FIXTURE");
  }

  it("refuses a stray row added after the snapshot", async () => {
    await refuseAfterBackup(
      pageYaml(4),
      (db) =>
        setPage(db, "3", {
          id: "StrayPageIdAAAAAAAAAA",
          name: "STRAY",
          controls: {},
        }),
      /^error: page: pages row 3 exists but Companion does not load it/,
    );
  });

  it("refuses a shared control added after the snapshot", async () => {
    await refuseAfterBackup(
      PAGE_1_YAML,
      (db) =>
        setPage(db, "2", {
          id: "OtherPageIdAAAAAAAAAA",
          name: "OTHER",
          controls: { "0": { "0": FIXTURE_CONTROL_A } },
        }),
      /^error: page: control bank:FixtureCtrlAAAAAAAAAAA on page 1 is also on page 2/,
    );
  });

  it("refuses a non-bank: cell added after the snapshot", async () => {
    await refuseAfterBackup(
      PAGE_1_YAML,
      (db) => {
        const stored = readPage(db, "1");
        (stored["controls"] as Cells)["2"] = {
          "0": "trigger:LateTrigAAAAAAAAAAAAA",
        };
        setPage(db, "1", stored);
      },
      /^error: page: page 1, row 2, column 0 holds "trigger:LateTrigAAAAAAAAAAAAA", which is not a button control id/,
    );
  });
});
