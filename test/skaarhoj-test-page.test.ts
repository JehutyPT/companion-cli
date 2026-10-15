/**
 * Acceptance (#10): the example files in examples/skaarhoj-test-page/, applied
 * unmodified to fixture copies, reproduce the Python prototype's SKAARHOJ test
 * page. The expected content is the prototype's page 20, captured once into
 * test/fixtures/skaarhoj-page20.json by test/skaarhoj-capture.test.ts (see
 * there for the command and the prototype's commit); the files target page 99,
 * so page 99 is compared with the captured page 20.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  FIXTURE_CONTROL_A,
  FIXTURE_CONTROL_B,
} from "./fixtures/companion-db.ts";
import {
  assertTablesUnchangedExcept,
  dumpDatabase,
  fileState,
  type FixtureEnv,
  ID,
  type Json,
  normaliseIds,
  page,
  rows,
  runCli,
  setup,
  type TableDump,
  writeDescription,
} from "./helpers.ts";
import {
  type Cells,
  type PageContent,
  pageContent,
  seededPageId,
  seedEmptyPages,
  SKAARHOJ_VARIABLES,
  widenGrid,
  withInternalChildren,
} from "./skaarhoj-fixture.ts";

const example = (name: string) =>
  fileURLToPath(
    new URL(`../examples/skaarhoj-test-page/${name}`, import.meta.url),
  );
const VARIABLES_FILE = example("variables.yaml");
const PAGE_FILE = example("page.yaml");

const CAPTURE = withInternalChildren(
  JSON.parse(
    readFileSync(
      new URL("./fixtures/skaarhoj-page20.json", import.meta.url),
      "utf8",
    ),
  ) as PageContent,
);

function apply(env: FixtureEnv, file: string) {
  return runCli(["apply", file, "--db", env.dbPath], {
    backupRoot: env.backupRoot,
    tmpdir: env.tmpdir,
  });
}

/** Applies the variables file, then the page file; both must succeed. */
async function applyBoth(env: FixtureEnv): Promise<string> {
  const variables = await apply(env, VARIABLES_FILE);
  assert.equal(variables.code, 0, variables.stderr.join("\n"));
  const pageRun = await apply(env, PAGE_FILE);
  assert.equal(pageRun.code, 0, pageRun.stderr.join("\n"));
  assert.deepEqual(pageRun.stderr, []);
  return pageRun.stdout[1] ?? "";
}

/** Standard fixture, grid widened to columns 0–16, pages 2 to 99 seeded empty. */
const seededFixture = () =>
  setup({}, (db) => {
    seedEmptyPages(db, 99);
    widenGrid(db);
  });

/** Page 99 equals the captured page 20 apart from the page's own id. */
function assertReproduced(after: TableDump): PageContent {
  const content = pageContent(after, "99", SKAARHOJ_VARIABLES);
  assert.deepEqual(content.controls, CAPTURE.controls);
  assert.equal(Object.keys(content.controls).length, 47);
  const { id: _capturedId, ...capturedPage } = CAPTURE.page;
  const { id: _id, ...reproducedPage } = content.page;
  assert.deepEqual(reproducedPage, capturedPage);
  assert.equal(content.page["name"], "SKAARHOJ TEST");
  assert.deepEqual(content.variables, CAPTURE.variables);
  return content;
}

/** Everything but page 99, its controls and the 12 variables is unchanged. */
function assertNothingElseChanged(before: TableDump, after: TableDump): void {
  assertTablesUnchangedExcept(
    before,
    after,
    "pages",
    "controls",
    "custom_variables",
  );
  const pagesBefore = rows(before, "pages");
  for (const [id, value] of pagesBefore) {
    if (id !== "99") assert.deepEqual(page(after, id), value, `page ${id}`);
  }
  const ownControls = new Set(
    Object.values(page(after, "99")["controls"] as Json).flatMap((columns) =>
      Object.values(columns as Record<string, string>),
    ),
  );
  const controlsAfter = rows(after, "controls");
  assert.equal(controlsAfter.size, rows(before, "controls").size + 47);
  for (const [id, value] of rows(before, "controls"))
    assert.deepEqual(controlsAfter.get(id), value, `control ${id}`);
  for (const id of controlsAfter.keys())
    assert.ok(
      rows(before, "controls").has(id) || ownControls.has(id),
      `control ${id} belongs to page 99`,
    );
  const variablesAfter = rows(after, "custom_variables");
  for (const [id, value] of rows(before, "custom_variables"))
    assert.deepEqual(variablesAfter.get(id), value, `variable ${id}`);
  assert.deepEqual(
    [...variablesAfter.keys()].filter(
      (id) => !rows(before, "custom_variables").has(id),
    ),
    [...SKAARHOJ_VARIABLES].sort(),
  );
}

