import type { DatabaseSync } from "node:sqlite";
import { parseStoredJson } from "../core/database.ts";
import { CheckError, CliError, ValidationError } from "../core/errors.ts";
import {
  BOOLEAN,
  field,
  type FieldSchema,
  NON_EMPTY_STRING,
  ref,
  requiredField,
  type SchemaFragment,
} from "../core/field-schema.ts";
import {
  describeType,
  expectBoolean,
  expectJsonValue,
  expectMapping,
  expectString,
  type Fields,
  fieldPath,
  isJsonObject,
  rejectUnknownFields,
  requireField,
} from "../core/validate.ts";
import type { ConfigField, Writer, WriterContext } from "../core/writer.ts";
import { readControls } from "../readers/store.ts";
import { plural } from "./shared.ts";

/**
 * Connection writer: edits one existing connection's label, enabled flag,
 * config and secrets.
 *
 *   kind: connection
 *   connection: atem            # required: its label, or id:<id>
 *   label: atem_main            # optional: renames it
 *   enabled: true               # optional
 *   config:                     # optional: merged into the stored config
 *     host: 10.0.0.5
 *   secrets:                    # optional: merged, values from the environment
 *     password: { env: ATEM_PASSWORD }
 *
 * Companion 5.1 stores a connection as an `instances` row whose value has
 * `moduleInstanceType: "connection"` (docs/companion-internals.md,
 * "Connections"). The writer replaces that one row: it keeps every stored key
 * and sets what the file names. `config` and `secrets` merge shallowly, as
 * Companion's own `setConnectionLabelAndConfig` does with its patches; a
 * config sets `isFirstInit: false`, as Companion does. Nothing can create or
 * delete a connection, change its module or version, or remove a config key.
 *
 * Secrets never appear in a file: each is `{env: NAME}` and its value comes
 * from the environment at apply time. No message, summary or report prints a
 * secret value.
 *
 * Config and secret keys are checked against the module's config fields,
 * which only the running Companion knows (REST API v2, `config-fields`).
 * Without them (Companion stopped, the connection disabled, REST not
 * configured, `--db`), a key must already be stored with a value of the same
 * JSON type; `--unchecked` accepts any key with a warning.
 */

/** A connection by label, or by id (`id:<id>`). */
export type ConnectionTarget =
  { by: "label"; value: string } | { by: "id"; value: string };

/** What `resolve` adds: environment values and the module's definitions. */
export interface ResolvedConnection {
  /** Each secret key's value, from the environment. Never printed. */
  secretValues: Readonly<Record<string, string>>;
  /** The module's config fields, when the running Companion gave them. */
  definitions: readonly ConfigField[] | undefined;
  /** Why there are no definitions, for refusals. */
  unavailableReason: string | undefined;
  /** `--unchecked`: keys no definition can check are accepted. */
  unchecked: boolean;
}

export interface ConnectionPlan {
  /** `connection` as written, for messages. */
  selector: string;
  target: ConnectionTarget;
  label?: string;
  enabled?: boolean;
  config?: Readonly<Record<string, unknown>>;
  /** Each secret key's environment variable. */
  secrets?: Readonly<Record<string, string>>;
  resolved?: ResolvedConnection;
}

export const FIELDS = [
  "connection",
  "label",
  "enabled",
  "config",
  "secrets",
] as const;

/** Names Companion refuses as a connection label (`isLabelValid`), in any case. */
export const RESERVED_LABELS = [
  "internal",
  "this",
  "local",
  "companion",
  "image",
  "custom",
  "expression",
  "page",
] as const;

/** Companion's `makeLabelSafe` leaves a label unchanged exactly when it matches this. */
export const LABEL_PATTERN = /^[\w-]+$/;
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `^(?:[iI][nN]…|…)$`: the reserved labels, case-insensitively, without a flag. */
const RESERVED_LABEL_PATTERN = `^(?:${RESERVED_LABELS.map((name) =>
  [...name].map((c) => `[${c}${c.toUpperCase()}]`).join(""),
).join("|")})$`;

const LABEL_SCHEMA: SchemaFragment = {
  type: "string",
  pattern: LABEL_PATTERN.source,
  not: { pattern: RESERVED_LABEL_PATTERN },
};

