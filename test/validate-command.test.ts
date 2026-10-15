import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { HELP, USAGE } from "../src/cli.ts";
import { dryRun } from "../src/core/dry-run.ts";
import { errorJson } from "../src/core/errors.ts";
import { validate } from "../src/core/validate-command.ts";
import { writers } from "../src/writers/index.ts";
import {
  buildFixtureDb,
  type FixtureOptions,
} from "./fixtures/companion-db.ts";
import {
  type CliRun,
  corruptIndex,
  fakeProcessControl,
  fileState,
  forbiddenProcessControl,
  installDir,
  runCli,
  setup,
  tempDir,
  writeDescription,
} from "./helpers.ts";
import { seedEmptyPages, widenGrid } from "./skaarhoj-fixture.ts";

const example = (name: string) =>
  fileURLToPath(
    new URL(`../examples/skaarhoj-test-page/${name}`, import.meta.url),
  );
const VARIABLES_FILE = example("variables.yaml");
const PAGE_FILE = example("page.yaml");

const BUTTON_YAML = `kind: button
location: { page: 1, row: 0, column: 3 }
text: Hello
background: "#000080"
`;
const PAGE_YAML = `kind: page
page: 1
name: MAIN
buttons:
  - location: { row: 0, column: 0 }
    text: A
    background: "#FF0000"
  - location: { row: 1, column: 2 }
    text: B
    background: "#00FF00"
`;
const TRIGGER_YAML = `kind: trigger
name: Reset counter
events: [ { event: startup } ]
`;
const VARIABLES_YAML = `kind: variables
variables:
  - { name: fx_new, default: 1 }
  - { name: fx_other, default: "x" }
`;

function seedTrigger(db: DatabaseSync, id: string, name: string): void {
  db.prepare("INSERT INTO controls (id, value) VALUES (?, ?)").run(
    id,
    JSON.stringify({
      type: "trigger",
      options: { name, enabled: true, sortOrder: 0 },
      actions: [],
      condition: [],
      events: [],
      localVariables: [],
    }),
  );
}

function strayPage(db: DatabaseSync): void {
  db.prepare("INSERT INTO pages (id, value) VALUES (?, ?)").run(
    "3",
    JSON.stringify({
      id: "StrayPageIdAAAAAAAAAA",
      name: "STRAY",
      controls: {},
    }),
  );
}

interface Case {
  name: string;
  yaml: string;
  fixture?: FixtureOptions;
  change?: (db: DatabaseSync) => void;
  /** The database, unless it is the fixture's. */
  db?: (dir: string) => string;
  /** Refused by the description alone, so `--no-db` refuses it too. */
  structural: boolean;
  line: RegExp;
}

const CASES: Case[] = [
  {
    name: "bad YAML",
    yaml: "kind: [variables\n",
    structural: true,
    line: /^error: invalid YAML in /,
  },
  {
    name: "missing kind",
    yaml: "variables: []\n",
    structural: true,
    line: /kind: is required/,
  },
  {
    name: "unknown kind",
    yaml: "kind: nope\n",
    structural: true,
    line: /kind: unknown kind "nope"/,
  },
  {
    name: "unknown field",
    yaml: `${TRIGGER_YAML}colour: red\n`,
    structural: true,
    line: /colour/,
  },
  {
    name: "bad colour",
    yaml: BUTTON_YAML.replace("#000080", "#GG0000"),
    structural: true,
    line: /background/,
  },
  {
    name: "out-of-grid location",
    yaml: BUTTON_YAML.replace("column: 3", "column: 17"),
    structural: false,
    line: /^error: location\.column: 17 is outside the grid \(0\.\.7\)/,
  },
  {
    name: "out-of-grid page button",
    yaml: PAGE_YAML.replace("column: 2", "column: 17"),
    structural: false,
    line: /^error: buttons\[1\]\.location\.column: 17 is outside the grid \(0\.\.7\)/,
  },
  {
    name: "unknown custom variable",
    yaml: `${BUTTON_YAML}down: [ { action: set, variable: nope, value: 1 } ]\n`,
    structural: false,
    line: /^error: down\[0\]\.variable: unknown custom variable "nope"$/,
  },
  {
    name: "button on a missing page",
    yaml: BUTTON_YAML.replace("page: 1", "page: 2"),
    structural: false,
    line: /^error: location\.page: page 2 does not exist/,
  },
  {
    name: "ambiguous trigger name",
    yaml: TRIGGER_YAML,
    change: (db) => {
      seedTrigger(db, "trigger:FixtureTrigAAAAAAAAAA", "Reset counter");
      seedTrigger(db, "trigger:FixtureTrigBBBBBBBBBB", "Reset counter");
    },
    structural: false,
    line: /^error: name: 2 triggers with the same name "Reset counter"/,
  },
  {
    name: "stray page row",
    yaml: PAGE_YAML.replace("page: 1", "page: 4"),
    change: strayPage,
    structural: false,
    line: /^error: page: pages row 3 exists but Companion does not load it/,
  },
  {
    name: "unsupported DB version",
    yaml: VARIABLES_YAML,
    fixture: { version: 16 },
    structural: false,
    line: /^error: unsupported database: page_config_version is 16/,
  },
  {
    name: "missing database",
    yaml: VARIABLES_YAML,
    db: (dir) => join(dir, "nope.sqlite"),
    structural: false,
    line: /^error: database not found: .*nope\.sqlite$/,
  },
];