describe("SKAARHOJ test page: the example files reproduce the prototype", () => {
  it("replaces an existing page 99 with the captured page 20's content", async () => {
    const env = seededFixture();
    const before = dumpDatabase(env.dbPath);
    const summary = await applyBoth(env);
    assert.equal(
      summary,
      'page 99 "SKAARHOJ TEST": replaced; deleted 0 controls, wrote 47 controls',
    );

    const after = dumpDatabase(env.dbPath);
    const content = assertReproduced(after);
    assert.equal(content.page["id"], seededPageId(99), "page 99 keeps its id");
    assertNothingElseChanged(before, after);
    assert.ok(rows(after, "controls").has(FIXTURE_CONTROL_A));
    assert.ok(rows(after, "controls").has(FIXTURE_CONTROL_B));
  });

  it("creates page 99 and the empty gap pages 2 to 98", async () => {
    const env = setup({}, widenGrid);
    const before = dumpDatabase(env.dbPath);
    const summary = await applyBoth(env);
    const gaps = Array.from({ length: 97 }, (_, i) => i + 2);
    assert.equal(
      summary,
      `page 99 "SKAARHOJ TEST": created; deleted 0 controls, wrote 47 controls; created 97 empty pages: ${gaps.join(", ")}`,
    );

    const after = dumpDatabase(env.dbPath);
    const content = assertReproduced(after);
    assert.match(String(content.page["id"]), ID);
    const pageIds = new Set([content.page["id"]]);
    assert.deepEqual(page(after, "1"), page(before, "1"));
    for (const number of gaps) {
      const gap = page(after, String(number));
      assert.deepEqual(gap, { id: gap["id"], name: "PAGE", controls: {} });
      assert.match(String(gap["id"]), ID);
      pageIds.add(gap["id"]);
    }
    pageIds.add(page(after, "1")["id"]);
    assert.equal(pageIds.size, 99, "page ids are distinct");
    assert.equal(rows(after, "pages").size, 99);
    assertNothingElseChanged(before, after);
  });

  it("is idempotent: a second apply of both files gives equal content with fresh ids", async () => {
    const env = seededFixture();
    await applyBoth(env);
    const once = dumpDatabase(env.dbPath);
    const summary = await applyBoth(env);
    assert.equal(
      summary,
      'page 99 "SKAARHOJ TEST": replaced; deleted 47 controls, wrote 47 controls',
    );
    const twice = dumpDatabase(env.dbPath);
    assert.deepEqual(normaliseIds(twice), normaliseIds(once));
    const controlsAfter = rows(twice, "controls");
    for (const id of rows(once, "controls").keys()) {
      if (id.startsWith("bank:Fixture")) continue;
      assert.equal(controlsAfter.has(id), false, `${id} deleted`);
    }
  });
});

describe("SKAARHOJ test page: refusals leave the database byte-identical", () => {
  async function refusePage(env: FixtureEnv, expected: RegExp) {
    const before = fileState(env.dbPath);
    const result = await apply(env, PAGE_FILE);
    assert.equal(result.code, 1, result.stdout.join("\n"));
    assert.equal(result.stderr.length, 1, result.stderr.join("\n"));
    assert.match(result.stderr[0] ?? "", expected);
    assert.deepEqual(fileState(env.dbPath), before);
  }

  it("refuses the page file on a grid of columns 0–7", async () => {
    const env = setup();
    const variables = await apply(env, VARIABLES_FILE);
    assert.equal(variables.code, 0, variables.stderr.join("\n"));
    await refusePage(
      env,
      /^error: buttons\[\d+\]\.location\.column: \d+ is outside the grid \(0\.\.7\)/,
    );
  });

  it("refuses the page file before the variables file", async () => {
    const env = setup({}, widenGrid);
    await refusePage(
      env,
      /^error: buttons\[\d+\]\.[\w.[\]]+: unknown custom variable "sk_/,
    );
    assert.equal(existsSync(env.backupRoot), false, "no backup for a refusal");
  });
});

