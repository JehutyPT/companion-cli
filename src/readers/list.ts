import type { DatabaseSync } from "node:sqlite";
import { matchesNamePatterns } from "../core/patterns.ts";
import { type ReadOptions, readDatabase } from "../core/read.ts";

/**
 * A lister reads one kind of stored item for `list <kind>`. It plugs into the
 * shared read path (src/core/read.ts), which owns the snapshot, the integrity
 * check and the version guard; a lister only reads rows from the open copy.
 */
export interface Lister<Item> {
  /** The `list` kind, and the key of the items in the JSON document. */
  readonly kind: string;
  /** Every stored item, in output order. */
  read(db: DatabaseSync): Item[];
  /** The name that name patterns match. */
  name(item: Item): string;
  /** The text table's columns, in order. */
  readonly columns: readonly Column<Item>[];
  /** The item in the JSON document. */
  json(item: Item): unknown;
}

export interface Column<Item> {
  header: string;
  cell(item: Item): string;
}

export interface Listing<Item> {
  database: string;
  items: Item[];
}

/** Reads the items whose name matches `patterns` (all items when none). */
export function list<Item>(
  lister: Lister<Item>,
  dbPath: string | undefined,
  patterns: readonly string[],
  options: ReadOptions,
): Listing<Item> {
  const { database, value } = readDatabase(dbPath, options, (db) =>
    lister
      .read(db)
      .filter((item) => matchesNamePatterns(lister.name(item), patterns)),
  );
  return { database, items: value };
}

/** The text table: a header row, then one row per item. */
export function renderListing<Item>(
  lister: Lister<Item>,
  listing: Listing<Item>,
): string[] {
  return renderTable(
    lister.columns.map((column) => column.header),
    listing.items.map((item) =>
      lister.columns.map((column) => column.cell(item)),
    ),
  );
}

/** The `--json` document. */
export function listingJson<Item>(
  lister: Lister<Item>,
  listing: Listing<Item>,
): string {
  return JSON.stringify({
    database: listing.database,
    [lister.kind]: listing.items.map((item) => lister.json(item)),
  });
}

/** A `list <kind>` command: reads once, then renders as text or JSON. */
export interface ListCommand {
  run(
    dbPath: string | undefined,
    patterns: readonly string[],
    options: ReadOptions,
  ): { text(): string[]; json(): string };
}

export function listCommand<Item>(lister: Lister<Item>): ListCommand {
  return {
    run: (dbPath, patterns, options) => {
      const listing = list(lister, dbPath, patterns, options);
      return {
        text: () => renderListing(lister, listing),
        json: () => listingJson(lister, listing),
      };
    },
  };
}

/** Longest cell in a text table; longer values are cut and end with `…`. */
export const MAX_CELL_LENGTH = 40;

/** One line per cell: line breaks show as `\n`, long values are cut. */
export function cellText(value: string): string {
  const text = value.replace(/\r\n|\r|\n/g, "\\n");
  const chars = [...text];
  return chars.length > MAX_CELL_LENGTH
    ? `${chars.slice(0, MAX_CELL_LENGTH - 1).join("")}…`
    : text;
}

/**
 * Columns separated by two spaces and padded to the widest value, with no
 * padding after the last column.
 */
export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string[] {
  const lines = [headers, ...rows].map((row) => row.map(cellText));
  const widths = headers.map((_, index) =>
    Math.max(...lines.map((line) => [...(line[index] ?? "")].length)),
  );
  return lines.map((line) => {
    const text = line
      .map((cell, index) =>
        index === line.length - 1
          ? cell
          : cell + " ".repeat((widths[index] ?? 0) - [...cell].length),
      )
      .join("  ");
    // An empty last cell leaves only padding at the end of the line.
    return line.at(-1) === "" ? text.trimEnd() : text;
  });
}

/** Orders by sort order (missing last), then by `key` in code-unit order. */
export function bySortOrderThen<Item>(
  sortOrder: (item: Item) => number | undefined,
  key: (item: Item) => string,
): (a: Item, b: Item) => number {
  return (a, b) => {
    const order =
      (sortOrder(a) ?? Number.POSITIVE_INFINITY) -
      (sortOrder(b) ?? Number.POSITIVE_INFINITY);
    if (order !== 0 && !Number.isNaN(order)) return order;
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
}

/** `yes` or `no`. */
export function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}
