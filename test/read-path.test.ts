import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HELP, USAGE } from "../src/cli.ts";
import { loadDescription } from "../src/core/description.ts";
import { dryRun } from "../src/core/dry-run.ts";
import {
  CliError,
  ERROR_CODES,
  type ErrorCode,
  errorJson,
} from "../src/core/errors.ts";
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
  pathPattern,
  runCli,
  setup,
  tempDir,
  writeDescription,
} from "./helpers.ts";
import type { CliOptions } from "../src/cli.ts";
import type { DatabaseSync } from "node:sqlite";

interface ErrorDocument {
  error: {
    code: ErrorCode;
    message: string;
    path?: string;
    hint?: string;
  };
}

/** The one JSON error document a `--json` failure prints on stdout. */
function jsonError(result: CliRun): ErrorDocument {
  assert.deepEqual(result.stderr, [], "nothing on stderr");
  assert.equal(result.stdout.length, 1, "exactly one document");
  return JSON.parse(result.stdout[0] ?? "") as ErrorDocument;
}

/**
 * Runs `argv` with and without `--json` and checks the failure contract: one
 * stderr line without it, one JSON error document with it, the same exit
 * code, and the JSON message equal to the stderr line without `error: `.
 */
async function assertFailure(
  argv: string[],
  options: CliOptions,
  code: ErrorCode,
  exit: number,
  line: RegExp,
): Promise<ErrorDocument> {
  const text = await runCli(argv, options);
  assert.equal(text.code, exit, text.stderr.join("\n"));
  assert.deepEqual(text.stdout, []);
  assert.equal(text.stderr.length, 1);
  assert.match(text.stderr[0] ?? "", line);
  const json = await runCli([...argv, "--json"], options);
  assert.equal(json.code, exit);
  const document = jsonError(json);
  assert.equal(document.error.code, code);
  assert.equal(
    `error: ${document.error.message}`,
    text.stderr[0],
    "message is the stderr line",
  );
  return document;
}

const KINDS = ["variables", "triggers", "connections", "pages"];

describe("read path: failures", () => {
  const failures: Array<
    [
      string,
      FixtureOptions,
      ((db: DatabaseSync) => void) | undefined,
      ErrorCode,
      RegExp,
    ]
  > = [
    [
      "an unsupported DB version",
      { version: 16 },
      undefined,
      "unsupported_version",
      /^error: unsupported database: page_config_version is 16; only 17 \(Companion 5\.1\) is supported$/,
    ],
    [
      "an unsupported DB version written only in the WAL",
      { wal: true, walVersion: 18 },
      undefined,
      "unsupported_version",
      /^error: unsupported database: page_config_version is 18; only 17/,
    ],
    [
      "an inconsistent snapshot",
      {},
      corruptIndex,
      "snapshot_inconsistent",
      /^error: read: the database snapshot is inconsistent \(integrity check: .*never used.*\), perhaps copied while Companion was writing; nothing written\. Retry, or quit Companion and retry$/,
    ],
  ];
  for (const [name, fixture, change, code, line] of failures) {
    for (const kind of KINDS) {
      it(`list ${kind}: ${name}`, async () => {
        const env = setup(fixture, change);
        const before = fileState(env.dbPath);
        const { control, calls } = forbiddenProcessControl();
        const document = await assertFailure(
          ["list", kind, "--db", env.dbPath],
          { processControl: control, tmpdir: env.tmpdir },
          code,
          1,
          line,
        );
        assert.equal(typeof document.error.hint, "string");
        assert.deepEqual(calls, []);
        assert.deepEqual(fileState(env.dbPath), before);
        assert.deepEqual(readdirSync(env.tmpdir), []);
      });
    }
  }

  it("the version message is the one apply prints", async () => {
    const env = setup({ version: 16 });
    const file = writeDescription(
      env.dir,
      "kind: variables\nvariables:\n  - { name: fx_new, default: 1 }\n",
    );
    const applied = await runCli(["apply", file, "--db", env.dbPath]);
    const listed = await runCli(["list", "variables", "--db", env.dbPath]);
    assert.deepEqual(listed.stderr, applied.stderr);
  });

  it("a missing database", async () => {
    const dir = tempDir();
    const tmpdir = tempDir();
    const missing = join(dir, "nope.sqlite");
    const document = await assertFailure(
      ["list", "variables", "--db", missing],
      { tmpdir },
      "database_not_found",
      1,
      /^error: database not found: .*nope\.sqlite$/,
    );
    assert.match(document.error.hint ?? "", /--db/);
    assert.deepEqual(readdirSync(dir), [], "nothing created");
    assert.deepEqual(readdirSync(tmpdir), []);
  });

  it("an unreadable database", async () => {
    const dir = tempDir();
    const tmpdir = tempDir();
    const dbPath = join(dir, "db.sqlite");
    writeFileSync(dbPath, "not a database, just text");
    const before = fileState(dbPath);
    await assertFailure(
      ["list", "triggers", "--db", dbPath],
      { tmpdir },
      "database_unreadable",
      1,
      /^error: cannot read database .*db\.sqlite: file is not a database$/,
    );
    assert.deepEqual(fileState(dbPath), before);
    assert.deepEqual(readdirSync(dir), ["db.sqlite"], "no -wal or -shm");
    assert.deepEqual(readdirSync(tmpdir), []);
  });

  it("a temporary directory that cannot be created", async () => {
    const env = setup();
    await assertFailure(
      ["list", "variables", "--db", env.dbPath],
      { tmpdir: join(env.tmpdir, "missing") },
      "database_unreadable",
      1,
      /^error: cannot read database .*ENOENT/,
    );
  });

  it("live-install mode off macOS and Windows gives apply's refusal", async () => {
    const file = writeDescription(tempDir(), "kind: variables\n");
    const applied = await runCli(["apply", file], { platform: "linux" });
    const { control, calls } = forbiddenProcessControl();
    const document = await assertFailure(
      ["list", "variables"],
      { platform: "linux", processControl: control },
      "unsupported_platform",
      1,
      /^error: unsupported platform "linux": the local install is found on macOS and Windows only; pass --db with a database path$/,
    );
    assert.deepEqual([`error: ${document.error.message}`], applied.stderr);
    assert.equal(document.error.hint, "pass --db <path>");
    assert.deepEqual(calls, []);
  });
});

