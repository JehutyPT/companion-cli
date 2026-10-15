import type { DatabaseSync } from "node:sqlite";
import { parseStoredJson } from "../core/database.ts";
import { CheckError, CliError, ValidationError } from "../core/errors.ts";
import {
  BOOLEAN,
  field,
  type FieldSchema,
  integer,
  NON_EMPTY_STRING,
  ref,
  requiredField,
  STRING,
} from "../core/field-schema.ts";
import {
  describeType,
  expectBoolean,
  expectInteger,
  expectJsonValue,
  expectMapping,
  expectNonEmptyString,
  expectString,
  fieldPath,
  type Fields,
  isJsonObject,
  rejectUnknownFields,
  requireField,
} from "../core/validate.ts";
import type {
  ConfigField,
  ConfigFieldsOutcome,
  Writer,
  WriterContext,
} from "../core/writer.ts";
import { fieldValueProblem, jsonType } from "./connection.ts";
import {
  checkVariablesExist,
  customReferences,
  parseVariableName,
  plural,
  type VariableReference,
} from "./shared.ts";

/**
 * Surface writer: changes one stored surface's settings.
 *
 *   kind: surface
 *   surface: "skaarhoj:SK_RAWPANEL_123"   # the stored surface id
 *   name: Desk panel                      # optional
 *   enabled: true                         # optional
 *   brightness: 80                        # optional: brightness, rotation, xOffset, yOffset
 *   transferInputs: { hwc_12: sk_enc1 }   # config.transfer_input_<id>: a custom variable
 *   transferOutputs: { hwc_40: "…" }      # config.transfer_output_<id>: an expression
 *   plugin: { sleepTimer: 300 }           # config.plugin_cfg_<id>
 *   config: { emulator_rows: 4 }          # any other config key
 *
 * One `surfaces` row is changed: `name` and `enabled` when named, and the
 * named `config` keys, merged key by key. Every other key of the row and of
 * its `config` is kept, `groupConfig`, `groupId` and the identity fields
 * (`type`, `integrationType`, `gridSize`, `layout`) included. Surface rows
 * are never created. See docs/companion-internals.md, "Surfaces".
 *
 * Config keys other than Companion's own four are defined by the surface's
 * module, and Companion knows them only while the surface is connected. In
 * live-install mode `resolve` reads them over Companion's socket; `check`
 * then requires each named key to be a declared field of the right type.
 * Without them, only a key already stored may be set, and only to a value of
 * the same JSON type, unless `--unchecked` accepts it with a warning.
 */

export const FIELDS = [
  "surface",
  "name",
  "enabled",
  "brightness",
  "rotation",
  "xOffset",
  "yOffset",
  "transferInputs",
  "transferOutputs",
  "plugin",
  "config",
] as const;

/** Companion's own config keys, each a top-level description field. */
export const OWNED_KEYS = ["brightness", "rotation", "xOffset", "yOffset"];

/** `RotationConfigField`'s choice ids (`Surface/CommonConfigFields.ts`). */
export const ROTATIONS: readonly (string | number)[] = [
  0,
  "surface-90",
  "surface90",
  "surface180",
];

export const TRANSFER_INPUT_PREFIX = "transfer_input_";
export const TRANSFER_OUTPUT_PREFIX = "transfer_output_";
export const PLUGIN_PREFIX = "plugin_cfg_";

/** The config key groups with a named home, and that home. */
export const PREFIXED_HOMES = [
  [TRANSFER_INPUT_PREFIX, "transferInputs"],
  [TRANSFER_OUTPUT_PREFIX, "transferOutputs"],
  [PLUGIN_PREFIX, "plugin"],
] as const;

const NO_DEFINITIONS_HINT =
  "connect the surface and start Companion so its config fields can be read, or pass --unchecked";

