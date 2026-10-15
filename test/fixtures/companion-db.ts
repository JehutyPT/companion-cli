/**
 * Builds Companion 5.1-shaped fixture databases for tests. No user or
 * production data: every row below is synthetic.
 *
 * Schema source: Companion 5.1.0's bundled server code,
 * /Applications/Companion.app/Contents/Resources/main.js, read only (never the
 * user's database). Every table is created by the same statement,
 * `CREATE TABLE IF NOT EXISTS <name> (id STRING UNIQUE, value STRING);`, and the
 * database is put in WAL mode (`journal_mode = WAL`). The table list is the
 * union of the literal CREATE TABLE statements and the `getTableView("<name>")`
 * calls in main.js, plus the default table `main`. `connections` is left out
 * because the version-17 upgrade renames it to `instances`; `cloud` is left out
 * because it belongs to the separate cache database. This list is derived from
 * main.js and not yet compared against a fresh 5.1 install.
 *
 * Values are stored as `JSON.stringify(value)`, as Companion's table views do.
 * Row shapes follow docs/companion-internals.md and the Python prototype.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

export const COMPANION_TABLES = [
  "main",
  "pages",
  "controls",
  "custom_variables",
  "custom_variable_collections",
  "instances",
  "connection_collections",
  "surfaces",
  "surface_groups",
  "surfaces_remote",
  "surfaces_remote_collections",
  "surface_instance_collections",
  "image_library",
  "image_library_collections",
  "trigger_collections",
  "expressionVariableCollections",
  "api_keys",
] as const;

export const FIXTURE_GRID_SIZE = {
  minColumn: 0,
  maxColumn: 7,
  minRow: 0,
  maxRow: 3,
};

/** Custom variables every fixture starts with. Note the gap in sortOrder. */
export const FIXTURE_VARIABLES = {
  fx_counter: {
    description: "Counter",
    defaultValue: 0,
    persistCurrentValue: false,
    sortOrder: 0,
  },
  fx_label: {
    description: "Label",
    defaultValue: "idle",
    persistCurrentValue: true,
    sortOrder: 1,
  },
  fx_gap: {
    description: "A custom variable",
    defaultValue: "",
    persistCurrentValue: false,
    sortOrder: 5,
  },
};

/** Only in the WAL file of the WAL variant (written after the last checkpoint). */
export const WAL_ONLY_VARIABLE = {
  name: "fx_wal_only",
  value: {
    description: "WAL only",
    defaultValue: 1,
    persistCurrentValue: false,
    sortOrder: 7,
  },
};

export interface FixtureOptions {
  /** `page_config_version` to store; `null` omits the row. Defaults to 17. */
  version?: number | null;
  /** Leave `-wal` and `-shm` files holding committed changes next to the database. */
  wal?: boolean;
  /** With `wal`, also change `page_config_version` to this value in the WAL only. */
  walVersion?: number;
}

const prop = (value: unknown) => ({ value, isExpression: false });

function layers(text: string, color: number) {
  const geometry = {
    enabled: prop(true),
    opacity: prop(100),
    x: prop(0),
    y: prop(0),
    width: prop(100),
    height: prop(100),
    rotation: prop(0),
  };
  return [
    {
      id: "canvas",
      name: "Canvas",
      usage: "auto",
      type: "canvas",
      decoration: prop("default"),
      showStatusIcons: prop("default"),
    },
    {
      id: "box0",
      name: "Background",
      usage: "auto",
      type: "box",
      ...geometry,
      color: prop(color),
      borderWidth: prop(0),
      borderColor: prop(0),
      borderPosition: prop("inside"),
      pinnedProperties: ["color"],
    },
    {
      id: "image0",
      name: "Image",
      usage: "auto",
      type: "image",
      ...geometry,
      base64Image: prop(null),
      halign: prop("center"),
      valign: prop("center"),
      fillMode: prop("fit"),
      pinnedProperties: ["base64Image", "halign", "valign"],
    },
    {
      id: "text0",
      name: "Text",
      usage: "auto",
      type: "text",
      ...geometry,
      text: prop(text),
      color: prop(0xffffff),
      halign: prop("center"),
      valign: prop("center"),
      fontsize: prop(100),
      fontsizeAllowShrink: prop(true),
      font: prop("companion-sans"),
      outlineColor: prop(4278190080),
      pinnedProperties: [
        "text",
        "fontsize",
        "fontsizeAllowShrink",
        "color",
        "halign",
        "valign",
      ],
    },
  ];
}

