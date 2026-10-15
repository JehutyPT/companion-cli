/**
 * `export page <n>` and `export page <n> --button <row>/<column>` (#19,
 * ADR 0006). The oracle is #18's round trip: every exported file, YAML and
 * JSON, applied to its own database reports no changes in a dry run, and a
 * real apply to a copy leaves it equal to the original but for generated ids.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { USAGE } from "../src/cli.ts";
import { SCHEMA_MODELINE } from "../src/schema.ts";
import { type Area, SUPPORT_MATRIX } from "../src/support-matrix.ts";
import { newId } from "../src/writers/ids.ts";
import { pageWriter } from "../src/writers/page.ts";
import {
  assertRefused,
  exportFrom,
  exportRoundTrip,
  insert,
  mutate,
} from "./export-helpers.ts";
import {
  FIXTURE_CONTROL_A,
  FIXTURE_CONTROL_B,
} from "./fixtures/companion-db.ts";
import { applyTo, type Json, runCli, setup } from "./helpers.ts";
import {
  type Cells,
  type PageContent,
  seedEmptyPages,
  SKAARHOJ_VARIABLES,
  widenGrid,
} from "./skaarhoj-fixture.ts";

describe("export page: the standard fixture", () => {
  it("exports page 1 as a kind: page file that round-trips", async () => {
    const env = setup();
    const yaml = await exportRoundTrip(env, ["page", "1"]);
    assert.equal(
      yaml,
      `${SCHEMA_MODELINE}
# companion-cli export: page (1)
kind: page
page: 1
name: FIXTURE
buttons:
  - location:
      row: 0
      column: 0
    text: "Count\\n$(custom:fx_counter)"
    background: "#000080"
    textColor: "#FFFFFF"
    down:
      - action: increment
        variable: fx_counter
  - location:
      row: 0
      column: 1
    text: $(custom:fx_label)
    background: "#202020"
    textColor: "#FFFFFF"
`,
    );
  });

  it("exports each of its buttons as a kind: button file that round-trips", async () => {
    const env = setup();
    const yaml = await exportRoundTrip(env, ["page", "1", "--button", "0/1"]);
    assert.equal(
      yaml,
      `${SCHEMA_MODELINE}
# companion-cli export: button (1)
kind: button
location:
  page: 1
  row: 0
  column: 1
text: $(custom:fx_label)
background: "#202020"
textColor: "#FFFFFF"
`,
    );
    await exportRoundTrip(env, ["page", "1", "--button", "0/0"]);
  });
});

/** The fixture with its grid widened to rows and columns -1 to 7. */
const widened = () =>
  setup({}, (db) => {
    const row = db
      .prepare("SELECT value FROM main WHERE id = 'userconfig'")
      .get();
    const userconfig = JSON.parse(String(row?.["value"])) as Json;
    userconfig["gridSize"] = {
      minRow: -1,
      maxRow: 3,
      minColumn: -1,
      maxColumn: 7,
    };
    db.prepare("UPDATE main SET value = ? WHERE id = 'userconfig'").run(
      JSON.stringify(userconfig),
    );
  });

const EVERY_FEATURE = `kind: page
page: 2
name: "Every # feature"
buttons:
  - location: { row: -1, column: -1 }
    text: |
      Line one
      Line "two" # not a comment
    background: "#FFFF00"
    textColor: "#123456"
    down:
      - { action: set, variable: fx_label, value: pressed }
      - { action: set, variable: fx_label, value: 7 }
      - { action: expression, variable: fx_counter, expression: "$(custom:fx_counter) * 2" }
      - { action: increment, variable: fx_counter, by: 5 }
      - { action: decrement, variable: fx_counter }
      - action: passthrough
        connection: FixtureConnectionAAAA
        definition: some_action
        options: { mode: 1, label: "x: y", list: [1, 2] }
      - { action: passthrough, connection: FixtureConnectionAAAA, definition: bare }
    up: [{ action: set, variable: fx_label, value: released }]
  - location: { row: 0, column: 0 }
    text: "true"
    background: "#000000"
    rotate_left: [{ action: decrement, variable: fx_counter }]
    rotate_right: [{ action: increment, variable: fx_counter }]
  - location: { row: 0, column: 1 }
    text: Rotary
    background: "#000000"
    rotate_left: []
  - location: { row: 1, column: 0 }
    text: Latch
    background: "#FF0000"
    steps:
      - down: [{ action: set, variable: fx_label, value: "on" }]
      - down: [{ action: set, variable: fx_label, value: "off" }]
    feedbacks:
      - { feedback: step, step: 2, style: { background: "#00FF00", text: "ON" } }
      - feedback: expression
        expression: "$(custom:fx_counter) > 10"
        style: { textColor: "#FF0000" }
        invert: true
      - feedback: passthrough
        connection: FixtureConnectionAAAA
        definition: some_feedback
        options: { input: 1 }
        style: { text: "LIVE\\nNOW" }
`;