export const FIELD_SCHEMAS: Record<(typeof FIELDS)[number], FieldSchema> = {
  surface: requiredField(
    "The stored surface id, exactly (`companion-cli list surfaces`). The surface must exist; surfaces are never created.",
    NON_EMPTY_STRING,
  ),
  name: field("The surface's name in Companion.", STRING),
  enabled: field("Whether Companion uses the surface.", BOOLEAN),
  brightness: field("Brightness in percent, 0 to 100 (`config.brightness`).", {
    type: "number",
    minimum: 0,
    maximum: 100,
  }),
  rotation: field(
    'Rotation (`config.rotation`): 0 (normal), "surface-90" (90 CCW), "surface90" (90 CW) or "surface180".',
    { enum: [...ROTATIONS] },
  ),
  xOffset: field(
    "Horizontal offset in the grid (`config.xOffset`).",
    integer(),
  ),
  yOffset: field("Vertical offset in the grid (`config.yOffset`).", integer()),
  transferInputs: field(
    'Transfer-variable inputs: `<id>: <custom variable>` sets `config.transfer_input_<id>`, the custom variable that receives the surface\'s value ("" for none). The variable must exist.',
    {
      type: "object",
      propertyNames: { minLength: 1 },
      additionalProperties: {
        anyOf: [ref("variableName"), { const: "" }],
      },
    },
  ),
  transferOutputs: field(
    "Transfer-variable outputs: `<id>: <expression>` sets `config.transfer_output_<id>`, the expression whose value is sent to the surface. Its `$(custom:…)` references are checked.",
    {
      type: "object",
      propertyNames: { minLength: 1 },
      additionalProperties: STRING,
    },
  ),
  plugin: field(
    "Surface-module settings: `<id>: <value>` sets `config.plugin_cfg_<id>`.",
    {
      type: "object",
      propertyNames: { minLength: 1 },
      additionalProperties: ref("jsonValue"),
    },
  ),
  config: field(
    "Any other config key, set as given. A key with a named field (brightness, rotation, xOffset, yOffset, transfer_input_*, transfer_output_*, plugin_cfg_*) or `groupId` is refused.",
    {
      type: "object",
      propertyNames: {
        minLength: 1,
        not: {
          anyOf: [
            { enum: [...OWNED_KEYS, "groupId"] },
            {
              pattern: `^(${PREFIXED_HOMES.map(([prefix]) => prefix).join("|")})`,
            },
          ],
        },
      },
      additionalProperties: ref("jsonValue"),
    },
  ),
};

/** What a surface file does: the kind's `description` in the schema. */
export const DOC =
  "Changes one stored surface's name, enabled flag and config keys. Named config keys are merged; every other key, the surface's group settings and the other surfaces are untouched.";

/** YAML examples of a surface file, as the schema shows them. */
export const EXAMPLES = [
  `kind: surface
surface: "skaarhoj:SK_RAWPANEL_123"
name: Desk panel
brightness: 80
transferInputs:
  hwc_12: skaarhoj_enc1
transferOutputs:
  hwc_40_led: "$(custom:tally_pgm) == 1"
plugin:
  sleepTimer: 300
`,
];

/** One config key the description sets. */
export interface ConfigSetting {
  key: string;
  value: unknown;
  /** The description field that sets it. */
  field: string;
}

export interface SurfacePlan {
  surface: string;
  name?: string;
  enabled?: boolean;
  /** The config keys to set, in file order. */
  settings: ConfigSetting[];
  /** Custom variables the settings name: transfer inputs and `$(custom:…)` in outputs. */
  references: VariableReference[];
  /** The surface's config fields, set by `resolve`. */
  definitions: ConfigFieldsOutcome;
  /** `--unchecked`, set by `resolve`. */
  unchecked: boolean;
}

const NOT_READ: ConfigFieldsOutcome = {
  available: false,
  reason: "its config fields were not read",
};

function parseBrightness(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  ) {
    throw new ValidationError(
      path,
      `must be a number from 0 to 100, got ${typeof value === "number" ? value : describeType(value)}`,
    );
  }
  return value;
}

function parseRotation(value: unknown, path: string): string | number {
  if (!ROTATIONS.includes(value as string | number)) {
    throw new ValidationError(
      path,
      `must be one of ${ROTATIONS.map((choice) => JSON.stringify(choice)).join(", ")}, got ${JSON.stringify(value) ?? describeType(value)}`,
    );
  }
  return value as string | number;
}

const OWNED_PARSERS: Record<string, (value: unknown, path: string) => unknown> =
  {
    brightness: parseBrightness,
    rotation: parseRotation,
    xOffset: expectInteger,
    yOffset: expectInteger,
  };

/** A mapping of non-empty keys to values, each parsed by `value`. */
function parseKeyed(
  fields: Fields,
  name: string,
  value: (item: unknown, path: string) => unknown,
): Array<{ id: string; value: unknown; path: string }> {
  if (!Object.hasOwn(fields, name)) return [];
  const mapping = expectMapping(fields[name], name);
  return Object.entries(mapping).map(([id, item]) => {
    const path = fieldPath(name, id);
    if (id === "") throw new ValidationError(path, "a key must not be empty");
    return { id, value: value(item, path), path };
  });
}

/** The named home of a raw config key, or undefined when it has none. */
function namedHome(key: string): string | undefined {
  if (OWNED_KEYS.includes(key)) return key;
  for (const [prefix, home] of PREFIXED_HOMES) {
    if (key.startsWith(prefix)) return `${home}.${key.slice(prefix.length)}`;
  }
  return undefined;
}

function jsonValue(value: unknown, path: string): unknown {
  expectJsonValue(value, path);
  return value;
}

