/**
 * `export surface <id>`: one stored surface as a `kind: surface` file with
 * `surface`, `name` and `enabled` (each when stored), Companion's own config
 * keys as top-level fields, `transferInputs`, `transferOutputs` and `plugin`
 * (prefixes stripped), and every other config key under `config`.
 *
 * `config.groupId: null` (Companion's stored default) is not emitted: the
 * writer's merge keeps it. A surface in a manual group (`groupId`, or a
 * non-null `config.groupId`) is refused. `groupConfig` and the identity
 * fields (`type`, `integrationType`, `gridSize`, `layout`) are kept by
 * apply as stored and so are not emitted either; the YAML output says so.
 */
import type { DatabaseSync } from "node:sqlite";
import { type Fields, isJsonObject } from "../core/validate.ts";
import {
  buildSurfaceRow,
  checkSurface,
  OWNED_KEYS,
  parseSurface,
  PREFIXED_HOMES,
  readSurface,
  type StoredSurface,
} from "../writers/surface.ts";
import { describeStored, type Exporter, refuse, selfCheck } from "./export.ts";

const IN_A_GROUP =
  "is set: the surface is in a manual surface group, which the description format does not support";

/** The stored path of a description field path. */
function storedPath(field: string): string {
  if (field === "surface") return "id";
  if (OWNED_KEYS.includes(field)) return `config.${field}`;
  for (const [prefix, home] of PREFIXED_HOMES) {
    if (field.startsWith(`${home}.`))
      return `config.${prefix}${field.slice(home.length + 1)}`;
  }
  return field;
}

function entry(db: DatabaseSync, surface: StoredSurface): Fields {
  const stored = surface.value;
  if (stored["groupId"] !== undefined && stored["groupId"] !== null)
    refuse("groupId", IN_A_GROUP, "surface");
  const config = stored["config"];
  if (config !== undefined && !isJsonObject(config))
    refuse("config", `is ${describeStored(config)}, not a mapping`, "surface");
  const described: Fields = { surface: surface.id };
  if (Object.hasOwn(stored, "name")) described["name"] = stored["name"];
  if (Object.hasOwn(stored, "enabled"))
    described["enabled"] = stored["enabled"];
  const homes: Record<string, Fields> = {};
  const rest: Fields = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (key === "groupId") {
      if (value === null) continue;
      refuse("config.groupId", IN_A_GROUP, "surface");
    }
    if (OWNED_KEYS.includes(key)) {
      described[key] = value;
      continue;
    }
    const home = PREFIXED_HOMES.find(([prefix]) => key.startsWith(prefix));
    if (home) {
      const [prefix, field] = home;
      (homes[field] ??= {})[key.slice(prefix.length)] = value;
      continue;
    }
    rest[key] = value;
  }
  for (const [, field] of PREFIXED_HOMES) {
    if (homes[field]) described[field] = homes[field];
  }
  if (Object.keys(rest).length > 0) described["config"] = rest;
  selfCheck({
    stored,
    parse: () => parseSurface(described),
    check: (plan) => checkSurface(db, plan),
    build: (plan) => buildSurfaceRow(stored, plan),
    storedPath,
    area: () => "surface",
  });
  return described;
}

/** What apply keeps as stored and the file therefore leaves out. */
const NOT_EXPORTED = [
  "groupConfig",
  "type",
  "integrationType",
  "gridSize",
  "layout",
];

export const surfaceExporter: Exporter<StoredSurface> = {
  kind: "surface",
  arguments: "<id>",
  noun: "surfaces",
  checkArgs: (args) =>
    args.length === 1
      ? undefined
      : "export surface takes exactly one surface id",
  // An exact id: `not_found` names `list surfaces`.
  select: (db, [id]) => [readSurface(db, id ?? "")],
  name: (surface) => surface.id,
  label: (surface) => `surface ${JSON.stringify(surface.id)}`,
  entry,
  file: ([described]) => ({ kind: "surface", ...described }),
  comments: (_db, surfaces) => {
    const kept = NOT_EXPORTED.filter((key) =>
      surfaces.some((surface) => Object.hasOwn(surface.value, key)),
    );
    return kept.length > 0
      ? [`kept as stored by apply, not exported: ${kept.join(", ")}`]
      : [];
  },
};
