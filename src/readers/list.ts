import type { DatabaseSync } from "node:sqlite";
import { matchesNamePatterns } from "../core/patterns.ts";
import { type ReadOptions, readDatabase } from "../core/read.ts";
import type { ConfigDirs, Env } from "../rest/endpoint.ts";

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
  /** Every name patterns match, when more than `name` (an id and a name). */
  names?(item: Item): string[];
  /** The text table's columns, in order. */
  readonly columns: readonly Column<Item>[];
  /** The item in the JSON document. */
  json(item: Item): unknown;
  /**
   * Fields of the JSON document beside `database` and the items, read from
   * the same snapshot. Patterns do not filter them.
   */
  document?(db: DatabaseSync): Record<string, unknown>;
}

export interface Column<Item> {
  header: string;
  cell(item: Item): string;
  /** Longest cell before it is cut. Defaults to `MAX_CELL_LENGTH`. */
  maxLength?: number;
}

export interface Listing<Item> {
  database: string;
  items: Item[];
  /** The document-level JSON fields: the lister's, then any extension's. */
  document: Record<string, unknown>;
  /** Lines after the text table. */
  notes?: readonly string[];
}

/** What a `list` command reads with, beyond the database read options. */
export interface ListOptions extends Omit<ReadOptions, "homedir">, ConfigDirs {
  /** Environment for the REST endpoint. */
  env: Env;
  /** Per-request REST timeout in milliseconds. */
  restTimeoutMs?: number;
}

/** One `list <kind>` command line, parsed. */
export interface ListRequest {
  /** `--db`, when given. */
  dbPath: string | undefined;
  patterns: readonly string[];
  /** The kind-specific boolean options given, without `--`. */
  flags: ReadonlySet<string>;
  /** The kind-specific valued options given, without `--`, by name. */
  values: Readonly<Record<string, string>>;
  options: ListOptions;
}

/**
 * A step after the database read that adds to the listing (`list variables`'
 * current values). It must not throw for anything but a bug: the database
 * read already succeeded.
 */
export interface ListExtension<Item> {
  /** Kind-specific boolean options it reads, without `--`. */
  readonly flags: readonly string[];
  complete(
    listing: Listing<Item>,
    request: ListRequest,
  ): Promise<Listing<Item>>;
}

/** Reads the items whose name matches `patterns` (all items when none). */
export function list<Item>(
  lister: Lister<Item>,
  dbPath: string | undefined,
  patterns: readonly string[],
  options: ReadOptions,
): Listing<Item> {
  const { database, value } = readDatabase(dbPath, options, (db) => ({
    items: lister
      .read(db)
      .filter((item) =>
        (lister.names?.(item) ?? [lister.name(item)]).some((name) =>
          matchesNamePatterns(name, patterns),
        ),
      ),
    document: lister.document?.(db) ?? {},
  }));
  return { database, ...value };
}

/** The text table: a header row, then one row per item. */
export function renderListing<Item>(
  lister: Lister<Item>,
  listing: Listing<Item>,
): string[] {
  return [
    ...renderTable(
      lister.columns.map((column) => column.header),
      listing.items.map((item) =>
        lister.columns.map((column) => column.cell(item)),
      ),
      lister.columns.map((column) => column.maxLength ?? MAX_CELL_LENGTH),
    ),
    ...(listing.notes ?? []),
  ];
}

/** The `--json` document. */
export function listingJson<Item>(
  lister: Lister<Item>,
  listing: Listing<Item>,
): string {
  return JSON.stringify({
    database: listing.database,
    [lister.kind]: listing.items.map((item) => lister.json(item)),
    ...listing.document,
  });
}

/**
 * A read command (`list <kind>`, `export <kind>`): reads once, then renders
 * as text or JSON.
 */
export interface ListCommand {
  /** Kind-specific boolean options, without `--`. */
  readonly flags: readonly string[];
  /** Kind-specific options that take a value (`--button <row>/<column>`), without `--`. */
  readonly valueOptions?: readonly string[];
  /** A usage reason when the arguments or valued options are wrong for this command. */
  checkArgs?(
    args: readonly string[],
    values: Readonly<Record<string, string>>,
  ): string | undefined;
  run(request: ListRequest): Promise<{ text(): string[]; json(): string }>;
}

export function listCommand<Item>(
  lister: Lister<Item>,
  extension?: ListExtension<Item>,
): ListCommand {
  return {
    flags: extension?.flags ?? [],
    run: async (request) => {
      let listing = list(
        lister,
        request.dbPath,
        request.patterns,
        request.options,
      );
      if (extension) listing = await extension.complete(listing, request);
      return {
        text: () => renderListing(lister, listing),
        json: () => listingJson(lister, listing),
      };
    },
  };
}

/** Longest cell in a text table; longer values are cut and end with `…`. */
export const MAX_CELL_LENGTH = 40;

/** One line per cell: line breaks show as `\n`, values over `maxLength` are cut. */
export function cellText(value: string, maxLength = MAX_CELL_LENGTH): string {
  const text = value.replace(/\r\n|\r|\n/g, "\\n");
  const chars = [...text];
  return chars.length > maxLength
    ? `${chars.slice(0, maxLength - 1).join("")}…`
    : text;
}

/**
 * Columns separated by two spaces and padded to the widest value, with no
 * padding after the last column. `maxLengths` gives each column's cut.
 */
export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  maxLengths: readonly number[] = [],
): string[] {
  const lines = [headers, ...rows].map((row) =>
    row.map((cell, index) => cellText(cell, maxLengths[index])),
  );
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

/** Orders strings by UTF-16 code unit, independent of locale. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `yes` or `no`. */
export function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}
