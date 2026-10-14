/**
 * The one-off capture of the Python prototype's SKAARHOJ test page (#10).
 * Skipped unless SKAARHOJ_CAPTURE=1; `npm test` never runs Python. The
 * reproduction tests read the committed result, test/fixtures/skaarhoj-page20.json.
 *
 * Recapture (only if the prototype changes, which it should not):
 *   SKAARHOJ_CAPTURE=1 node --test --no-warnings test/skaarhoj-capture.test.ts
 *
 * It runs `python3 -I reference/python-prototype/fill_page20.py <db>` on a
 * fixture copy in a temp directory: the standard fixture plus empty pages
 * 2–20 (the prototype hardcodes page 20 and needs its row) and a grid widened
 * to columns 0–16. The prototype is run, never edited.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { dumpDatabase, setup } from "./helpers.ts";
import {
  pageContent,
  seedEmptyPages,
  SKAARHOJ_VARIABLES,
  widenGrid,
} from "./skaarhoj-fixture.ts";

const PROTOTYPE = "reference/python-prototype/fill_page20.py";
const CAPTURE = new URL("./fixtures/skaarhoj-page20.json", import.meta.url);

it(
  "captures the prototype's page 20 from a fixture copy",
  { skip: process.env["SKAARHOJ_CAPTURE"] !== "1" },
  () => {
    const env = setup({}, (db) => {
      seedEmptyPages(db, 20);
      widenGrid(db);
    });
    const script = fileURLToPath(new URL(`../${PROTOTYPE}`, import.meta.url));
    const commit = execFileSync(
      "git",
      ["log", "-1", "--format=%H", "--", script],
      { encoding: "utf8" },
    ).trim();
    const output = execFileSync("python3", ["-I", script, env.dbPath], {
      encoding: "utf8",
    });
    assert.equal(
      output.trim(),
      "page 20: removed 0 old controls, wrote 47 controls and 12 custom variables",
    );
    const capture = {
      capturedFrom: {
        prototype: PROTOTYPE,
        commit,
        command: `python3 -I ${PROTOTYPE} <temp fixture copy>/db.sqlite`,
        by: "SKAARHOJ_CAPTURE=1 node --test --no-warnings test/skaarhoj-capture.test.ts",
        fixture:
          "standard fixture + empty pages 2-20 (fixed ids) + grid columns 0-16",
      },
      ...pageContent(dumpDatabase(env.dbPath), "20", SKAARHOJ_VARIABLES),
    };
    writeFileSync(CAPTURE, JSON.stringify(capture, null, 2) + "\n");
    console.log(`captured from ${env.dbPath}`);
  },
);