const NO_MORE_FIELDS = "Set at least one of label, enabled, config or secrets.";

export const FIELD_SCHEMAS: Record<(typeof FIELDS)[number], FieldSchema> = {
  connection: requiredField(
    "The connection to edit: its label, or `id:<id>` when several share a label.",
    NON_EMPTY_STRING,
  ),
  label: field(
    "A new label: letters, digits, _ and -, and not a name Companion reserves (internal, this, local, companion, image, custom, expression, page; in any case). A rename is refused while buttons or triggers reference the old label.",
    LABEL_SCHEMA,
  ),
  enabled: field("Whether Companion runs the connection.", BOOLEAN),
  config: field(
    "Config keys to set, merged into the stored config; other keys are kept. Checked against the module's config fields when Companion is running; otherwise each key must already be stored with the same type (or pass --unchecked).",
    { type: "object", additionalProperties: ref("jsonValue") },
  ),
  secrets: field(
    "Secret keys to set, merged into the stored secrets, each from an environment variable. Never a literal value.",
    {
      type: "object",
      additionalProperties: {
        description: "The environment variable holding the secret's value.",
        type: "object",
        properties: {
          env: {
            description: "An environment variable name.",
            type: "string",
            pattern: ENV_NAME_PATTERN.source,
          },
        },
        required: ["env"],
        additionalProperties: false,
      },
    },
  ),
};

/** The kind's object needs a field besides `connection`. */
export const EXTRA_SCHEMA: SchemaFragment = {
  $comment: `${NO_MORE_FIELDS} With kind and connection required and no other properties allowed, that is three properties.`,
  minProperties: 3,
};

/** What a connection file does: the kind's `description` in the schema. */
export const DOC =
  "Edits one existing connection: its label, enabled flag, config and secrets (from the environment). Config and secrets merge into what is stored; nothing else changes.";

/** YAML examples of a connection file, as the schema shows them. */
export const EXAMPLES = [
  `kind: connection
connection: atem
enabled: true
config:
  host: 10.0.0.5
  port: 9910
`,
  `kind: connection
connection: id:sQ8f2kdPq1
label: obs_main
secrets:
  password: { env: OBS_PASSWORD }
`,
];

/** Companion's `isLabelValid`: why `label` is refused, if it is. */
export function labelProblem(label: string): string | undefined {
  if (label === "") return "must not be empty";
  if (!LABEL_PATTERN.test(label))
    return "may hold only letters, digits, _ and -";
  if ((RESERVED_LABELS as readonly string[]).includes(label.toLowerCase()))
    return `"${label}" is reserved by Companion`;
  return undefined;
}

export function parseTarget(value: unknown, path: string): ConnectionTarget {
  const text = expectString(value, path);
  if (text === "") throw new ValidationError(path, "must not be empty");
  if (text.startsWith("id:")) {
    const id = text.slice(3);
    if (id === "")
      throw new ValidationError(path, "id: must be followed by an id");
    return { by: "id", value: id };
  }
  return { by: "label", value: text };
}

function parseSecrets(value: unknown): Record<string, string> {
  const secrets = expectMapping(value, "secrets");
  const parsed: Record<string, string> = {};
  for (const [key, item] of Object.entries(secrets)) {
    const path = fieldPath("secrets", key);
    // Never echo the value: it may be the secret itself.
    if (!isJsonObject(item) || !Object.hasOwn(item, "env"))
      throw new ValidationError(
        path,
        "a secret must be {env: NAME}, never a literal",
      );
    rejectUnknownFields(item, ["env"], path);
    const name = item["env"];
    if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name))
      throw new ValidationError(
        fieldPath(path, "env"),
        "must be an environment variable name (letters, digits and _, not starting with a digit)",
      );
    parsed[key] = name;
  }
  return parsed;
}

