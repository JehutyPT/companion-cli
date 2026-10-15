/**
 * `list surfaces` (#32): the stored surface rows, by id. Each row shows the
 * id, name, type, enabled flag and how many config keys are stored. Config
 * values are never read out: a surface module may keep its own data there.
 * Patterns match the id or the name. Rows that are not JSON objects are
 * skipped.
 */
import type { DatabaseSync } from "node:sqlite";
import { isJsonObject } from "../core/validate.ts";
import { readSurfaces } from "../writers/surface.ts";
import { byCodeUnit, type Lister, yesNo } from "./list.ts";

export interface ListedSurface {
  id: string;
  name: string | null;
  type: string | null;
  integrationType: string | null;
  enabled: boolean;
  /** Stored config keys; null when the row has no config mapping. */
  configKeys: number | null;
}

const text = (value: unknown) => (typeof value === "string" ? value : null);

function read(db: DatabaseSync): ListedSurface[] {
  return readSurfaces(db)
    .map(({ id, value }) => {
      const config = value["config"];
      return {
        id,
        name: text(value["name"]),
        type: text(value["type"]),
        integrationType: text(value["integrationType"]),
        // Companion's own reading: a surface is enabled unless set to false.
        enabled: value["enabled"] !== false,
        configKeys: isJsonObject(config) ? Object.keys(config).length : null,
      };
    })
    .sort((a, b) => byCodeUnit(a.id, b.id));
}

export const surfacesLister: Lister<ListedSurface> = {
  kind: "surfaces",
  read,
  name: (surface) => surface.id,
  names: (surface) =>
    surface.name === null ? [surface.id] : [surface.id, surface.name],
  columns: [
    { header: "ID", cell: (surface) => surface.id, maxLength: 60 },
    // Companion stores an unnamed surface as "".
    { header: "NAME", cell: (surface) => surface.name || "-" },
    { header: "TYPE", cell: (surface) => surface.type ?? "-" },
    { header: "ENABLED", cell: (surface) => yesNo(surface.enabled) },
    {
      header: "KEYS",
      cell: (surface) =>
        surface.configKeys === null ? "-" : String(surface.configKeys),
    },
  ],
  json: (surface) => ({
    id: surface.id,
    name: surface.name,
    type: surface.type,
    integrationType: surface.integrationType,
    enabled: surface.enabled,
    configKeys: surface.configKeys,
  }),
};