export function parseSurface(fields: Fields): SurfacePlan {
  rejectUnknownFields(fields, FIELDS, "");
  const plan: SurfacePlan = {
    surface: expectNonEmptyString(
      requireField(fields, "surface", ""),
      "surface",
    ),
    settings: [],
    references: [],
    definitions: NOT_READ,
    unchecked: false,
  };
  if (Object.hasOwn(fields, "name"))
    plan.name = expectString(fields["name"], "name");
  if (Object.hasOwn(fields, "enabled"))
    plan.enabled = expectBoolean(fields["enabled"], "enabled");

  for (const key of OWNED_KEYS) {
    if (!Object.hasOwn(fields, key)) continue;
    const parse = OWNED_PARSERS[key] as (v: unknown, p: string) => unknown;
    plan.settings.push({ key, value: parse(fields[key], key), field: key });
  }
  for (const input of parseKeyed(fields, "transferInputs", (value, path) =>
    value === "" ? "" : parseVariableName(value, path),
  )) {
    plan.settings.push({
      key: TRANSFER_INPUT_PREFIX + input.id,
      value: input.value,
      field: input.path,
    });
    if (input.value !== "")
      plan.references.push({ field: input.path, name: input.value as string });
  }
  for (const output of parseKeyed(fields, "transferOutputs", expectString)) {
    plan.settings.push({
      key: TRANSFER_OUTPUT_PREFIX + output.id,
      value: output.value,
      field: output.path,
    });
    plan.references.push(
      ...customReferences(output.value as string, output.path),
    );
  }
  for (const setting of parseKeyed(fields, "plugin", jsonValue)) {
    plan.settings.push({
      key: PLUGIN_PREFIX + setting.id,
      value: setting.value,
      field: setting.path,
    });
  }
  for (const raw of parseKeyed(fields, "config", (value, path) => {
    const key = path.slice("config.".length);
    const home = namedHome(key);
    if (home !== undefined)
      throw new ValidationError(
        path,
        `has a named field: use ${home} instead of config.${key}`,
      );
    if (key === "groupId")
      throw new ValidationError(
        path,
        "surface groups are not supported (see docs/support-matrix.md, surface)",
      );
    return jsonValue(value, path);
  })) {
    plan.settings.push({ key: raw.id, value: raw.value, field: raw.path });
  }
  return plan;
}

/** A stored surface row, parsed. */
export interface StoredSurface {
  id: string;
  value: Fields;
  /** The stored `config`, or empty when there is none. */
  config: Fields;
}

/** Every stored surface row, by id order. Rows that are not JSON objects are skipped. */
export function readSurfaces(db: DatabaseSync): StoredSurface[] {
  return db
    .prepare("SELECT id, value FROM surfaces ORDER BY id")
    .all()
    .flatMap((row) => {
      const value = parseStoredJson(row["value"]);
      if (!isJsonObject(value)) return [];
      const config = value["config"];
      return [
        {
          id: String(row["id"]),
          value,
          config: isJsonObject(config) ? config : {},
        },
      ];
    });
}

/** The stored surface `id`, or `not_found`. */
export function readSurface(db: DatabaseSync, id: string): StoredSurface {
  const row = db.prepare("SELECT value FROM surfaces WHERE id = ?").get(id);
  if (row === undefined) {
    throw new CliError(`surface: no surface "${id}" in the database`, {
      code: "not_found",
      path: "surface",
      hint: "run companion-cli list surfaces",
    });
  }
  const value = parseStoredJson(row["value"]);
  if (!isJsonObject(value))
    throw new CheckError(
      "surface",
      `the stored surface "${id}" is ${describeType(value)}, not a JSON object`,
    );
  const config = value["config"];
  if (config !== undefined && !isJsonObject(config))
    throw new CheckError(
      "surface",
      `the stored surface "${id}" has a config that is ${describeType(config)}, not a mapping`,
    );
  return { id, value, config: config ?? {} };
}

/**
 * The stored value after the plan: what both apply and export build. Keys the
 * plan does not name are kept as stored.
 */
export function buildSurfaceRow(stored: Fields, plan: SurfacePlan): Fields {
  const built: Fields = { ...stored };
  if (plan.name !== undefined) built["name"] = plan.name;
  if (plan.enabled !== undefined) built["enabled"] = plan.enabled;
  if (plan.settings.length > 0 || Object.hasOwn(stored, "config")) {
    const config: Fields = isJsonObject(stored["config"])
      ? { ...stored["config"] }
      : {};
    for (const setting of plan.settings) config[setting.key] = setting.value;
    built["config"] = config;
  }
  return built;
}

