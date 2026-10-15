/**
 * `export <kind>`: stored content back to a description file (ADR 0006).
 *
 * An exporter plugs into the shared read path (src/core/read.ts) the way a
 * lister does. For each selected item it maps the stored row to a
 * description entry, then proves the entry with `selfCheck`: the writer's own
 * parse, check and build code must reproduce the stored value, masking only
 * the generated ids of ADR 0005. Anything else refuses the item, naming the
 * stored path. Export is all or nothing: one refused item and nothing is
 * printed.
 */
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { stringify } from "yaml";
import { CliError, type ErrorCode, ValidationError } from "../core/errors.ts";
import { maskGeneratedIds } from "../core/generated-ids.ts";
import { matchesNamePatterns } from "../core/patterns.ts";
import { readDatabase } from "../core/read.ts";
import {
  describeType,
  type Fields,
  fieldPath,
  isJsonObject,
} from "../core/validate.ts";
import type { ListCommand } from "../readers/list.ts";
import { SCHEMA_MODELINE } from "../schema.ts";
import type { Area } from "../support-matrix.ts";

/** Why one item cannot be exported. */
export interface Refusal {
  /** The stored path, relative to the item's row (`options.notes`). */
  path: string;
  /** A predicate on the path: `is set, which …`. */
  reason: string;
  /** The support-matrix area the hint names, when the format is the limit. */
  area?: Area;
  code?: ErrorCode;
}

export class ExportRefusal extends Error {
  override name = "ExportRefusal";
  readonly refusal: Refusal;

  constructor(refusal: Refusal) {
    super(`${refusal.path} ${refusal.reason}`);
    this.refusal = refusal;
  }
}

export function refuse(path: string, reason: string, area?: Area): never {
  throw new ExportRefusal({ path, reason, ...(area ? { area } : {}) });
}

/**
 * One `export <kind>` command. Adding an export means adding an exporter to
 * src/export/index.ts.
 */
export interface Exporter<Item> {
  /** The `export` kind, as typed. */
  readonly kind: string;
  /** The arguments in the usage line: `[<pattern>...]`. */
  readonly arguments: string;
  /** The plural noun in "3 triggers cannot be exported". */
  readonly noun: string;
  /** A usage reason when the arguments (names or patterns) are wrong. */
  checkArgs?(args: readonly string[]): string | undefined;
  /** The items to export, in output order. Throws `not_found` when none. */
  select(db: DatabaseSync, args: readonly string[]): Item[];
  /** The item's name, as in the aggregated refusal. */
  name(item: Item): string;
  /** The item in messages: `trigger "Reset" (trigger:…)`. */
  label(item: Item): string;
  /** The item's description entry, self-checked. Throws `ExportRefusal`. */
  entry(db: DatabaseSync, item: Item): Fields;
  /** The description file holding the entries. */
  file(entries: Fields[]): Fields;
}

/** A stored value's type for messages; `missing` when the key is absent. */
export function describeStored(value: unknown): string {
  return value === undefined ? "missing" : describeType(value);
}

export const REASON_UNSUPPORTED =
  "is set, which the description format does not support yet";

/** Where `stored` and `built` first differ, stored keys first. */
export function firstDifference(
  stored: unknown,
  built: unknown,
  path = "",
): Refusal | undefined {
  if (Array.isArray(stored) && Array.isArray(built)) {
    if (stored.length !== built.length) {
      return {
        path,
        reason:
          built.length === 0
            ? REASON_UNSUPPORTED
            : `has ${stored.length} entries, where apply would store ${built.length}`,
      };
    }
    for (const [index, item] of stored.entries()) {
      const found = firstDifference(item, built[index], fieldPath(path, index));
      if (found) return found;
    }
    return undefined;
  }
  if (isJsonObject(stored) && isJsonObject(built)) {
    for (const key of Object.keys(stored)) {
      const child = fieldPath(path, key);
      if (!Object.hasOwn(built, key))
        return { path: child, reason: REASON_UNSUPPORTED };
      const found = firstDifference(stored[key], built[key], child);
      if (found) return found;
    }
    for (const key of Object.keys(built)) {
      if (!Object.hasOwn(stored, key))
        return {
          path: fieldPath(path, key),
          reason: "is missing, where apply would store it",
        };
    }
    return undefined;
  }
  if (isDeepStrictEqual(stored, built)) return undefined;
  return {
    path,
    reason: `is ${JSON.stringify(stored)}, which apply would store as ${JSON.stringify(built)}`,
  };
}

export interface SelfCheck<Plan> {
  /** The stored value the entry must reproduce. */
  stored: unknown;
  /** The writer's parse, on the mapped description. */
  parse(): Plan;
  /** The writer's check. */
  check?(plan: Plan): void;
  /** The writer's build, with what it keeps from the stored row. */
  build(plan: Plan): unknown;
  /** The stored path for a description field path. */
  storedPath(field: string): string;
  /** The support-matrix area of a stored path. */
  area(path: string): Area;
}

/**
 * Proves a mapped entry: parse, check and build it with the writer's own
 * code and compare with the stored value. Refuses on any difference.
 */
