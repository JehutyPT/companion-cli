/**
 * Shared by the `list connections` and `list pages` tests: a `list` run that
 * checks #12's read-only proof, and seeded connections and controls.
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  type CliRun,
  type FixtureEnv,
  fileState,
  forbiddenProcessControl,
  runCli,
} from "./helpers.ts";

/**
 * Runs `list <kind>` on the fixture and checks that it stayed read-only: no
 * process-control call, the target byte-identical, no temporary copy left.
 */
export async function listReadOnly(
  env: FixtureEnv,
  kind: string,
  args: string[] = [],
): Promise<CliRun> {
  const before = fileState(env.dbPath);
  const { control, calls } = forbiddenProcessControl();
  const result = await runCli(["list", kind, "--db", env.dbPath, ...args], {
    processControl: control,
    tmpdir: env.tmpdir,
  });
  assert.deepEqual(calls, [], "no process-control call");
  assert.deepEqual(fileState(env.dbPath), before, "target byte-identical");
  assert.deepEqual(readdirSync(env.tmpdir), [], "temporary copy removed");
  return result;
}

/** The stdout of a successful run with nothing on stderr. */
export function ok(result: CliRun): string[] {
  assert.equal(result.code, 0, result.stderr.join("\n"));
  assert.deepEqual(result.stderr, []);
  return result.stdout;
}

export function insert(
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

/** Strings that must never be printed: they sit in `config` and `secrets`. */
export const SECRETS = [
  "ALPHA-CONFIG-PASSWORD",
  "ALPHA-SECRET-TOKEN",
  "SURFACE-CONFIG-PASSWORD",
  "SURFACE-SECRET-TOKEN",
];

function connection(
  label: string,
  sortOrder: number,
  extra: Record<string, unknown> = {},
) {
  return {
    moduleInstanceType: "connection",
    moduleId: `${label}-module`,
    moduleVersionId: "2.1.0",
    label,
    config: {},
    secrets: {},
    isFirstInit: false,
    lastUpgradeIndex: 0,
    enabled: true,
    sortOrder,
    updatePolicy: "stable",
    ...extra,
  };
}

export const ALPHA = "ConnAlphaAAAAAAAAAAAA";
export const BETA = "ConnBetaAAAAAAAAAAAAA";
export const GAMMA = "ConnGammaAAAAAAAAAAAA";
export const DELTA = "ConnDeltaAAAAAAAAAAAA";
export const ECHO = "ConnEchoAAAAAAAAAAAAA";
export const UNUSED = "ConnUnusedAAAAAAAAAAA";
/** Two connections labelled `twin`: Z sorts first, by sortOrder. */
export const TWIN_Z = "ConnTwinZZZZZZZZZZZZZ";
export const TWIN_A = "ConnTwinAAAAAAAAAAAAA";
export const GHOST = "ConnGhostAAAAAAAAAAAA";
/** Dangling, and used only by the control on the unloaded page. */
export const UNPLACED_GHOST = "ConnGhostZZZZZZZZZZZZ";

function entity(connectionId: string, extra: Record<string, unknown> = {}) {
  return {
    type: "action",
    id: `Entity${connectionId}`,
    definitionId: "run",
    connectionId,
    options: {},
    ...extra,
  };
}

/** A minimal `button-layered` control; `steps` replaces the default step. */
export function button(
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "button-layered",
    options: { stepProgression: "auto", rotaryActions: true },
    localVariables: [],
    steps: {
      "0": {
        action_sets: { down: [], up: [], rotate_left: [], rotate_right: [] },
        options: { runWhileHeld: [] },
      },
    },
    feedbacks: [],
    style: {
      layers: [
        { id: "canvas", type: "canvas" },
        {
          id: "text0",
          type: "text",
          text: { value: text, isExpression: false },
        },
      ],
    },
    ...extra,
  };
}

/**
 * Connections and their uses: page 2 holds buttons using alpha (a pass-through
 * action in step 2's `rotate_right`), beta (a pass-through feedback and a
 * local variable), echo and
 * both `twin`s (only through `$(<label>:var)` text) and a dangling id; two
 * triggers use gamma (an action) and delta (a condition); a control on the
 * unloaded page 4 uses alpha and a second dangling id; a surface instance holds secrets.
 */