/** The settings a definition must check: every key but Companion's own. */
function moduleSettings(plan: SurfacePlan): ConfigSetting[] {
  return plan.settings.filter((setting) => !OWNED_KEYS.includes(setting.key));
}

/**
 * The settings the strict rule cannot accept without definitions: not
 * stored, or stored with a value of another JSON type. `--unchecked` lets
 * them through. Companion's own keys have their own rules and are never in it.
 */
export function uncheckedKeys(
  config: Fields,
  plan: SurfacePlan,
): { path: string; reason: string }[] {
  return moduleSettings(plan).flatMap(({ key, value, field }) => {
    if (!Object.hasOwn(config, key))
      return [{ path: field, reason: `the stored config has no key "${key}"` }];
    if (jsonType(config[key]) !== jsonType(value))
      return [
        {
          path: field,
          reason: `the stored value is a ${jsonType(config[key])}, not a ${jsonType(value)}`,
        },
      ];
    return [];
  });
}

/**
 * Why the surface's field `definition` refuses `value`, if it does: the
 * surface-only field types first (`custom-variable` and `expression` hold a
 * string), then the input field types `kind: connection` checks.
 */
function surfaceValueProblem(
  definition: ConfigField,
  value: unknown,
): string | undefined {
  if (definition.type === "custom-variable" || definition.type === "expression")
    return typeof value === "string"
      ? undefined
      : `must be a string, got ${describeType(value)}`;
  return fieldValueProblem(definition, value, false);
}

function checkAgainstDefinitions(
  plan: SurfacePlan,
  definitions: readonly ConfigField[],
): void {
  for (const { key, value, field } of moduleSettings(plan)) {
    const definition = definitions.find((item) => item.id === key);
    if (!definition)
      throw new CheckError(field, `the surface has no config field "${key}"`, {
        hint: `its config fields: ${
          definitions.map((item) => item.id).join(", ") || "none"
        }`,
      });
    if (definition.type === "static-text")
      throw new CheckError(field, "is static text, which holds no value");
    const problem = surfaceValueProblem(definition, value);
    if (problem)
      throw new CheckError(
        field,
        `${problem} (${key}, a ${definition.type} field)`,
      );
  }
}

export function checkSurface(db: DatabaseSync, plan: SurfacePlan): void {
  const stored = readSurface(db, plan.surface);
  checkVariablesExist(db, plan.references);
  const { definitions } = plan;
  if (definitions.available) {
    checkAgainstDefinitions(plan, definitions.fields);
    return;
  }
  if (plan.unchecked) return;
  const [first] = uncheckedKeys(stored.config, plan);
  if (first)
    throw new CheckError(
      first.path,
      `cannot be checked without the surface's config fields (${definitions.reason}), and ${first.reason}`,
      { hint: NO_DEFINITIONS_HINT },
    );
}

/**
 * Reads the surface's config fields, once and before any quit, when the
 * file sets a key other than Companion's own, and warns about each setting
 * `--unchecked` lets through.
 */
async function resolveSurface(
  plan: SurfacePlan,
  context: WriterContext,
): Promise<SurfacePlan> {
  const resolved = { ...plan, unchecked: context.unchecked };
  if (moduleSettings(plan).length === 0) return resolved;
  const stored = context.read((db) => readSurface(db, plan.surface));
  const definitions = await context.surfaceConfigFields(plan.surface);
  if (!definitions.available && context.unchecked) {
    for (const key of uncheckedKeys(stored.config, plan))
      context.warn(
        `${key.path}: not checked (${definitions.reason}; ${key.reason})`,
      );
  }
  return { ...resolved, definitions };
}

function changes(plan: SurfacePlan): string[] {
  return [
    ...(plan.name !== undefined ? ["name"] : []),
    ...(plan.enabled !== undefined ? ["enabled"] : []),
    ...(plan.settings.length > 0
      ? [plural(plan.settings.length, "config key")]
      : []),
  ];
}

export function writeSurface(db: DatabaseSync, plan: SurfacePlan): string {
  const stored = readSurface(db, plan.surface);
  db.prepare("UPDATE surfaces SET value = ? WHERE id = ?").run(
    JSON.stringify(buildSurfaceRow(stored.value, plan)),
    plan.surface,
  );
  const changed = changes(plan);
  return `surface "${plan.surface}": ${changed.length > 0 ? `set ${changed.join(", ")}` : "nothing to set"}`;
}

export const surfaceWriter: Writer<SurfacePlan> = {
  kind: "surface",
  parse: parseSurface,
  resolve: resolveSurface,
  check: checkSurface,
  describe: (plan) => {
    const changed = changes(plan);
    return `surface "${plan.surface}"${changed.length > 0 ? ` (${changed.join(", ")})` : ""}`;
  },
  write: writeSurface,
};