/** The page writer's parse of a description file's text. */
function parsePageText(text: string) {
  const { kind: _kind, ...fields } = parse(text) as Json;
  return pageWriter.parse(fields);
}

describe("export page: a page apply wrote with every button feature", () => {
  async function written() {
    const env = widened();
    const applied = await applyTo(env, EVERY_FEATURE);
    assert.equal(applied.code, 0, applied.stderr.join("\n"));
    const empty = await applyTo(
      env,
      "kind: page\npage: 3\nname: Empty\nbuttons: []\n",
    );
    assert.equal(empty.code, 0, empty.stderr.join("\n"));
    return env;
  }

  it("round-trips, and parses as the file apply wrote it from", async () => {
    const env = await written();
    const yaml = await exportRoundTrip(env, ["page", "2"]);
    assert.deepEqual(parsePageText(yaml), parsePageText(EVERY_FEATURE));
    assert.match(yaml, /\n {4}text: "true"\n/);
    assert.match(yaml, /\n {4}rotate_left: \[\]\n/);
    assert.match(yaml, /\n {8}invert: true\n/);
  });

  it("round-trips each button as kind: button", async () => {
    const env = await written();
    for (const cell of ["-1/-1", "0/0", "0/1", "1/0"])
      await exportRoundTrip(env, ["page", "2", "--button", cell]);
  });

  it("round-trips an empty page as buttons: []", async () => {
    const env = await written();
    const yaml = await exportRoundTrip(env, ["page", "3"]);
    assert.match(yaml, /\nname: Empty\nbuttons: \[\]\n$/);
  });
});

const CAPTURE = JSON.parse(
  readFileSync(
    new URL("./fixtures/skaarhoj-page20.json", import.meta.url),
    "utf8",
  ),
) as PageContent & { page: Json & { controls: Cells } };

/** `value` with every `<id>` placeholder `id` or `overrideId` given a fresh id. */
function freshIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(freshIds);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      (key === "id" || key === "overrideId") && child === "<id>"
        ? newId()
        : freshIds(child),
    ]),
  );
}

/**
 * The prototype's page 20, as it wrote it: the standard fixture with pages
 * 2–20 seeded, the grid widened, the 12 variables, and the captured page row
 * and 47 controls with fresh ids.
 */
const skaarhojFixture = () =>
  setup({}, (db) => {
    seedEmptyPages(db, 20);
    widenGrid(db);
    const insert = (table: string, id: string, value: unknown) =>
      db
        .prepare(`INSERT INTO ${table} (id, value) VALUES (?, ?)`)
        .run(id, JSON.stringify(value));
    for (const name of SKAARHOJ_VARIABLES)
      insert("custom_variables", name, CAPTURE.variables[name]);
    const cells: Cells = {};
    for (const [row, columns] of Object.entries(CAPTURE.page.controls)) {
      cells[row] = {};
      for (const column of Object.keys(columns)) {
        const id = `bank:${newId()}`;
        cells[row][column] = id;
        insert("controls", id, freshIds(CAPTURE.controls[`${row}/${column}`]));
      }
    }
    db.prepare("UPDATE pages SET value = ? WHERE id = '20'").run(
      JSON.stringify({ ...CAPTURE.page, controls: cells }),
    );
  });