/** The one document a `--json` run prints on stdout. */
function jsonDocument(result: CliRun): Record<string, unknown> {
  assert.deepEqual(result.stderr, [], "nothing on stderr");
  assert.equal(result.stdout.length, 1, "exactly one document");
  return JSON.parse(result.stdout[0] ?? "") as Record<string, unknown>;
}

describe("validate: the same refusals as apply --dry-run", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const env = setup(c.fixture ?? {}, c.change);
      const dbPath = c.db ? c.db(env.dir) : env.dbPath;
      const file = writeDescription(env.dir, c.yaml);
      const before = fileState(dbPath);
      const { control, calls } = forbiddenProcessControl();
      const options = { tmpdir: env.tmpdir, processControl: control };

      const dry = await runCli(
        ["apply", file, "--db", dbPath, "--dry-run"],
        options,
      );
      const text = await runCli(["validate", file, "--db", dbPath], options);
      assert.equal(text.code, 1);
      assert.deepEqual(text.stdout, []);
      assert.equal(text.stderr.length, 1);
      assert.match(text.stderr[0] ?? "", c.line);
      assert.deepEqual(
        [text.code, text.stderr],
        [dry.code, dry.stderr],
        "same exit code and stderr line as the dry run",
      );

      let thrown: unknown;
      try {
        await dryRun({ descriptionPath: file, dbPath, writers }, options);
      } catch (error) {
        thrown = error;
      }
      const json = await runCli(
        ["validate", file, "--db", dbPath, "--json"],
        options,
      );
      assert.equal(json.code, 1);
      assert.deepEqual(json.stderr, []);
      assert.deepEqual(json.stdout, [errorJson(thrown)]);

      const noDb = await runCli(["validate", file, "--no-db"], options);
      if (c.structural) {
        assert.deepEqual([noDb.code, noDb.stderr], [1, text.stderr]);
        assert.deepEqual(noDb.stdout, []);
      } else {
        assert.equal(noDb.code, 0, noDb.stderr.join("\n"));
        assert.match(noDb.stdout[0] ?? "", /^valid: .*\(structure only;/);
      }

      assert.deepEqual(calls, []);
      assert.deepEqual(fileState(dbPath), before);
      assert.deepEqual(readdirSync(env.tmpdir), []);
    });
  }

  it("an invalid description path names the field in JSON", async () => {
    const env = setup();
    const file = writeDescription(
      env.dir,
      BUTTON_YAML.replace("column: 3", "column: 17"),
    );
    const document = jsonDocument(
      await runCli(["validate", file, "--db", env.dbPath, "--json"], {
        tmpdir: env.tmpdir,
      }),
    );
    assert.equal(
      (document["error"] as Record<string, unknown>)["message"],
      "location.column: 17 is outside the grid (0..7)",
    );
  });

  it("a snapshot that fails its integrity check gives the read path's message", async () => {
    const env = setup({}, corruptIndex);
    const file = writeDescription(env.dir, VARIABLES_YAML);
    const before = fileState(env.dbPath);
    const text = await runCli(["validate", file, "--db", env.dbPath], {
      tmpdir: env.tmpdir,
    });
    assert.equal(text.code, 1);
    assert.deepEqual(text.stdout, []);
    assert.match(
      text.stderr[0] ?? "",
      /^error: read: the database snapshot is inconsistent \(integrity check: /,
    );
    const json = jsonDocument(
      await runCli(["validate", file, "--db", env.dbPath, "--json"], {
        tmpdir: env.tmpdir,
      }),
    );
    assert.equal(
      (json["error"] as Record<string, unknown>)["code"],
      "snapshot_inconsistent",
    );
    assert.deepEqual(fileState(env.dbPath), before);
    assert.deepEqual(readdirSync(env.tmpdir), []);
  });

  it("live-install mode off macOS gives apply's refusal; --no-db works", async () => {
    const file = writeDescription(tempDir(), VARIABLES_YAML);
    const applied = await runCli(["apply", file, "--dry-run"], {
      platform: "linux",
    });
    const { control, calls } = forbiddenProcessControl();
    const options = { platform: "linux" as const, processControl: control };
    const text = await runCli(["validate", file], options);
    assert.equal(text.code, 1);
    assert.deepEqual(text.stderr, applied.stderr);
    assert.match(text.stderr[0] ?? "", /unsupported platform "linux"/);

    const noDb = await runCli(["validate", file, "--no-db"], {
      ...options,
      homedir: join(tempDir(), "no-such-home"),
    });
    assert.equal(noDb.code, 0, noDb.stderr.join("\n"));
    assert.deepEqual(noDb.stdout, [
      "valid: 2 custom variables (structure only; not checked against a database)",
    ]);
    assert.deepEqual(calls, []);
  });
});

