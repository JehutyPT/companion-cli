/**
 * `export connection <label | id:<id>>`: one connection as a
 * `kind: connection` file with `connection`, `enabled` and `config` (left out
 * when the stored row has none). `connection` is the label when no other
 * connection shares it, otherwise `id:<id>`.
 *
 * Secrets are never exported: a description takes them from the environment.
 * The YAML output names the stored secret keys in a comment; the JSON output
 * has no comments.
 */
import type { DatabaseSync } from "node:sqlite";
import { type Fields, isJsonObject } from "../core/validate.ts";
import {
  buildConnectionRow,
  checkConnection,
  connectionRows,
  findConnection,
  labelProblem,
  parseConnection,
  parseTarget,
  type StoredConnectionRow,
} from "../writers/connection.ts";
import { describeStored, type Exporter, refuse, selfCheck } from "./export.ts";

/** The selector an exported file names the connection by. */
function selector(db: DatabaseSync, row: StoredConnectionRow): string {
  const shared = connectionRows(db).filter(
    (other) => other.label === row.label,
  );
  return shared.length === 1 && labelProblem(row.label) === undefined
    ? row.label
    : `id:${row.id}`;
}

function entry(db: DatabaseSync, row: StoredConnectionRow): Fields {
  const stored = row.value;
  if (stored["isFirstInit"] === true)
    refuse(
      "isFirstInit",
      "is true: the connection has never been configured, and apply would set it to false",
      "connection",
    );
  const { enabled, config } = stored;
  if (typeof enabled !== "boolean")
    refuse(
      "enabled",
      `is ${describeStored(enabled)}, not a boolean`,
      "connection",
    );
  if (config !== undefined && !isJsonObject(config))
    refuse(
      "config",
      `is ${describeStored(config)}, not a mapping`,
      "connection",
    );
  const described: Fields = {
    connection: selector(db, row),
    enabled,
    ...(config !== undefined ? { config } : {}),
  };
  selfCheck({
    stored,
    parse: () => parseConnection(described),
    check: (plan) => checkConnection(db, plan),
    build: (plan) => buildConnectionRow(stored, plan, {}),
    storedPath: (field) => (field === "connection" ? "label" : field),
    area: () => "connection",
  });
  return described;
}

/** The stored secret keys, never their values. */
function secretKeys(row: StoredConnectionRow): string[] {
  const secrets = row.value["secrets"];
  return isJsonObject(secrets) ? Object.keys(secrets) : [];
}

export const connectionExporter: Exporter<StoredConnectionRow> = {
  kind: "connection",
  arguments: "<label | id:<id>>",
  noun: "connections",
  checkArgs: (args) =>
    args.length === 1
      ? undefined
      : "export connection takes exactly one connection: its label or id:<id>",
  select: (db, [name]) => [findConnection(db, parseTarget(name, "connection"))],
  name: (row) => row.label,
  label: (row) => `connection ${JSON.stringify(row.label)} (${row.id})`,
  entry,
  file: ([described]) => ({ kind: "connection", ...described }),
  comments: (_db, rows) => {
    const keys = rows.flatMap(secretKeys);
    return keys.length > 0
      ? [
          `secrets not exported: ${keys.join(", ")} (set each as secrets: {<key>: {env: NAME}})`,
        ]
      : [];
  },
};