export function parseConnection(fields: Fields): ConnectionPlan {
  rejectUnknownFields(fields, FIELDS, "");
  const selector = expectString(
    requireField(fields, "connection", ""),
    "connection",
  );
  const plan: ConnectionPlan = {
    selector,
    target: parseTarget(selector, "connection"),
  };
  if (Object.hasOwn(fields, "label")) {
    const label = expectString(fields["label"], "label");
    const problem = labelProblem(label);
    if (problem) throw new ValidationError("label", problem);
    plan.label = label;
  }
  if (Object.hasOwn(fields, "enabled"))
    plan.enabled = expectBoolean(fields["enabled"], "enabled");
  if (Object.hasOwn(fields, "config")) {
    const config = expectMapping(fields["config"], "config");
    for (const [key, item] of Object.entries(config))
      expectJsonValue(item, fieldPath("config", key));
    plan.config = config;
  }
  if (Object.hasOwn(fields, "secrets"))
    plan.secrets = parseSecrets(fields["secrets"]);
  if (
    plan.label === undefined &&
    plan.enabled === undefined &&
    plan.config === undefined &&
    plan.secrets === undefined
  )
    throw new ValidationError(
      "",
      "set at least one of label, enabled, config or secrets",
    );
  return plan;
}

/** One stored connection row. */
export interface StoredConnectionRow {
  id: string;
  value: Fields;
  label: string;
}

/** Every `instances` row that is a connection, in id order. */
export function connectionRows(db: DatabaseSync): StoredConnectionRow[] {
  const rows: StoredConnectionRow[] = [];
  for (const row of db.prepare("SELECT id, value FROM instances").all()) {
    const value = parseStoredJson(row["value"]);
    if (!isJsonObject(value) || value["moduleInstanceType"] !== "connection")
      continue;
    const label = value["label"];
    rows.push({
      id: String(row["id"]),
      value,
      label: typeof label === "string" ? label : "",
    });
  }
  return rows;
}

const LIST_HINT = "run companion-cli list connections";

/** The connection `target` names. Throws `not_found` when none or several. */
export function findConnection(
  db: DatabaseSync,
  target: ConnectionTarget,
): StoredConnectionRow {
  const rows = connectionRows(db);
  if (target.by === "id") {
    const row = rows.find((candidate) => candidate.id === target.value);
    if (!row)
      throw new CliError(
        `connection: no connection with id "${target.value}"`,
        {
          code: "not_found",
          path: "connection",
          hint: LIST_HINT,
        },
      );
    return row;
  }
  const matches = rows.filter((row) => row.label === target.value);
  const [row] = matches;
  if (!row)
    throw new CliError(`connection: no connection labelled "${target.value}"`, {
      code: "not_found",
      path: "connection",
      hint: LIST_HINT,
    });
  if (matches.length > 1)
    throw new CliError(
      `connection: ${matches.length} connections are labelled "${target.value}" (${matches.map((match) => match.id).join(", ")}); name one as id:<id>`,
      { code: "not_found", path: "connection", hint: LIST_HINT },
    );
  return row;
}

/**
 * The ids of stored controls (buttons and triggers) that reference a
 * connection by `label`: a `$(<label>:` in any string, or a `variableId`
 * string starting `<label>:`. Companion rewrites these on its own rename;
 * a database write cannot, so a rename is refused while any exist.
 */
export function controlsReferencingLabel(
  db: DatabaseSync,
  label: string,
): string[] {
  const reference = `$(${label}:`;
  const prefix = `${label}:`;
  const ids: string[] = [];
  for (const [id, control] of readControls(db)) {
    let found = false;
    const visit = (value: unknown, key?: string): void => {
      if (found) return;
      if (typeof value === "string") {
        if (
          value.includes(reference) ||
          (key === "variableId" && value.startsWith(prefix))
        )
          found = true;
      } else if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else if (isJsonObject(value)) {
        for (const [childKey, child] of Object.entries(value))
          visit(child, childKey);
      }
    };
    visit(control);
    if (found) ids.push(id);
  }
  return ids.sort();
}

/** A `/body/flags` regex as such, otherwise a plain pattern; undefined when it does not compile. */
export function compileFieldRegex(source: string): RegExp | undefined {
  const literal = /^\/(.*)\/([a-z]*)$/s.exec(source);
  try {
    return literal
      ? new RegExp(literal[1] ?? "", literal[2])
      : new RegExp(source);
  } catch {
    return undefined;
  }
}

function regexOf(definition: ConfigField): string | undefined {
  const regex = definition["regex"];
  return typeof regex === "string" && regex !== "" ? regex : undefined;
}