describe("validate: valid files", () => {
  const valid: Array<[string, string, string, (db: DatabaseSync) => void]> = [
    ["variables", VARIABLES_YAML, "2 custom variables", () => {}],
    ["button", BUTTON_YAML, "button at page 1, row 0, column 3", () => {}],
    ["page", PAGE_YAML, 'page 1 "MAIN" (2 buttons)', () => {}],
    ["trigger", TRIGGER_YAML, 'trigger "Reset counter"', () => {}],
  ];
  for (const [kind, yaml, described, change] of valid) {
    it(`${kind}: text and JSON, with and without a database`, async () => {
      const env = setup({}, change);
      const file = writeDescription(env.dir, yaml);
      const before = fileState(env.dbPath);
      const { control, calls } = forbiddenProcessControl();
      const options = { tmpdir: env.tmpdir, processControl: control };

      const text = await runCli(
        ["validate", file, "--db", env.dbPath],
        options,
      );
      assert.equal(text.code, 0, text.stderr.join("\n"));
      assert.deepEqual(text.stderr, []);
      assert.deepEqual(text.stdout, [
        `valid: ${described} against ${env.dbPath}`,
      ]);

      const json = await runCli(
        ["validate", "--json", file, "--db", env.dbPath],
        options,
      );
      assert.equal(json.code, 0);
      assert.deepEqual(jsonDocument(json), {
        valid: true,
        kind,
        file,
        database: env.dbPath,
        databaseSource: null,
        checks: "database",
        warnings: [],
      });

      const noDb = await runCli(["validate", file, "--no-db"], options);
      assert.equal(noDb.code, 0);
      assert.deepEqual(noDb.stdout, [
        `valid: ${described} (structure only; not checked against a database)`,
      ]);
      const noDbJson = await runCli(
        ["validate", file, "--no-db", "--json"],
        options,
      );
      assert.deepEqual(jsonDocument(noDbJson), {
        valid: true,
        kind,
        file,
        database: null,
        databaseSource: null,
        checks: "structure",
        warnings: [],
      });

      assert.deepEqual(calls, []);
      assert.deepEqual(fileState(env.dbPath), before);
      assert.deepEqual(readdirSync(env.tmpdir), []);
    });
  }

  it("the SKAARHOJ examples validate with --no-db", async () => {
    const vars = await runCli(["validate", VARIABLES_FILE, "--no-db"]);
    assert.deepEqual(vars.stdout, [
      "valid: 12 custom variables (structure only; not checked against a database)",
    ]);
    const page = await runCli(["validate", PAGE_FILE, "--no-db"]);
    assert.deepEqual(page.stdout, [
      'valid: page 99 "SKAARHOJ TEST" (47 buttons) (structure only; not checked against a database)',
    ]);
  });

  it("the SKAARHOJ examples validate against a prepared fixture", async () => {
    const env = setup({}, (db) => {
      seedEmptyPages(db, 99);
      widenGrid(db);
    });
    const options = { tmpdir: env.tmpdir, backupRoot: env.backupRoot };
    const refused = await runCli(
      ["validate", PAGE_FILE, "--db", env.dbPath],
      options,
    );
    assert.equal(refused.code, 1);
    assert.match(refused.stderr[0] ?? "", /unknown custom variable "sk_/);

    const vars = await runCli(
      ["validate", VARIABLES_FILE, "--db", env.dbPath],
      options,
    );
    assert.equal(vars.code, 0, vars.stderr.join("\n"));
    const applied = await runCli(
      ["apply", VARIABLES_FILE, "--db", env.dbPath],
      options,
    );
    assert.equal(applied.code, 0, applied.stderr.join("\n"));

    const page = await runCli(
      ["validate", PAGE_FILE, "--db", env.dbPath],
      options,
    );
    assert.equal(page.code, 0, page.stderr.join("\n"));
    assert.deepEqual(page.stdout, [
      `valid: page 99 "SKAARHOJ TEST" (47 buttons) against ${env.dbPath}`,
    ]);
  });
});

describe("validate: Companion's process and the install's database", () => {
  it("live-install mode reads the install's database without touching the process", async () => {
    const home = tempDir();
    const dbPath = buildFixtureDb(installDir(home), { wal: true });
    const before = fileState(dbPath);
    const file = writeDescription(tempDir(), VARIABLES_YAML);
    const { control, calls } = forbiddenProcessControl();
    const result = await runCli(["validate", file], {
      homedir: home,
      processControl: control,
    });
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(result.stdout, [
      `valid: 2 custom variables against ${dbPath} (from the default configuration folder)`,
    ]);
    assert.deepEqual(calls, []);
    assert.deepEqual(fileState(dbPath), before);
  });

  it("--db naming the install's database validates while Companion runs", async () => {
    const home = tempDir();
    const dbPath = buildFixtureDb(installDir(home), { wal: true });
    const before = fileState(dbPath);
    const file = writeDescription(tempDir(), VARIABLES_YAML);
    const fake = fakeProcessControl({ running: true });
    const result = await runCli(
      [
        "validate",
        file,
        "--db",
        "~/Library/Application Support/companion/v5.1/db.sqlite",
      ],
      { homedir: home, processControl: fake.control },
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(fake.calls, [], "the running check is never made");
    assert.deepEqual(fileState(dbPath), before);
  });
});

describe("validate: command line", () => {
  const usageCases: Array<[string, string[], RegExp]> = [
    ["no file", ["validate"], /^validate takes exactly one description file/],
    [
      "an extra positional",
      ["validate", "a.yaml", "b.yaml"],
      /^validate takes exactly one description file/,
    ],
    [
      "--db with --no-db",
      ["validate", "a.yaml", "--db", "x.sqlite", "--no-db"],
      /^--db and --no-db cannot be combined/,
    ],
    ["an empty --db", ["validate", "a.yaml", "--db", ""], /^--db needs a path/],
    ["an unknown option", ["validate", "a.yaml", "--dry-run"], /--dry-run/],
  ];
  for (const [name, argv, reason] of usageCases) {
    it(`${name}: exit 2, as JSON with --json`, async () => {
      const text = await runCli(argv);
      assert.equal(text.code, 2);
      assert.deepEqual(text.stdout, []);
      assert.equal(text.stderr.length, 1);
      assert.match((text.stderr[0] ?? "").slice("error: ".length), reason);
      assert.ok(text.stderr[0]?.endsWith(`. ${USAGE}`));
      const json = await runCli([...argv, "--json"]);
      assert.equal(json.code, 2);
      assert.deepEqual(jsonDocument(json), {
        error: {
          code: "usage",
          message: (text.stderr[0] ?? "").slice("error: ".length),
          hint: USAGE,
        },
      });
    });
  }

  it("--help prints the help, which names validate", async () => {
    for (const flag of ["--help", "-h"]) {
      const result = await runCli(["validate", flag]);
      assert.equal(result.code, 0);
      assert.deepEqual(result.stdout, [HELP]);
    }
    assert.match(
      USAGE,
      /validate <description-file> \[--db <path-to-db\.sqlite> \| --no-db\] \[--json\]/,
    );
    assert.match(HELP, /validate checks a description file/);
  });
});

describe("validate: a writer check's own error", () => {
  it("is rethrown as it is, as the dry run would", async () => {
    const env = setup();
    const file = writeDescription(env.dir, "kind: variables\n");
    const bug = new Error("check exploded");
    const registry = {
      variables: {
        kind: "variables" as const,
        parse: () => null,
        check: () => {
          throw bug;
        },
        write: () => "",
      },
    };
    await assert.rejects(
      validate(
        {
          descriptionPath: file,
          dbPath: env.dbPath,
          noDb: false,
          writers: registry,
        },
        { tmpdir: env.tmpdir },
      ),
      (error) => error === bug,
    );
    assert.deepEqual(readdirSync(env.tmpdir), []);
  });
});
