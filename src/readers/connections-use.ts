/**
 * Connections and their use, shared by `list connections` and `list pages`,
 * and meant for `find --connection` (#14) and the census (#15).
 *
 * Companion 5.1 stores one `instances` row per module instance
 * (`InstanceConfig`, shared-lib/lib/Model/Instance.ts); only rows with
 * `moduleInstanceType: "connection"` are connections. Entities (actions,
 * feedbacks, trigger conditions) name a connection by id in `connectionId`;
 * `"internal"` is Companion's built-in connection. Variable references name it
 * by label, as `$(<label>:<name>)`. See docs/companion-internals.md,
 * "Connections".
 *
 * `config` and `secrets` can hold device credentials: they are never read
 * into a `StoredConnection`.
 */
import type { DatabaseSync } from "node:sqlite";
import { parseStoredJson } from "../core/database.ts";
import { isJsonObject } from "../core/validate.ts";
import { bySortOrderThen } from "./list.ts";

/** The id and label of Companion's built-in connection. */
export const INTERNAL_CONNECTION = "internal";

/** A connection row, without its configuration or secrets. */
export interface StoredConnection {
  id: string;
  label: string;
  moduleId: string | null;
  moduleVersionId: string | null;
  enabled: boolean;
  sortOrder: number | null;
}

const stringOrNull = (value: unknown) =>
  typeof value === "string" ? value : null;

/** The connection rows, in Companion's order: `sortOrder`, then id. */
export function readConnections(db: DatabaseSync): StoredConnection[] {
  const connections: StoredConnection[] = [];
  for (const row of db.prepare("SELECT id, value FROM instances").all()) {
    const value = parseStoredJson(row["value"]);
    if (!isJsonObject(value) || value["moduleInstanceType"] !== "connection")
      continue;
    const { label, moduleId, moduleVersionId, enabled, sortOrder } = value;
    connections.push({
      id: String(row["id"]),
      label: typeof label === "string" ? label : "",
      moduleId: stringOrNull(moduleId),
      moduleVersionId: stringOrNull(moduleVersionId),
      enabled: Boolean(enabled),
      sortOrder: typeof sortOrder === "number" ? sortOrder : null,
    });
  }
  return connections.sort(
    bySortOrderThen(
      (connection) => connection.sortOrder ?? undefined,
      (connection) => connection.id,
    ),
  );
}

/**
 * A variable reference's label: the text between `$(` and the first `:`, as
 * Companion's `VARIABLE_REGEX` (Variables/Util.ts) reads it.
 */
const REFERENCE_LABEL = /\$\(([^:$)]+):/g;

/** Answers which connections a stored control references. */
export interface ConnectionIndex {
  /**
   * The ids of the connections `control` references: every string
   * `connectionId` anywhere in it (`internal` and ids matching no connection
   * included), and every connection whose label a `$(<label>:` in any string
   * value names (each connection sharing that label; `internal` included).
   */
  referencedBy(control: unknown): Set<string>;
}

export function connectionIndex(
  connections: readonly Pick<StoredConnection, "id" | "label">[],
): ConnectionIndex {
  const byLabel = new Map<string, string[]>([
    [INTERNAL_CONNECTION, [INTERNAL_CONNECTION]],
  ]);
  for (const { id, label } of connections) {
    byLabel.set(label, [...(byLabel.get(label) ?? []), id]);
  }
  return {
    referencedBy(control) {
      const ids = new Set<string>();
      const visit = (value: unknown): void => {
        if (typeof value === "string") {
          for (const [, label] of value.matchAll(REFERENCE_LABEL)) {
            for (const id of byLabel.get(label as string) ?? []) ids.add(id);
          }
        } else if (Array.isArray(value)) {
          value.forEach(visit);
        } else if (isJsonObject(value)) {
          const connectionId = value["connectionId"];
          if (typeof connectionId === "string" && connectionId !== "")
            ids.add(connectionId);
          Object.values(value).forEach(visit);
        }
      };
      visit(control);
      return ids;
    },
  };
}