/** The field's regex when `value` fails it; undefined when it passes, or the field has none that compiles. */
function failedPattern(
  definition: ConfigField,
  value: string,
): string | undefined {
  const source = regexOf(definition);
  const regex = source ? compileFieldRegex(source) : undefined;
  return regex && !regex.test(value) ? source : undefined;
}

/** The JSON type of a value, for the strict rule. */
export function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  return typeof value === "object" ? "mapping" : typeof value;
}

const numberProperty = (definition: ConfigField, key: string) => {
  const value = definition[key];
  return typeof value === "number" ? value : undefined;
};

function choiceIds(definition: ConfigField): unknown[] {
  const choices = definition["choices"];
  return Array.isArray(choices)
    ? choices.flatMap((choice) => (isJsonObject(choice) ? [choice["id"]] : []))
    : [];
}

function textProblem(
  definition: ConfigField,
  value: unknown,
  secret: boolean,
): string | undefined {
  if (typeof value !== "string")
    return `must be a string, got ${describeType(value)}`;
  const minLength = numberProperty(definition, "minLength");
  if (minLength !== undefined && value.length < minLength)
    return `must be at least ${plural(minLength, "character")}`;
  const source = failedPattern(definition, value);
  if (source)
    return secret
      ? `does not match the field's pattern ${source}`
      : `${JSON.stringify(value)} does not match the field's pattern ${source}`;
  return undefined;
}

function choiceProblem(
  definition: ConfigField,
  value: unknown,
): string | undefined {
  const ids = choiceIds(definition);
  if (ids.some((id) => id === value)) return undefined;
  if (definition["allowCustom"] === true) {
    if (typeof value === "number") return undefined;
    if (typeof value !== "string")
      return `must be a choice or a custom string, got ${describeType(value)}`;
    const source = failedPattern(definition, value);
    if (source)
      return `${JSON.stringify(value)} does not match the field's pattern ${source}`;
    return undefined;
  }
  return `${JSON.stringify(value)} is not one of the choices: ${ids.map((id) => JSON.stringify(id)).join(", ")}`;
}

/**
 * Why the module's field `definition` refuses `value`, if it does. Field
 * types follow Companion 5.1's `SomeCompanionInputField` (docs/
 * companion-internals.md, "Connection config fields"); a type this list does
 * not know is accepted. `secret` values are never echoed.
 */
export function fieldValueProblem(
  definition: ConfigField,
  value: unknown,
  secret: boolean,
): string | undefined {
  switch (definition.type) {
    case "textinput":
    case "secret-text":
      return textProblem(definition, value, secret);
    case "bonjour-device":
      return typeof value === "string" || value === null
        ? undefined
        : `must be a string or null, got ${describeType(value)}`;
    case "checkbox":
      return typeof value === "boolean"
        ? undefined
        : `must be true or false, got ${describeType(value)}`;
    case "colorpicker":
      return typeof value === "number" || typeof value === "string"
        ? undefined
        : `must be a color number or string, got ${describeType(value)}`;
    case "number": {
      if (typeof value !== "number")
        return `must be a number, got ${describeType(value)}`;
      const min = numberProperty(definition, "min");
      const max = numberProperty(definition, "max");
      if (min !== undefined && value < min) return `must be at least ${min}`;
      if (max !== undefined && value > max) return `must be at most ${max}`;
      return undefined;
    }
    case "dropdown":
      return choiceProblem(definition, value);
    case "multidropdown": {
      if (!Array.isArray(value))
        return `must be a list, got ${describeType(value)}`;
      for (const item of value) {
        const problem = choiceProblem(definition, item);
        if (problem) return problem;
      }
      const min = numberProperty(definition, "minSelection");
      const max = numberProperty(definition, "maxSelection");
      if (min !== undefined && value.length < min)
        return `must select at least ${min}`;
      if (max !== undefined && value.length > max)
        return `must select at most ${max}`;
      return undefined;
    }
    default:
      return undefined;
  }
}

type Area = "config" | "secrets";

/** The keys of `area` the plan sets, with the value to check. */
function plannedEntries(plan: ConnectionPlan, area: Area): [string, unknown][] {
  if (area === "config") return Object.entries(plan.config ?? {});
  const values = plan.resolved?.secretValues ?? {};
  return Object.keys(plan.secrets ?? {}).map((key) => [key, values[key]]);
}