export function seedConnections(db: DatabaseSync): void {
  insert(
    db,
    "instances",
    ALPHA,
    connection("alpha", 2, {
      config: { host: "10.0.0.1", password: SECRETS[0] },
      secrets: { token: SECRETS[1] },
    }),
  );
  insert(
    db,
    "instances",
    BETA,
    connection("beta", 1, { moduleVersionId: null, enabled: false }),
  );
  insert(db, "instances", GAMMA, connection("gamma", 3));
  insert(db, "instances", DELTA, connection("delta", 4));
  insert(db, "instances", TWIN_A, connection("twin", 6));
  insert(db, "instances", TWIN_Z, connection("twin", 5));
  insert(db, "instances", ECHO, connection("echo", 7));
  insert(db, "instances", UNUSED, connection("unused", 8));
  insert(db, "instances", "SurfaceInstanceAAAAAA", {
    ...connection("surfacey", 0),
    moduleInstanceType: "surface",
    config: { password: SECRETS[2] },
    secrets: { token: SECRETS[3] },
  });

  const twoSteps = {
    "0": {
      action_sets: { down: [], up: [], rotate_left: [], rotate_right: [] },
      options: { runWhileHeld: [] },
    },
    "1": {
      action_sets: {
        down: [],
        up: [],
        rotate_left: [],
        rotate_right: [entity(ALPHA)],
      },
      options: { runWhileHeld: [] },
    },
  };
  insert(
    db,
    "controls",
    "bank:SeedAlphaAAAAAAAAAAAA",
    button("S1", { steps: twoSteps }),
  );
  insert(
    db,
    "controls",
    "bank:SeedBetaAAAAAAAAAAAAA",
    button("F", {
      feedbacks: [{ ...entity(BETA), type: "feedback" }],
      // A second reference: the control still counts once.
      localVariables: [{ ...entity(BETA), type: "feedback" }],
    }),
  );
  insert(
    db,
    "controls",
    "bank:SeedEchoAAAAAAAAAAAAA",
    button("$(echo:volume)\\n$(twin:x)"),
  );
  insert(
    db,
    "controls",
    "bank:SeedGhostAAAAAAAAAAAA",
    button("G", {
      steps: {
        "0": {
          action_sets: { down: [entity(GHOST)], up: [] },
          options: {},
        },
      },
    }),
  );
  insert(db, "pages", "2", {
    id: "SeedPageConnsAAAAAAAA",
    name: "CONNS",
    controls: {
      "0": {
        "0": "bank:SeedAlphaAAAAAAAAAAAA",
        "1": "bank:SeedBetaAAAAAAAAAAAAA",
        "2": "bank:SeedEchoAAAAAAAAAAAAA",
        "3": "bank:SeedGhostAAAAAAAAAAAA",
      },
    },
  });
  // Page 3 is missing, so Companion does not load page 4.
  insert(
    db,
    "controls",
    "bank:SeedStrayAAAAAAAAAAAA",
    button("stray", {
      steps: {
        "0": {
          action_sets: { down: [entity(ALPHA), entity(UNPLACED_GHOST)] },
          options: {},
        },
      },
    }),
  );
  insert(db, "pages", "4", {
    id: "SeedPageStrayAAAAAAAA",
    name: "STRAY",
    controls: { "0": { "0": "bank:SeedStrayAAAAAAAAAAAA" } },
  });
  insert(db, "controls", "trigger:SeedTrigGammaAAAAAAA", {
    type: "trigger",
    options: { name: "Uses gamma", enabled: true, sortOrder: 0 },
    actions: [entity(GAMMA)],
    condition: [],
    events: [],
  });
  insert(db, "controls", "trigger:SeedTrigDeltaAAAAAAA", {
    type: "trigger",
    options: { name: "Uses delta", enabled: true, sortOrder: 1 },
    actions: [],
    condition: [{ ...entity(DELTA), type: "feedback" }],
    events: [],
  });
}