describe("export page: the prototype's SKAARHOJ page", () => {
  it("exports page 20, which round-trips and parses as the example file", async () => {
    const env = skaarhojFixture();
    const yaml = await exportRoundTrip(env, ["page", "20"]);
    const example = readFileSync(
      new URL("../examples/skaarhoj-test-page/page.yaml", import.meta.url),
      "utf8",
    ).replace(/^page: 99$/m, "page: 20");
    const exported = parsePageText(yaml);
    assert.equal(exported.buttons.length, 47);
    assert.deepEqual(exported, parsePageText(example));
  });

  it("exports a display, an encoder and the S9 latch as kind: button", async () => {
    const env = skaarhojFixture();
    for (const cell of ["0/0", "0/3", "1/13"])
      await exportRoundTrip(env, ["page", "20", "--button", cell]);
  });
});

const A = FIXTURE_CONTROL_A;
const B = FIXTURE_CONTROL_B;
const layerList = (control: Json) =>
  (control["style"] as Json)["layers"] as Json[];
const downList = (control: Json) =>
  (((control["steps"] as Json)["0"] as Json)["action_sets"] as Json)[
    "down"
  ] as Json[];
const literal = (value: unknown) => ({ value, isExpression: false });

/** Changes control `id`'s stored value in place. */
const control =
  (id: string, change: (value: Json) => void) => (db: DatabaseSync) =>
    mutate(db, "controls", id, (value) => {
      change(value);
      return value;
    });

const withFeedback = (feedback: Json) =>
  control(A, (value) => {
    value["feedbacks"] = [
      {
        type: "feedback",
        id: "FixtureFeedbackAAAAAA",
        definitionId: "check_expression",
        connectionId: "internal",
        options: { expression: literal("1") },
        isInverted: literal(false),
        ...feedback,
      },
    ];
  });

interface RefusalCase {
  label: string;
  change: (db: DatabaseSync) => void;
  /** The refused cell, or undefined for the page itself. */
  cell?: string;
  /** The refused control id, named in the label once its control is read. */
  id?: string;
  reason: string;
  path: string;
  area: Area;
  /** The planned or unsupported matrix row the refusal points at. */
  item: string;
}