/**
 * The keys the strict rule cannot accept without definitions: not stored, or
 * stored with a value of another JSON type. `--unchecked` lets them through.
 */
export function uncheckedKeys(
  stored: Fields,
  plan: ConnectionPlan,
): { path: string; reason: string }[] {
  const keys: { path: string; reason: string }[] = [];
  for (const area of ["config", "secrets"] as const) {
    const current = stored[area];
    const storedArea = isJsonObject(current) ? current : {};
    for (const [key, value] of plannedEntries(plan, area)) {
      const path = fieldPath(area, key);
      if (!Object.hasOwn(storedArea, key)) {
        keys.push({ path, reason: `the stored ${area} has no key "${key}"` });
      } else if (
        area === "config" &&
        jsonType(storedArea[key]) !== jsonType(value)
      ) {
        keys.push({
          path,
          reason: `the stored value is a ${jsonType(storedArea[key])}, not a ${jsonType(value)}`,
        });
      } else if (area === "secrets" && typeof storedArea[key] !== "string") {
        keys.push({
          path,
          reason: `the stored secret is a ${jsonType(storedArea[key])}, not a string`,
        });
      }
    }
  }
  return keys;
}

const UNCHECKED_HINT =
  "start Companion and enable the connection so its config fields can be read, or pass --unchecked";

function checkAgainstDefinitions(
  plan: ConnectionPlan,
  definitions: readonly ConfigField[],
): void {
  for (const area of ["config", "secrets"] as const) {
    for (const [key, value] of plannedEntries(plan, area)) {
      const path = fieldPath(area, key);
      const definition = definitions.find((item) => item.id === key);
      if (!definition)
        throw new CheckError(path, "the module has no config field of this id");
      if (area === "config" && definition.type === "secret-text")
        // The description is wrong whatever the database holds: the
        // contract's invalid_description, though only definitions show it.
        throw new CliError(
          `${path}: is a secret field, so it cannot be set under config`,
          {
            code: "invalid_description",
            path,
            hint: `move it under secrets as ${key}: {env: NAME}`,
          },
        );
      if (area === "config" && definition.type === "static-text")
        throw new CheckError(path, "is static text, which holds no value");
      if (area === "secrets" && definition.type !== "secret-text")
        throw new CheckError(
          path,
          "is not a secret field: set it under config",
        );
      const problem = fieldValueProblem(definition, value, area === "secrets");
      if (problem) throw new CheckError(path, problem);
    }
  }
}

export function checkConnection(db: DatabaseSync, plan: ConnectionPlan): void {
  if (plan.secrets && !plan.resolved)
    throw new Error("connection secrets checked before resolve");
  const row = findConnection(db, plan.target);
  if (plan.label !== undefined && plan.label !== row.label) {
    const label = plan.label;
    // Companion's own rule: unused by any other connection.
    const taken = connectionRows(db).find(
      (other) => other.id !== row.id && other.label === label,
    );
    if (taken)
      throw new CheckError(
        "label",
        `"${label}" is already the label of ${taken.id}`,
        { hint: LIST_HINT },
      );
    const referencing = controlsReferencingLabel(db, row.label);
    if (referencing.length > 0) {
      const shown = referencing.slice(0, 3).join(", ");
      const more = referencing.length > 3 ? ", …" : "";
      throw new CheckError(
        "label",
        `cannot rename "${row.label}": ${plural(referencing.length, "control")} reference it (${shown}${more}), and only Companion's own rename rewrites references`,
        { hint: `companion-cli list connections ${row.label}` },
      );
    }
  }
  for (const area of ["config", "secrets"] as const) {
    if (plannedEntries(plan, area).length === 0) continue;
    const current = row.value[area];
    if (current !== undefined && !isJsonObject(current))
      throw new CheckError(
        area,
        `the stored ${area} is ${describeType(current)}, not a mapping`,
      );
  }
  const definitions = plan.resolved?.definitions;
  if (definitions) {
    checkAgainstDefinitions(plan, definitions);
    return;
  }
  if (plan.resolved?.unchecked) return;
  const [first] = uncheckedKeys(row.value, plan);
  if (first) {
    const reason = plan.resolved?.unavailableReason ?? "no config fields read";
    throw new CheckError(
      first.path,
      `cannot be checked without the module's config fields (${reason}), and ${first.reason}`,
      { hint: UNCHECKED_HINT },
    );
  }
}

