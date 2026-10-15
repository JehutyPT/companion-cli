/**
 * `list pages`: the pages Companion loads, in number order, each with its
 * button count, the connections its controls reference and its first labels.
 * The JSON document also lists every cell, and `unloadedRows`: the numeric
 * `pages` rows Companion does not load.
 */
import type { DatabaseSync } from "node:sqlite";
import { isJsonObject } from "../core/validate.ts";
import {
  connectionIndex,
  INTERNAL_CONNECTION,
  readConnections,
} from "./connections-use.ts";
import { byCodeUnit, cellText, type Lister } from "./list.ts";
import { readControls, readPageStore } from "./store.ts";

export interface ListedCell {
  row: number;
  column: number;
  controlId: string;
  /** The control's type; `null` when it has no `controls` row. */
  type: string | null;
  /** A `button-layered` control's `text0` layer text; otherwise `null`. */
  text: string | null;
}

export interface ListedPage {
  page: number;
  name: string;
  /** The page row's internal `id`, as stored (`null` when missing). */
  id: unknown;
  cells: ListedCell[];
  /** Referenced connections, by label, then id. */
  connections: Array<{ id: string; label: string }>;
}

/** Labels shown per page; `…` follows when there are more. */
const SHOWN_LABELS = 3;
/** Longest label text shown, `…` included. */
const LABEL_LENGTH = 20;

/** The `text0` layer's stored text, or `""` when it has none. */
function layerText(control: Record<string, unknown>): string {
  const style = control["style"];
  const layers = isJsonObject(style) ? style["layers"] : undefined;
  if (!Array.isArray(layers)) return "";
  const layer = layers.find(
    (candidate) => isJsonObject(candidate) && candidate["id"] === "text0",
  ) as Record<string, unknown> | undefined;
  const text = layer?.["text"];
  const value = isJsonObject(text) ? text["value"] : undefined;
  return typeof value === "string" ? value : "";
}

function cell(
  {
    row,
    column,
    controlId,
  }: { row: number; column: number; controlId: string },
  control: unknown,
): ListedCell {
  if (!isJsonObject(control))
    return { row, column, controlId, type: null, text: null };
  const type = typeof control["type"] === "string" ? control["type"] : "";
  return {
    row,
    column,
    controlId,
    type,
    text: type === "button-layered" ? layerText(control) : null,
  };
}

function read(db: DatabaseSync): ListedPage[] {
  const connections = readConnections(db);
  const index = connectionIndex(connections);
  const labels = new Map<string, string>([
    [INTERNAL_CONNECTION, INTERNAL_CONNECTION],
    ...connections.map(({ id, label }) => [id, label] as [string, string]),
  ]);
  const controls = readControls(db);
  return readPageStore(db).pages.map(({ page, value, cells }) => {
    const referenced = new Set<string>();
    for (const { controlId } of cells) {
      for (const id of index.referencedBy(controls.get(controlId)))
        referenced.add(id);
    }
    const name = value["name"];
    return {
      page,
      name: typeof name === "string" ? name : "",
      id: value["id"] ?? null,
      cells: cells.map((stored) =>
        cell(stored, controls.get(stored.controlId)),
      ),
      connections: [...referenced]
        .map((id) => ({ id, label: labels.get(id) ?? "?" }))
        .sort((a, b) => byCodeUnit(a.label, b.label) || byCodeUnit(a.id, b.id)),
    };
  });
}

/** One cell's label: quoted layer text cut to 20, `<type>` or `<missing>`. */
function labelText(listed: ListedCell): string {
  if (listed.type === null) return "<missing>";
  if (listed.text === null) return `<${listed.type}>`;
  return `"${cellText(listed.text, LABEL_LENGTH)}"`;
}

function labelsText(page: ListedPage): string {
  const shown = page.cells.slice(0, SHOWN_LABELS).map(labelText);
  if (page.cells.length > SHOWN_LABELS) shown.push("…");
  return shown.join(", ");
}

export const pagesLister: Lister<ListedPage> = {
  kind: "pages",
  read,
  name: (page) => page.name,
  columns: [
    { header: "PAGE", cell: (page) => String(page.page) },
    { header: "NAME", cell: (page) => page.name },
    { header: "BUTTONS", cell: (page) => String(page.cells.length) },
    {
      header: "CONNECTIONS",
      cell: (page) =>
        page.connections.length === 0
          ? "-"
          : page.connections.map((connection) => connection.label).join(", "),
    },
    {
      header: "LABELS",
      cell: labelsText,
      // Each label is already cut; the column shows them all.
      maxLength: Number.POSITIVE_INFINITY,
    },
  ],
  json: (page) => ({
    page: page.page,
    name: page.name,
    id: page.id,
    buttons: page.cells.length,
    connections: page.connections,
    cells: page.cells,
  }),
  document: (db) => ({ unloadedRows: readPageStore(db).unloadedRows }),
};