const REFUSALS: RefusalCase[] = [
  {
    label: "a page navigation control",
    change: control(A, (value) => {
      value["type"] = "pageup";
    }),
    cell: "0/0",
    id: A,
    reason:
      'type is "pageup": the cell holds a pageup control, which a description cannot express',
    path: "type",
    area: "control type",
    item: "pageup",
  },
  {
    label: "a changed font size",
    change: control(A, (value) => {
      (layerList(value)[3] as Json)["fontsize"] = literal(50);
    }),
    cell: "0/0",
    id: A,
    reason:
      "style.layers[3].fontsize.value is 50, which apply would store as 100",
    path: "style.layers[3].fontsize.value",
    area: "style",
    item: "other layer properties",
  },
  {
    label: "a fifth layer",
    change: control(A, (value) => {
      layerList(value).push({ id: "text1", type: "text" });
    }),
    cell: "0/0",
    id: A,
    reason: "style.layers has 5 entries, where apply would store 4",
    path: "style.layers",
    area: "style",
    item: "extra layers",
  },
  {
    label: "an image",
    change: control(A, (value) => {
      (layerList(value)[2] as Json)["base64Image"] = literal(
        "data:image/png;base64,AA",
      );
    }),
    cell: "0/0",
    id: A,
    reason:
      'style.layers[2].base64Image.value is "data:image/png;base64,AA", which apply would store as null',
    path: "style.layers[2].base64Image.value",
    area: "style",
    item: "images",
  },
  {
    label: "manual step progression",
    change: control(A, (value) => {
      (value["options"] as Json)["stepProgression"] = "manual";
    }),
    cell: "0/0",
    id: A,
    reason:
      'options.stepProgression is "manual", which apply would store as "auto"',
    path: "options.stepProgression",
    area: "button option",
    item: 'options.stepProgression = "manual"',
  },
  {
    label: "notes",
    change: control(A, (value) => {
      (value["options"] as Json)["notes"] = "hi";
    }),
    cell: "0/0",
    id: A,
    reason: 'options.notes is "hi", which apply would store as ""',
    path: "options.notes",
    area: "button option",
    item: "options.notes",
  },
  {
    label: "canModifyStyleInApis false",
    change: control(A, (value) => {
      (value["options"] as Json)["canModifyStyleInApis"] = false;
    }),
    cell: "0/0",
    id: A,
    reason:
      "options.canModifyStyleInApis is false, which apply would store as true",
    path: "options.canModifyStyleInApis",
    area: "button option",
    item: "options.canModifyStyleInApis",
  },
  {
    label: "rotate actions with rotaryActions false",
    change: control(A, (value) => {
      const sets = ((value["steps"] as Json)["0"] as Json)[
        "action_sets"
      ] as Json;
      sets["rotate_left"] = sets["down"];
      sets["down"] = [];
    }),
    cell: "0/0",
    id: A,
    reason:
      "steps.0.action_sets.rotate_left lists actions while options.rotaryActions is false, which a description cannot express",
    path: "steps.0.action_sets.rotate_left",
    area: "button option",
    item: "options.rotaryActions = false with rotate actions",
  },
  {
    label: "a feedback without style overrides",
    change: withFeedback({ styleOverrides: [] }),
    cell: "0/0",
    id: A,
    reason:
      "feedbacks[0].styleOverrides is empty; a feedback that overrides no style is not supported",
    path: "feedbacks[0].styleOverrides",
    area: "feedback",
    item: "feedback.styleOverrides (empty)",
  },
  {
    label: "an override of another property",
    change: withFeedback({
      styleOverrides: [
        {
          overrideId: "FixtureOverrideAAAAAA",
          elementId: "text0",
          elementProperty: "fontsize",
          override: literal(50),
        },
      ],
    }),
    cell: "0/0",
    id: A,
    reason:
      "feedbacks[0].styleOverrides[0] overrides text0.fontsize; only box0.color, text0.color and text0.text are supported",
    path: "feedbacks[0].styleOverrides[0]",
    area: "feedback",
    item: "feedback.styleOverrides (other element properties)",
  },
  {
    label: "an advanced feedback",
    change: withFeedback({
      definitionId: "some_feedback",
      connectionId: "FixtureConnectionAAAA",
      options: {},
      isInverted: undefined,
    }),
    cell: "0/0",
    id: A,
    reason:
      "feedbacks[0].styleOverrides is missing; only boolean feedbacks, which override style, are supported",
    path: "feedbacks[0].styleOverrides",
    area: "feedback",
    item: 'feedbackType = "advanced"',
  },
  {
    label: "a disabled action",
    change: control(A, (value) => {
      (downList(value)[0] as Json)["disabled"] = true;
    }),
    cell: "0/0",
    id: A,
    reason:
      "steps.0.action_sets.down[0].disabled is set, which the description format does not support yet",
    path: "steps.0.action_sets.down[0].disabled",
    area: "action",
    item: "action.disabled",
  },
  {
    label: "an expression option on a module action",
    change: control(A, (value) => {
      downList(value).push({
        type: "action",
        id: "FixtureActionBBBBBBBB",
        definitionId: "some_action",
        connectionId: "FixtureConnectionAAAA",
        options: { path: { value: "$(custom:fx_label)", isExpression: true } },
      });
    }),
    cell: "0/0",
    id: A,
    reason:
      "steps.0.action_sets.down[1].options.path is an expression, which the description format supports only in set, expression, increment and decrement actions",
    path: "steps.0.action_sets.down[1].options.path",
    area: "action",
    item: "action.options (expression values)",
  },
  {
    label: "a text ending in a stored line break",
    change: control(B, (value) => {
      (layerList(value)[3] as Json)["text"] = literal("abc\\n");
    }),
    cell: "0/1",
    id: B,
    reason:
      "style.layers[3].text.value ends in a line break (\\n), which a description cannot keep: apply drops one trailing line break",
    path: "style.layers[3].text.value",
    area: "style",
    item: "text0.text (trailing or raw line break)",
  },
  {
    label: "a text holding a line-feed character",
    change: control(B, (value) => {
      (layerList(value)[3] as Json)["text"] = literal("a\nb");
    }),
    cell: "0/1",
    id: B,
    reason:
      "style.layers[3].text.value holds a line-feed character, which apply would store as a line break (\\n)",
    path: "style.layers[3].text.value",
    area: "style",
    item: "text0.text (trailing or raw line break)",
  },
  {
    label: "a cell whose control has no row",
    change: (db) => db.prepare("DELETE FROM controls WHERE id = ?").run(A),
    cell: "0/0",
    reason: `controls.0.0 is ${A}, which has no controls row`,
    path: "controls.0.0",
    area: "page",
    item: "pages.controls (missing, shared, null or non-button cells)",
  },
  {
    label: "a control another page also holds",
    change: (db) =>
      insert(db, "pages", "2", {
        name: "Two",
        controls: { "0": { "0": A } },
        id: "FixturePageIdBBBBBBBB",
      }),
    cell: "0/0",
    reason: `controls.0.0 is ${A}, which page 2 also holds; apply refuses to delete a shared control`,
    path: "controls.0.0",
    area: "page",
    item: "pages.controls (missing, shared, null or non-button cells)",
  },
  {
    label: "a null cell",
    change: (db) =>
      mutate(db, "pages", "1", (value) => ({
        ...value,
        controls: { "0": { "0": null, "1": B } },
      })),
    cell: "0/0",
    reason: "controls.0.0 is null, which apply would not store",
    path: "controls.0.0",
    area: "page",
    item: "pages.controls (missing, shared, null or non-button cells)",
  },
  {
    label: "an empty page name",
    change: (db) =>
      mutate(db, "pages", "1", (value) => ({ ...value, name: "" })),
    reason: "name is empty; a page description needs a non-empty name",
    path: "name",
    area: "page",
    item: "pages.name (empty or missing)",
  },
];