/**
 * The stored `instances` value apply writes: what both apply and export
 * build. Every stored key is kept; config and secrets merge shallowly.
 */
export function buildConnectionRow(
  stored: Fields,
  plan: ConnectionPlan,
  secretValues: Readonly<Record<string, string>>,
): Fields {
  const row: Fields = { ...stored };
  if (plan.label !== undefined) row["label"] = plan.label;
  if (plan.enabled !== undefined) row["enabled"] = plan.enabled;
  if (plan.config !== undefined) {
    const config = stored["config"];
    row["config"] = { ...(isJsonObject(config) ? config : {}), ...plan.config };
    // Companion's setConnectionLabelAndConfig does the same with a config.
    row["isFirstInit"] = false;
  }
  if (plan.secrets !== undefined && Object.keys(plan.secrets).length > 0) {
    const secrets = stored["secrets"];
    row["secrets"] = {
      ...(isJsonObject(secrets) ? secrets : {}),
      ...secretValues,
    };
  }
  return row;
}

/** What the plan sets, without values: `label, enabled, 2 config keys, 1 secret`. */
function changes(plan: ConnectionPlan): string {
  const parts: string[] = [];
  if (plan.label !== undefined) parts.push(`label "${plan.label}"`);
  if (plan.enabled !== undefined)
    parts.push(plan.enabled ? "enabled" : "disabled");
  if (plan.config !== undefined)
    parts.push(plural(Object.keys(plan.config).length, "config key"));
  if (plan.secrets !== undefined)
    parts.push(plural(Object.keys(plan.secrets).length, "secret"));
  return parts.join(", ");
}

async function resolveConnection(
  plan: ConnectionPlan,
  context: WriterContext,
): Promise<ConnectionPlan> {
  const secretValues: Record<string, string> = {};
  for (const [key, name] of Object.entries(plan.secrets ?? {})) {
    const value = context.env[name];
    if (value === undefined)
      throw new CheckError(
        fieldPath("secrets", key),
        `environment variable ${name} is not set`,
        { hint: `set ${name} in the environment` },
      );
    secretValues[key] = value;
  }
  const resolved: ResolvedConnection = {
    secretValues,
    definitions: undefined,
    unavailableReason: undefined,
    unchecked: context.unchecked,
  };
  const keyCount =
    Object.keys(plan.config ?? {}).length +
    Object.keys(plan.secrets ?? {}).length;
  if (keyCount === 0) return { ...plan, resolved };

  const row = context.read((db) => findConnection(db, plan.target));
  const outcome = await context.configFields(row.id);
  if (outcome.available) {
    resolved.definitions = outcome.fields;
    for (const area of ["config", "secrets"] as const) {
      for (const [key] of plannedEntries(plan, area)) {
        const definition = outcome.fields.find((item) => item.id === key);
        const source = definition ? regexOf(definition) : undefined;
        if (source && !compileFieldRegex(source))
          context.warn(
            `${fieldPath(area, key)}: the field's pattern ${source} does not compile here; not checked against it`,
          );
      }
    }
  } else {
    resolved.unavailableReason = outcome.reason;
    if (context.unchecked) {
      for (const key of uncheckedKeys(row.value, {
        ...plan,
        resolved,
      }))
        context.warn(
          `${key.path}: not checked (${outcome.reason}; ${key.reason})`,
        );
    }
  }
  return { ...plan, resolved };
}

export const connectionWriter: Writer<ConnectionPlan> = {
  kind: "connection",
  parse: parseConnection,
  resolve: resolveConnection,
  check: checkConnection,
  describe: (plan) => `connection "${plan.selector}": ${changes(plan)}`,
  write(db, plan) {
    if (plan.secrets && !plan.resolved)
      throw new Error("connection secrets written before resolve");
    const row = findConnection(db, plan.target);
    const value = buildConnectionRow(
      row.value,
      plan,
      plan.resolved?.secretValues ?? {},
    );
    db.prepare("UPDATE instances SET value = ? WHERE id = ?").run(
      JSON.stringify(value),
      row.id,
    );
    return `connection ${row.id} ("${row.label}") replaced: ${changes(plan)}`;
  },
};