function button(text: string, color: number, down: unknown[] = []) {
  return {
    type: "button-layered",
    options: {
      stepProgression: "auto",
      stepExpression: "",
      rotaryActions: false,
      canModifyStyleInApis: true,
      notes: "",
    },
    localVariables: [],
    steps: {
      "0": {
        action_sets: { down, up: [], rotate_left: [], rotate_right: [] },
        options: { runWhileHeld: [] },
      },
    },
    feedbacks: [],
    style: { layers: layers(text, color) },
  };
}

export const FIXTURE_CONTROL_A = "bank:FixtureCtrlAAAAAAAAAAA";
export const FIXTURE_CONTROL_B = "bank:FixtureCtrlBBBBBBBBBBB";

function seedRows(version: number | null): Array<[string, string, unknown]> {
  const rows: Array<[string, string, unknown]> = [];
  if (version !== null) rows.push(["main", "page_config_version", version]);
  rows.push(
    ["main", "userconfig", { gridSize: FIXTURE_GRID_SIZE, setup_wizard: 0 }],
    [
      "pages",
      "1",
      {
        name: "FIXTURE",
        controls: { "0": { "0": FIXTURE_CONTROL_A, "1": FIXTURE_CONTROL_B } },
        id: "FixturePageIdAAAAAAAA",
      },
    ],
    [
      "controls",
      FIXTURE_CONTROL_A,
      button("Count\\n$(custom:fx_counter)", 0x000080, [
        {
          type: "action",
          id: "FixtureActionAAAAAAAA",
          definitionId: "custom_variable_set_value",
          connectionId: "internal",
          options: {
            name: prop("fx_counter"),
            value: { isExpression: true, value: "$(this:current) + 1" },
          },
          // Companion stores `children` on every internal entity (asEntityModel).
          children: {},
        },
      ]),
    ],
    ["controls", FIXTURE_CONTROL_B, button("$(custom:fx_label)", 0x202020)],
    [
      "surfaces",
      "fixture-surface",
      { config: { brightness: 100 }, groupConfig: {}, name: "Fixture surface" },
    ],
    [
      "instances",
      "FixtureConnectionAAAA",
      // `InstanceConfig` from shared-lib/lib/Model/Instance.ts in Companion
      // 5.1.0's main.js source map. `config` and `secrets` are placeholders.
      {
        moduleInstanceType: "connection",
        moduleId: "fixture-module",
        moduleVersionId: "1.0.0",
        label: "fixture",
        config: {},
        secrets: {},
        isFirstInit: false,
        lastUpgradeIndex: -1,
        enabled: false,
        sortOrder: 0,
        updatePolicy: "stable",
      },
    ],
  );
  for (const [name, value] of Object.entries(FIXTURE_VARIABLES))
    rows.push(["custom_variables", name, value]);
  return rows;
}

function insert(
  db: DatabaseSync,
  table: string,
  id: string,
  value: unknown,
): void {
  db.prepare(`INSERT INTO ${table} (id, value) VALUES (?, ?)`).run(
    id,
    JSON.stringify(value),
  );
}

/**
 * Creates `<dir>/db.sqlite` (and, with `wal: true`, its `-wal` and `-shm`
 * files) and returns the database path.
 */
export function buildFixtureDb(
  dir: string,
  options: FixtureOptions = {},
): string {
  const version = options.version === undefined ? 17 : options.version;
  mkdirSync(dir, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), "companion-cli-fixture-"));
  const stagingPath = join(staging, "db.sqlite");
  const dbPath = join(dir, "db.sqlite");
  try {
    const db = new DatabaseSync(stagingPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA wal_autocheckpoint = 0");
    for (const table of COMPANION_TABLES) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (id STRING UNIQUE, value STRING);`,
      );
    }
    db.exec("BEGIN");
    for (const [table, id, value] of seedRows(version))
      insert(db, table, id, value);
    db.exec("COMMIT");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    if (options.wal) {
      // Committed to the WAL only: the copy below must carry the WAL files to see it.
      insert(
        db,
        "custom_variables",
        WAL_ONLY_VARIABLE.name,
        WAL_ONLY_VARIABLE.value,
      );
      if (options.walVersion !== undefined) {
        db.prepare(
          "UPDATE main SET value = ? WHERE id = 'page_config_version'",
        ).run(JSON.stringify(options.walVersion));
      }
      // Copy while the connection is open, as if Companion had quit without a final checkpoint.
      for (const suffix of ["", "-wal", "-shm"])
        copyFileSync(stagingPath + suffix, dbPath + suffix);
      db.close();
    } else {
      db.close(); // Closing the last connection checkpoints and removes the WAL files.
      copyFileSync(stagingPath, dbPath);
    }
    if (
      options.wal &&
      !(existsSync(dbPath + "-wal") && existsSync(dbPath + "-shm"))
    ) {
      throw new Error("fixture: WAL files missing");
    }
    return dbPath;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
