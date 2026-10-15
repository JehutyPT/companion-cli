/**
 * `list connections`: Companion's built-in `internal` connection first, then
 * the connection rows in Companion's order (`sortOrder`, then id), then one
 * row per `connectionId` in any stored control that matches no connection, by
 * id. Each row counts
 * the buttons (controls placed on a loaded page) and the triggers that
 * reference the connection, each control once. Nothing from the row beyond
 * its label, module, version, enabled flag and sort order is read.
 */
import type { DatabaseSync } from "node:sqlite";
import { readTriggers } from "../writers/trigger.ts";
import {
  connectionIndex,
  INTERNAL_CONNECTION,
  readConnections,
  type StoredConnection,
} from "./connections-use.ts";
import { byCodeUnit, type Lister, yesNo } from "./list.ts";
import { readControls, readPageStore } from "./store.ts";

export interface ListedConnection {
  id: string;
  /** `null` for a dangling reference. */
  label: string | null;
  moduleId: string | null;
  moduleVersionId: string | null;
  /** `null` for a dangling reference. */
  enabled: boolean | null;
  sortOrder: number | null;
  buttons: number;
  triggers: number;
  /** A `connectionId` that matches no connection row. */
  missing: boolean;
  builtIn: boolean;
}

function read(db: DatabaseSync): ListedConnection[] {
  const connections = readConnections(db);
  const index = connectionIndex(connections);
  const controls = readControls(db);

  const buttons = new Map<string, number>();
  const triggers = new Map<string, number>();
  const count = (counts: Map<string, number>, control: unknown) => {
    for (const id of index.referencedBy(control))
      counts.set(id, (counts.get(id) ?? 0) + 1);
  };
  const placed = new Set(
    readPageStore(db).pages.flatMap((page) =>
      page.cells.map((cell) => cell.controlId),
    ),
  );
  for (const id of placed) {
    if (id.startsWith("bank:")) count(buttons, controls.get(id));
  }
  for (const trigger of readTriggers(db)) count(triggers, trigger.control);

  const uses = (id: string) => ({
    buttons: buttons.get(id) ?? 0,
    triggers: triggers.get(id) ?? 0,
  });
  const known = new Set([
    INTERNAL_CONNECTION,
    ...connections.map((connection) => connection.id),
  ]);
  // Any stored control can hold a dangling reference, also one that is
  // counted nowhere (on an unloaded page, or placed nowhere).
  const referenced = new Set<string>();
  for (const control of controls.values()) {
    for (const id of index.referencedBy(control)) referenced.add(id);
  }
  const dangling = [...referenced]
    .filter((id) => !known.has(id))
    .sort(byCodeUnit);

  return [
    {
      id: INTERNAL_CONNECTION,
      label: INTERNAL_CONNECTION,
      moduleId: null,
      moduleVersionId: null,
      enabled: true,
      sortOrder: null,
      ...uses(INTERNAL_CONNECTION),
      missing: false,
      builtIn: true,
    },
    ...connections.map((connection: StoredConnection) => ({
      ...connection,
      ...uses(connection.id),
      missing: false,
      builtIn: false,
    })),
    ...dangling.map((id) => ({
      id,
      label: null,
      moduleId: null,
      moduleVersionId: null,
      enabled: null,
      sortOrder: null,
      ...uses(id),
      missing: true,
      builtIn: false,
    })),
  ];
}

function moduleText(connection: ListedConnection): string {
  if (connection.builtIn) return "(built-in)";
  if (connection.missing) return "(missing)";
  return connection.moduleId ?? "-";
}

export const connectionsLister: Lister<ListedConnection> = {
  kind: "connections",
  read,
  name: (connection) => connection.label ?? "?",
  columns: [
    { header: "LABEL", cell: (connection) => connection.label ?? "?" },
    { header: "MODULE", cell: moduleText },
    {
      header: "VERSION",
      cell: (connection) => connection.moduleVersionId ?? "-",
    },
    {
      header: "ENABLED",
      cell: (connection) =>
        connection.enabled === null ? "-" : yesNo(connection.enabled),
    },
    { header: "BUTTONS", cell: (connection) => String(connection.buttons) },
    { header: "TRIGGERS", cell: (connection) => String(connection.triggers) },
    { header: "ID", cell: (connection) => connection.id },
  ],
  json: (connection) => ({
    id: connection.id,
    label: connection.label,
    moduleId: connection.moduleId,
    moduleVersionId: connection.moduleVersionId,
    enabled: connection.enabled,
    sortOrder: connection.sortOrder,
    buttons: connection.buttons,
    triggers: connection.triggers,
    missing: connection.missing,
  }),
};