describe("export page: refusals", () => {
  for (const { label, change, cell, id, reason, path, area } of REFUSALS) {
    it(`refuses ${label}`, async () => {
      const env = setup({}, change);
      const [row, column] = (cell ?? "").split("/");
      const where =
        cell === undefined
          ? "page 1"
          : `page 1, row ${row}, column ${column}${id ? ` (${id})` : ""}`;
      const line = `cannot export ${where}: ${reason} (see docs/support-matrix.md, ${area})`;
      const hint = `see docs/support-matrix.md (${area})`;
      const error = await assertRefused(env, ["page", "1"], line, path, hint);
      assert.equal(error.code, "export_unsupported");
      assert.equal(error.items, undefined);
      if (id !== undefined)
        await assertRefused(
          env,
          ["page", "1", "--button", cell as string],
          line,
          path,
          hint,
        );
    });
  }

  it("maps every refusal to a planned or unsupported matrix row in its area", () => {
    for (const { label, area, item } of REFUSALS) {
      const row = SUPPORT_MATRIX.find(
        (entry) => entry.area === area && entry.item === item,
      );
      assert.ok(row, `${label}: no ${area} row ${item}`);
      assert.notEqual(row.status, "supported", label);
    }
  });

  it("names every refused part of a page in one error", async () => {
    const env = setup({}, (db) => {
      mutate(db, "pages", "1", (value) => ({ ...value, name: "" }));
      db.prepare("DELETE FROM controls WHERE id = ?").run(A);
      control(B, (value) => {
        (value["options"] as Json)["notes"] = "n";
      })(db);
    });
    const line =
      "cannot export page 1, 3 refusals: name (name); row 0, column 0 (controls.0.0); row 0, column 1 (options.notes)";
    const text = await exportFrom(env, ["page", "1"]);
    assert.equal(text.code, 1);
    assert.deepEqual(text.stdout, []);
    assert.deepEqual(text.stderr, [`error: ${line}`]);
    const json = await exportFrom(env, ["page", "1", "--json"]);
    assert.equal(json.code, 1);
    assert.deepEqual(JSON.parse(json.stdout[0] as string).error, {
      code: "export_unsupported",
      message: line,
      path: "name",
      hint: "see docs/support-matrix.md (page)",
      items: [
        {
          message:
            "cannot export page 1: name is empty; a page description needs a non-empty name (see docs/support-matrix.md, page)",
          path: "name",
        },
        {
          message: `cannot export page 1, row 0, column 0: controls.0.0 is ${A}, which has no controls row (see docs/support-matrix.md, page)`,
          path: "controls.0.0",
        },
        {
          message: `cannot export page 1, row 0, column 1 (${B}): options.notes is "n", which apply would store as "" (see docs/support-matrix.md, button option)`,
          path: "options.notes",
        },
      ],
    });
  });

  it("refuses, as apply's check would, a text naming a variable that no longer exists", async () => {
    const env = setup({}, (db) =>
      db.prepare("DELETE FROM custom_variables WHERE id = 'fx_counter'").run(),
    );
    const cases: [string[], string, string][] = [
      [
        ["page", "1"],
        `cannot export page 1: controls.0.0 fails apply's check: unknown custom variable "fx_counter"`,
        "controls.0.0",
      ],
      [
        ["page", "1", "--button", "0/0"],
        `cannot export page 1, row 0, column 0 (${A}): style.layers[3].text.value fails apply's check: unknown custom variable "fx_counter"`,
        "style.layers[3].text.value",
      ],
    ];
    for (const [args, message, path] of cases) {
      const error = await assertRefused(env, args, message, path);
      assert.equal(error.code, "check_failed");
    }
  });

  it("lists at most ten refused parts, then counts the rest", async () => {
    const env = setup({}, (db) => {
      const controls: Record<string, Json> = { "0": {}, "1": {} };
      for (let column = 0; column < 8; column++)
        for (const row of ["0", "1"])
          (controls[row] as Json)[String(column)] =
            `bank:FixtureMissing${row}${column}AAAAA`;
      mutate(db, "pages", "1", (value) => ({ ...value, controls }));
    });
    const text = await exportFrom(env, ["page", "1"]);
    assert.equal(text.code, 1);
    assert.match(
      text.stderr[0] as string,
      /^error: cannot export page 1, 16 refusals: row 0, column 0 \(controls\.0\.0\);( [^;]+;){9} and 6 more$/,
    );
  });
});