describe("read path: Companion's process", () => {
  it("live-install mode reads the install's database without touching the process", async () => {
    const home = tempDir();
    const dbPath = buildFixtureDb(installDir(home), { wal: true });
    const before = fileState(dbPath);
    const tmpdir = tempDir();
    const { control, calls } = forbiddenProcessControl();
    const result = await runCli(["list", "variables", "fx_wal_only"], {
      homedir: home,
      processControl: control,
      tmpdir,
    });
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(
      result.stdout[1],
      "fx_wal_only  1        -        no       WAL only",
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(fileState(dbPath), before);
    assert.deepEqual(readdirSync(tmpdir), []);
  });

  it("--db naming the install's database reads it while Companion runs", async () => {
    const home = tempDir();
    const dbPath = buildFixtureDb(installDir(home), { wal: true });
    const before = fileState(dbPath);
    const fake = fakeProcessControl({ running: true });
    for (const kind of KINDS) {
      const result = await runCli(
        [
          "list",
          kind,
          "--db",
          "~/" +
            join(
              "Library",
              "Application Support",
              "companion",
              "v5.1",
              "db.sqlite",
            ),
        ],
        { homedir: home, processControl: fake.control },
      );
      assert.equal(result.code, 0, result.stderr.join("\n"));
    }
    assert.deepEqual(fake.calls, [], "the running check is never made");
    assert.deepEqual(fileState(dbPath), before);
  });

  it("live-install mode with a missing database", async () => {
    const home = tempDir();
    const { control, calls } = forbiddenProcessControl();
    await assertFailure(
      ["list", "triggers"],
      { homedir: home, processControl: control },
      "database_not_found",
      1,
      new RegExp(
        `^error: database not found: .*${pathPattern("companion", "v5.1", "db.sqlite")} \\(from the default configuration folder\\)$`,
      ),
    );
    assert.deepEqual(calls, []);
  });
});

describe("read commands: command line", () => {
  const usageCases: Array<[string, string[], RegExp]> = [
    [
      "no kind",
      ["list"],
      /^list needs a kind \(variables or triggers or connections or pages or surfaces\)/,
    ],
    [
      "an unknown kind",
      ["list", "widgets"],
      /^unknown list kind "widgets" \(expected variables or triggers or connections or pages or surfaces\)/,
    ],
    [
      "an empty pattern",
      ["list", "variables", "fx_*", ""],
      /^a name pattern must not be empty/,
    ],
    ["an unknown option", ["list", "triggers", "--nope"], /--nope/],
    ["an empty --db", ["list", "triggers", "--db", ""], /^--db needs a path/],
  ];
  for (const [name, argv, reason] of usageCases) {
    it(`${name}: exit 2 with the usage line, as JSON with --json`, async () => {
      const text = await runCli(argv);
      assert.equal(text.code, 2);
      assert.deepEqual(text.stdout, []);
      assert.equal(text.stderr.length, 1);
      assert.match(text.stderr[0] ?? "", /^error: /);
      assert.match((text.stderr[0] ?? "").slice(7), reason);
      assert.ok(text.stderr[0]?.endsWith(`. ${USAGE}`));
      for (const json of [
        [...argv, "--json"],
        ["--json", ...argv],
      ]) {
        const result = await runCli(json);
        assert.equal(result.code, 2);
        const document = jsonError(result);
        assert.deepEqual(document, {
          error: {
            code: "usage",
            message: (text.stderr[0] ?? "").slice("error: ".length),
            hint: USAGE,
          },
        });
      }
    });
  }

  it("--help and -h print the help, which names the read commands", async () => {
    for (const flag of ["--help", "-h"]) {
      const result = await runCli(["list", "variables", flag]);
      assert.equal(result.code, 0);
      assert.deepEqual(result.stdout, [HELP]);
    }
    assert.match(
      USAGE,
      /list variables\|triggers\|connections\|pages\|surfaces \[<pattern>\.\.\.\] \[--db <path-to-db\.sqlite>\] \[--json\] \[--no-current\] \|/,
    );
    assert.match(
      HELP,
      /companion-cli list variables\|triggers\|connections\|pages\|surfaces/,
    );
    assert.match(HELP, /--no-current\s+skips this/);
    assert.match(HELP, /write nothing,\s+never stop or start Companion/);
  });

  it("options may come before the command", async () => {
    const env = setup();
    const result = await runCli([
      "--db",
      env.dbPath,
      "--json",
      "list",
      "variables",
      "fx_gap",
    ]);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(JSON.parse(result.stdout[0] ?? "").variables.length, 1);
  });

  it("--json after -- is a pattern, not the option", async () => {
    const env = setup();
    const result = await runCli([
      "list",
      "variables",
      "--db",
      env.dbPath,
      "--",
      "--json",
    ]);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.deepEqual(result.stdout, [
      "NAME  DEFAULT  CURRENT  PERSIST  DESCRIPTION",
      "note: current values are only read for the install's database",
    ]);
  });

  it("apply uses the same usage document under --json", async () => {
    const env = setup();
    const file = writeDescription(env.dir, "kind: variables\n");
    const result = await runCli(["apply", file, "extra", "--json"]);
    assert.equal(result.code, 2);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(JSON.parse(result.stdout[0] ?? ""), {
      error: {
        code: "usage",
        message: `apply takes exactly one description file. ${USAGE}`,
        hint: USAGE,
      },
    });
  });
});

describe("the JSON error envelope", () => {
  it("renders every detail, in order, and omits those that do not apply", () => {
    const error = new CliError("2 triggers cannot be exported", {
      code: "check_failed",
      path: "triggers[0].condition",
      hint: "run companion-cli list triggers",
      items: [
        {
          message: "condition is not supported",
          path: "triggers[0].condition",
        },
        { message: "notes are not supported", path: "triggers[3].notes" },
      ],
      committed: true,
      backup: "/backups/2026-10-15",
    });
    assert.equal(
      errorJson(error),
      JSON.stringify({
        error: {
          code: "check_failed",
          message: "2 triggers cannot be exported",
          path: "triggers[0].condition",
          hint: "run companion-cli list triggers",
          items: [
            {
              message: "condition is not supported",
              path: "triggers[0].condition",
            },
            { message: "notes are not supported", path: "triggers[3].notes" },
          ],
          committed: true,
          backup: "/backups/2026-10-15",
        },
      }),
    );
    assert.equal(
      errorJson(new CliError("no trigger named X", { code: "not_found" })),
      '{"error":{"code":"not_found","message":"no trigger named X"}}',
    );
  });

  it("uses only the first line of the message", () => {
    assert.equal(
      errorJson(new CliError("first\nsecond", { code: "not_found" })),
      '{"error":{"code":"not_found","message":"first"}}',
    );
  });

  it("an error that is not a CliError is unexpected", () => {
    assert.equal(
      errorJson(new TypeError("boom")),
      '{"error":{"code":"unexpected","message":"unexpected error: boom"}}',
    );
  });

  it("description errors are invalid_description, with the field path", () => {
    const dir = tempDir();
    const cases: Array<[string, string | undefined]> = [
      [
        "kind: variables\nvariables:\n  - { name: 'bad name', default: 1 }\n",
        "variables[0].name",
      ],
      ["kind: [unclosed\n", undefined],
    ];
    for (const [yaml, path] of cases) {
      const file = writeDescription(dir, yaml);
      let thrown: unknown;
      try {
        loadDescription(file, writers);
      } catch (error) {
        thrown = error;
      }
      const document = JSON.parse(errorJson(thrown)) as ErrorDocument;
      assert.equal(document.error.code, "invalid_description");
      assert.equal(document.error.path, path);
    }
    const missing = JSON.parse(
      errorJson(
        (() => {
          try {
            loadDescription(join(dir, "nope.yaml"), writers);
          } catch (error) {
            return error;
          }
          return undefined;
        })(),
      ),
    ) as ErrorDocument;
    assert.equal(missing.error.code, "invalid_description");
  });

  it("an unknown variable refused by a writer's check is check_failed", async () => {
    const env = setup();
    const file = writeDescription(
      env.dir,
      "kind: trigger\nname: T\nevents:\n  - { event: variable_changed, variable: nope }\n",
    );
    let thrown: unknown;
    try {
      await dryRun(
        { descriptionPath: file, dbPath: env.dbPath, writers },
        { tmpdir: env.tmpdir },
      );
    } catch (error) {
      thrown = error;
    }
    assert.deepEqual(JSON.parse(errorJson(thrown)), {
      error: {
        code: "check_failed",
        message: 'events[0].variable: unknown custom variable "nope"',
        path: "events[0].variable",
        hint: "run companion-cli list variables",
      },
    });
  });

  it("the README lists every error code", () => {
    const readme = readFileSync(
      new URL("../README.md", import.meta.url),
      "utf8",
    );
    for (const code of ERROR_CODES) {
      assert.match(readme, new RegExp(`^\\| \`${code}\` \\|`, "m"), code);
    }
  });
});
