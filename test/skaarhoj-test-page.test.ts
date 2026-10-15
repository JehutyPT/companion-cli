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
} from "./helpers.ts";
import {
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