export function selfCheck<Plan>(proof: SelfCheck<Plan>): void {
  let plan: Plan;
  try {
    plan = proof.parse();
    proof.check?.(plan);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    const field = error.path ?? "";
    const path = proof.storedPath(field);
    const reason = error.message.startsWith(`${field}: `)
      ? error.message.slice(field.length + 2)
      : error.message;
    throw new ExportRefusal({
      path,
      reason:
        error instanceof ValidationError
          ? `cannot be expressed: ${reason}`
          : `fails apply's check: ${reason}`,
      ...(error instanceof ValidationError
        ? { area: proof.area(path) }
        : { code: error.code ?? "check_failed" }),
    });
  }
  const built = JSON.parse(JSON.stringify(proof.build(plan))) as unknown;
  const found = firstDifference(
    maskGeneratedIds(proof.stored),
    maskGeneratedIds(built),
  );
  if (found)
    throw new ExportRefusal({ ...found, area: proof.area(found.path) });
}

/** A pattern without `*` or `?`: one exact name. */
function isExactName(pattern: string): boolean {
  return !/[*?]/.test(pattern);
}

/**
 * The items whose name matches `patterns`, keeping their order. An exact
 * name that matches nothing, or patterns that match nothing at all, are
 * `not_found`; so is an empty list.
 */
export function selectByPatterns<Item>(
  items: readonly Item[],
  patterns: readonly string[],
  name: (item: Item) => string,
  noun: { one: string; many: string },
): Item[] {
  if (items.length === 0)
    throw new CliError(`no ${noun.many} to export`, { code: "not_found" });
  for (const pattern of patterns) {
    if (isExactName(pattern) && !items.some((item) => name(item) === pattern))
      throw new CliError(`no ${noun.one} named ${JSON.stringify(pattern)}`, {
        code: "not_found",
      });
  }
  const selected = items.filter((item) =>
    matchesNamePatterns(name(item), patterns),
  );
  if (selected.length === 0)
    throw new CliError(
      `no ${noun.many} match ${patterns.map((p) => JSON.stringify(p)).join(", ")}`,
      { code: "not_found" },
    );
  return selected;
}

const hint = (area: Area | undefined) =>
  area ? `see docs/support-matrix.md (${area})` : undefined;

function refusalMessage(label: string, refusal: Refusal): string {
  const area = refusal.area
    ? ` (see docs/support-matrix.md, ${refusal.area})`
    : "";
  return `cannot export ${label}: ${refusal.path} ${refusal.reason}${area}`;
}

/** Every refusal as one error: the item's own message, or a summary of several. */
function refusalError<Item>(
  exporter: Exporter<Item>,
  refused: { item: Item; refusal: Refusal }[],
): CliError {
  const [first] = refused;
  if (!first) throw new Error("no refusal");
  const items = refused.map(({ item, refusal }) => ({
    message: refusalMessage(exporter.label(item), refusal),
    path: refusal.path,
  }));
  const message =
    refused.length === 1
      ? refusalMessage(exporter.label(first.item), first.refusal)
      : `${refused.length} ${exporter.noun} cannot be exported: ${refused
          .map(
            ({ item, refusal }) =>
              `${JSON.stringify(exporter.name(item))} (${refusal.path})`,
          )
          .join("; ")}`;
  const firstHint = hint(first.refusal.area);
  return new CliError(message, {
    code: first.refusal.code ?? "export_unsupported",
    path: first.refusal.path,
    ...(firstHint ? { hint: firstHint } : {}),
    ...(refused.length > 1 ? { items } : {}),
  });
}

/** The YAML options: plain strings unless YAML would read them differently, never block scalars. */
const YAML_OPTIONS = {
  lineWidth: 0,
  blockQuote: false,
  defaultStringType: "PLAIN",
  defaultKeyType: "PLAIN",
  doubleQuotedAsJSON: true,
  singleQuote: false,
} as const;

/**
 * The description as YAML lines, after two comment lines: the YAML language
 * server's schema modeline and one naming the export.
 */
export function renderYaml(
  kind: string,
  count: number,
  description: Fields,
): string[] {
  const text = stringify(description, YAML_OPTIONS);
  return [
    SCHEMA_MODELINE,
    `# companion-cli export: ${kind} (${count})`,
    ...text.replace(/\n$/, "").split("\n"),
  ];
}

/** An `export <kind>` command on the shared read path. */
export function exportCommand<Item>(exporter: Exporter<Item>): ListCommand {
  return {
    flags: [],
    ...(exporter.checkArgs
      ? { checkArgs: (args) => exporter.checkArgs?.(args) }
      : {}),
    run: async ({ dbPath, patterns: args, options }) => {
      const { value: entries } = readDatabase(dbPath, options, (db) => {
        const refused: { item: Item; refusal: Refusal }[] = [];
        const built: Fields[] = [];
        for (const item of exporter.select(db, args)) {
          try {
            built.push(exporter.entry(db, item));
          } catch (error) {
            if (!(error instanceof ExportRefusal)) throw error;
            refused.push({ item, refusal: error.refusal });
          }
        }
        if (refused.length > 0) throw refusalError(exporter, refused);
        return built;
      });
      const description = exporter.file(entries);
      return {
        text: () => renderYaml(exporter.kind, entries.length, description),
        json: () => JSON.stringify(description),
      };
    },
  };
}