/**
 * #44: page 99 holding the captured controls exactly as the prototype (and
 * every CLI before #23) stored them: internal actions without `children`.
 */
async function pre23Fixture(): Promise<FixtureEnv> {
  const env = seededFixture();
  await applyBoth(env);
  const raw = JSON.parse(
    readFileSync(
      new URL("./fixtures/skaarhoj-page20.json", import.meta.url),
      "utf8",
    ),
  ) as PageContent;
  const db = new DatabaseSync(env.dbPath);
  const stored = JSON.parse(
    String(
      db.prepare("SELECT value FROM pages WHERE id = '99'").get()?.["value"],
    ),
  ) as { controls: Cells };
  let next = 0;
  const freshId = () => `Pre23Id${String(next++).padStart(14, "0")}`;
  for (const [row, columns] of Object.entries(stored.controls)) {
    for (const [column, id] of Object.entries(columns)) {
      const value = JSON.stringify(raw.controls[`${row}/${column}`]).replaceAll(
        '"<id>"',
        () => JSON.stringify(freshId()),
      );
      db.prepare("UPDATE controls SET value = ? WHERE id = ?").run(value, id);
    }
  }
  db.close();
  return env;
}

function exportPage(env: FixtureEnv) {
  return runCli(["export", "page", "99", "--db", env.dbPath], {
    tmpdir: env.tmpdir,
  });
}

function dryRun(env: FixtureEnv, file: string) {
  return runCli(["apply", file, "--db", env.dbPath, "--dry-run"], {
    tmpdir: env.tmpdir,
  });
}

describe("SKAARHOJ test page: a page stored before #23 (internal actions without children)", () => {
  it("exports, and re-applying the export changes nothing an export can see", async () => {
    const env = await pre23Fixture();
    const exported = await exportPage(env);
    assert.equal(exported.code, 0, exported.stderr.join("\n"));
    const yaml = exported.stdout.map((line) => `${line}\n`).join("");
    const file = writeDescription(env.dir, yaml, "export.yaml");
    const dry = await dryRun(env, file);
    assert.equal(dry.code, 0, dry.stderr.join("\n"));
    assert.equal(dry.stdout[1], "no changes", dry.stdout.join("\n"));
    const applied = await apply(env, file);
    assert.equal(applied.code, 0, applied.stderr.join("\n"));
    const again = await exportPage(env);
    assert.deepEqual(again.stdout, exported.stdout);
  });

  it("dry-runs the example unchanged as no changes", async () => {
    const env = await pre23Fixture();
    const dry = await dryRun(env, PAGE_FILE);
    assert.equal(dry.code, 0, dry.stderr.join("\n"));
    assert.equal(dry.stdout[1], "no changes", dry.stdout.join("\n"));
  });

  it("dry-runs the example without apiStyle as 47 changed cells, naming canModifyStyleInApis", async () => {
    const env = await pre23Fixture();
    const file = writeDescription(
      env.dir,
      readFileSync(PAGE_FILE, "utf8").replaceAll(/^ *apiStyle: true\n/gm, ""),
      "no-api-style.yaml",
    );
    const dry = await dryRun(env, file);
    assert.equal(dry.code, 0, dry.stderr.join("\n"));
    assert.equal(dry.stdout[1], "controls: 47 added, 0 replaced, 47 removed");
    const cells = dry.stdout.filter((line) => line.startsWith("  ~ 99:"));
    assert.equal(cells.length, 1, dry.stdout.join("\n"));
    const changes = cells[0]?.split(", cell ") ?? [];
    assert.equal(changes.length, 47);
    for (const change of changes)
      assert.match(
        change,
        /bank:\S+ -> bank:\S+ \(changed: options\.canModifyStyleInApis\)$/,
      );
  });
});