describe("export page: selection", () => {
  const cases: [string, (db: DatabaseSync) => void, string[], string][] = [
    ["a page that does not exist", () => {}, ["9"], "page 9 does not exist"],
    [
      "a page Companion does not load",
      (db) => insert(db, "pages", "3", { name: "Three", controls: {} }),
      ["3"],
      "page 3 is not loaded by Companion (pages 1 to 1 load)",
    ],
    [
      "an empty cell",
      () => {},
      ["1", "--button", "2/2"],
      "no control at page 1, row 2, column 2",
    ],
    [
      "a row outside the grid",
      () => {},
      ["1", "--button", "-1/0"],
      "row -1 is outside the grid (rows 0 to 3)",
    ],
    [
      "a column outside the grid",
      () => {},
      ["1", "--button", "0/8"],
      "column 8 is outside the grid (columns 0 to 7)",
    ],
  ];
  for (const [label, change, args, line] of cases) {
    it(`refuses ${label}`, async () => {
      const env = setup({}, change);
      const error = await assertRefused(
        env,
        ["page", ...args],
        line,
        undefined as unknown as string,
      );
      assert.equal(error.code, "not_found");
    });
  }
});

describe("export page command line", () => {
  const PAGE = "export page takes one page number, at least 1";
  const cases: [string[], string][] = [
    [["export", "page"], PAGE],
    [["export", "page", "0"], PAGE],
    [["export", "page", "1.5"], PAGE],
    [["export", "page", "1", "2"], PAGE],
    [
      ["export", "page", "1", "--button", "3"],
      '--button takes <row>/<column>, for example 0/3 or -1/0; got "3"',
    ],
    [
      ["export", "page", "1", "--button", "a/b"],
      '--button takes <row>/<column>, for example 0/3 or -1/0; got "a/b"',
    ],
    [["export", "page", "1", "--button"], "--button needs a value"],
    [
      ["export", "page", "1", "--button", "--no-current"],
      "--button needs a value",
    ],
    [
      ["export", "triggers", "--button", "0/0"],
      "--button is not valid with export triggers",
    ],
  ];
  for (const [args, reason] of cases) {
    it(`exits 2: ${args.join(" ")}`, async () => {
      const env = setup();
      const text = await runCli([...args, "--db", env.dbPath]);
      assert.equal(text.code, 2);
      assert.deepEqual(text.stdout, []);
      assert.deepEqual(text.stderr, [`error: ${reason}. ${USAGE}`]);
      const json = await runCli([...args, "--db", env.dbPath, "--json"]);
      assert.equal(json.code, 2);
      assert.equal(JSON.parse(json.stdout[0] as string).error.code, "usage");
    });
  }

  it("prints help naming export page and --button", async () => {
    const result = await runCli(["export", "--help"]);
    assert.equal(result.code, 0);
    assert.match(
      result.stdout.join("\n"),
      /export page <n> \[--button <row>\/<column>\]/,
    );
  });
});
