/**
 * `find`: the stored controls that use a custom variable, a connection or a
 * text, each with the paths inside it that matched.
 *
 * Every query is a deep scan of the stored JSON (one walker over every leaf),
 * not of the writers' known shapes, so content Companion made is found too.
 * Paths are rendered in description-file terms where a writer has one
 * (`down[0].variable`, `feedbacks[1].style.text`), otherwise as the stored
 * JSON path with wrapped option values collapsed (`style.layers[3].text`).
 *
 * Scan order: each loaded page (its name, for text search), then its button
 * controls in row and column order; then `bank:` controls placed on no loaded
 * page, by id; then triggers, by `sortOrder`, then id.
 */
import type { DatabaseSync } from "node:sqlite";
import { CliError } from "../core/errors.ts";
import { matchesNamePatterns } from "../core/patterns.ts";
import { type ReadOptions, readDatabase } from "../core/read.ts";
import { fieldPath, isJsonObject } from "../core/validate.ts";
import { STYLE_FIELDS } from "../writers/feedbacks.ts";
import { customReferences } from "../writers/shared.ts";
import { readTriggers } from "../writers/trigger.ts";
import {
  INTERNAL_CONNECTION,
  readConnections,
  referencedLabels,
} from "./connections-use.ts";
import {
  byCodeUnit,
  bySortOrderThen,
  MAX_CELL_LENGTH,
  renderTable,
} from "./list.ts";
import { readControls, readPageStore } from "./store.ts";
import { variablesLister } from "./variables.ts";

export type FindQuery =
  { variable: string } | { connection: string } | { text: string };

interface Connection {
  id: string;
  label: string;
}

export interface FindMatch {
  kind: "button" | "unplaced" | "trigger" | "page";
  page: number | null;
  row: number | null;
  column: number | null;
  controlId: string | null;
  triggerName: string | null;
  /** Every matching path, in stored order, each once. */
  paths: string[];
  /** For `--connection`: the connections the control matched through. */
  connections?: Connection[];
}

export interface FindResult {
  database: string;
  query: FindQuery;
  /** Fields of the JSON document between `query` and `matches`. */
  document: Record<string, unknown>;
  matches: FindMatch[];
  /** A line printed after the matches. */
  note: string | null;
}

/** Paths shown per match in text output; `+N more` follows. */
const SHOWN_PATHS = 3;

const hasWildcard = (pattern: string) => /[*?]/.test(pattern);

// ---------------------------------------------------------------------------
// The walker

type Segment = string | number;

interface Leaf {
  path: Segment[];
  value: string | number | boolean;
  /** `ancestors[i]` is the container `path[i]` indexes. */
  ancestors: unknown[];
}

function walkLeaves(root: unknown, visit: (leaf: Leaf) => void): void {
  const go = (value: unknown, path: Segment[], ancestors: unknown[]) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        go(item, [...path, index], [...ancestors, value]),
      );
    } else if (isJsonObject(value)) {
      for (const [key, item] of Object.entries(value))
        go(item, [...path, key], [...ancestors, value]);
    } else if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      visit({ path, value, ancestors });
    }
  };
  go(root, [], []);
}

/** An action or feedback: a string `definitionId` and an `options` object. */
function isEntity(value: unknown): value is Record<string, unknown> {
  return (
    isJsonObject(value) &&
    typeof value["definitionId"] === "string" &&
    isJsonObject(value["options"])
  );
}

/** A wrapped option value: exactly `value` and a boolean `isExpression`. */
function isWrapper(value: unknown): value is Record<string, unknown> {
  if (!isJsonObject(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    Object.hasOwn(value, "value") &&
    typeof value["isExpression"] === "boolean"
  );
}

const isTrigger = (control: unknown) =>
  isJsonObject(control) && control["type"] === "trigger";

/** Whether the leaf sits in an action's or feedback's `options`. */
function inEntityOptions({ path, ancestors }: Leaf): boolean {
  return path.some(
    (segment, index) => segment === "options" && isEntity(ancestors[index]),
  );
}

/**
 * The index in the leaf's path of the key its value is stored under: the
 * wrapper's key for a wrapped option value, else the last segment.
 * `ancestors[index]` is the object holding that key.
 */
function valueKeyIndex({ path, ancestors }: Leaf): number {
  const last = path.length - 1;
  return path[last] === "value" && isWrapper(ancestors[last]) ? last - 1 : last;
}

/** Whether the leaf is a wrapper's `isExpression` flag, not a value. */
function isExpressionFlag({ path, ancestors }: Leaf): boolean {
  return path.at(-1) === "isExpression" && isWrapper(ancestors.at(-1));
}

// ---------------------------------------------------------------------------
// Path rendering

const get = (value: unknown, segment: Segment): unknown =>
  Array.isArray(value)
    ? value[segment as number]
    : isJsonObject(value)
      ? value[segment as string]
      : undefined;

/** `path` without the `.value` of each wrapped option value it passes. */
function collapsed(root: unknown, path: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  let node = root;
  for (const segment of path) {
    if (!(segment === "value" && isWrapper(node))) out.push(segment);
    node = get(node, segment);
  }
  return out;
}

const join = (prefix: string, segments: readonly Segment[]) =>
  segments.reduce<string>((path, segment) => fieldPath(path, segment), prefix);

const at = (root: unknown, segments: readonly Segment[]) =>
  segments.reduce<unknown>(get, root);

/** Description terms of the internal entities the writers produce, by option. */
const INTERNAL_TERMS: Record<
  string,
  Record<string, (option: unknown) => string>
> = {
  custom_variable_set_value: {
    name: () => "variable",
    value: (option) =>
      isJsonObject(option) && option["isExpression"] === true
        ? "expression"
        : "value",
  },
  check_expression: { expression: () => "expression" },
  bank_current_step: { step: () => "step" },
};

/** A feedback style override's description field, such as `text`. */
function styleField(override: unknown): string | undefined {
  if (!isJsonObject(override)) return undefined;
  return Object.entries(STYLE_FIELDS).find(
    ([, [elementId, property]]) =>
      override["elementId"] === elementId &&
      override["elementProperty"] === property,
  )?.[0];
}

/** `rest`, a collapsed path inside `entity`, under `prefix`. */
function entityPath(entity: unknown, rest: Segment[], prefix: string): string {
  if (!isEntity(entity) || rest.length === 0) return join(prefix, rest);
  const options = entity["options"] as Record<string, unknown>;
  const terms =
    entity["connectionId"] === INTERNAL_CONNECTION
      ? INTERNAL_TERMS[entity["definitionId"] as string]
      : undefined;
  const [first, second, third] = rest;
  if (rest.length === 2 && first === "options" && terms) {
    const term = terms[second as string];
    if (term) return fieldPath(prefix, term(options[second as string]));
  }
  if (!terms && rest.length === 1 && first === "connectionId")
    return fieldPath(prefix, "connection");
  if (!terms && rest.length === 1 && first === "definitionId")
    return fieldPath(prefix, "definition");
  if (rest.length === 3 && first === "styleOverrides" && third === "override") {
    const field = styleField(at(entity, rest.slice(0, 2)));
    if (field) return fieldPath(fieldPath(prefix, "style"), field);
  }
  if (
    first === "children" &&
    typeof second === "string" &&
    typeof third === "number"
  ) {
    return entityPath(
      at(entity, rest.slice(0, 3)),
      rest.slice(3),
      join(prefix, rest.slice(0, 3)),
    );
  }
  return join(prefix, rest);
}

/** Description terms for a path in a button control, when it has them. */
function buttonPath(control: unknown, s: Segment[]): string | undefined {
  if (
    s.length === 4 &&
    s[0] === "style" &&
    s[1] === "layers" &&
    s[3] === "text" &&
    get(at(control, s.slice(0, 3)), "id") === "text0"
  )
    return "text";
  if (
    s[0] === "steps" &&
    s[2] === "action_sets" &&
    typeof s[3] === "string" &&
    typeof s[4] === "number"
  ) {
    const steps = get(control, "steps");
    const single = isJsonObject(steps) && Object.keys(steps).length === 1;
    const list = fieldPath(single ? "" : `steps[${s[1]}]`, s[3]);
    return entityPath(
      at(control, s.slice(0, 5)),
      s.slice(5),
      fieldPath(list, s[4]),
    );
  }
  if (
    (s[0] === "feedbacks" || s[0] === "localVariables") &&
    typeof s[1] === "number"
  )
    return entityPath(
      at(control, s.slice(0, 2)),
      s.slice(2),
      join("", s.slice(0, 2)),
    );
  return undefined;
}

/** Whether a path inside a trigger is its name, `options.name`. */
const isTriggerName = (path: readonly Segment[]) =>
  path.length === 2 && path[0] === "options" && path[1] === "name";

/** Event options with description terms, by event type. */
const EVENT_TERMS: Record<string, Record<string, string>> = {
  variable_changed: { variableId: "variable" },
  startup: { delay: "delay" },
  interval: { seconds: "seconds" },
};

/** Description terms for a path in a trigger control, when it has them. */
function triggerPath(control: unknown, s: Segment[]): string | undefined {
  if (isTriggerName(s)) return "name";
  if (s.length === 4 && s[0] === "events" && s[2] === "options") {
    const type = get(at(control, s.slice(0, 2)), "type");
    const term =
      typeof type === "string"
        ? EVENT_TERMS[type]?.[s[3] as string]
        : undefined;
    if (term) return fieldPath(join("", s.slice(0, 2)), term);
  }
  if (
    (s[0] === "actions" || s[0] === "condition" || s[0] === "localVariables") &&
    typeof s[1] === "number"
  )
    return entityPath(
      at(control, s.slice(0, 2)),
      s.slice(2),
      join("", s.slice(0, 2)),
    );
  return undefined;
}

/** A path inside a stored control, as `find` prints it. */
function renderPath(control: unknown, path: readonly Segment[]): string {
  const segments = collapsed(control, path);
  return (
    (isTrigger(control)
      ? triggerPath(control, segments)
      : buttonPath(control, segments)) ?? join("", segments)
  );
}

// ---------------------------------------------------------------------------
// Queries: each finds the matching leaves of one control

/** A matching leaf, and what it matched through (a variable or connection). */
interface Hit {
  path: Segment[];
  keys: string[];
}

type Matcher = (control: unknown) => Hit[];

/** Every custom variable name a leaf uses, by the three `--variable` rules. */
function variableNames(control: unknown, leaf: Leaf): string[] {
  const { path, ancestors, value } = leaf;
  if (typeof value !== "string") return [];
  const names = customReferences(value, "").map(({ name }) => name);
  const key = valueKeyIndex(leaf);
  const entity = ancestors[key - 1];
  if (
    key === path.length - 2 &&
    path[key] === "name" &&
    path[key - 1] === "options" &&
    isEntity(entity) &&
    entity["connectionId"] === INTERNAL_CONNECTION
  )
    names.push(value);
  if (
    isTrigger(control) &&
    path.length === 4 &&
    path[0] === "events" &&
    path[2] === "options" &&
    path[3] === "variableId" &&
    value.startsWith("custom:")
  )
    names.push(value.slice("custom:".length));
  return names;
}

function variableMatcher(pattern: string, seen: Set<string>): Matcher {
  return (control) => {
    const hits: Hit[] = [];
    walkLeaves(control, (leaf) => {
      const names = variableNames(control, leaf);
      for (const name of names) seen.add(name);
      const keys = names.filter((name) => matchesNamePatterns(name, [pattern]));
      if (keys.length > 0) hits.push({ path: leaf.path, keys });
    });
    return hits;
  };
}

function connectionMatcher(matched: readonly Connection[]): Matcher {
  const ids = new Set(matched.map(({ id }) => id));
  const byLabel = new Map<string, string[]>();
  for (const { id, label } of matched)
    byLabel.set(label, [...(byLabel.get(label) ?? []), id]);
  return (control) => {
    const hits: Hit[] = [];
    walkLeaves(control, (leaf) => {
      const { path, ancestors, value } = leaf;
      if (typeof value !== "string") return;
      const keys = referencedLabels(value).flatMap(
        (label) => byLabel.get(label) ?? [],
      );
      if (
        path.at(-1) === "connectionId" &&
        isJsonObject(ancestors.at(-1)) &&
        ids.has(value)
      )
        keys.push(value);
      if (keys.length > 0) hits.push({ path, keys });
    });
    return hits;
  };
}

/** Folds case as the text search compares: `toLocaleLowerCase("und")`. */
const fold = (text: string) => text.toLocaleLowerCase("und");

/** Stored button text, with its literal backslash-n read as a line break. */
const asLines = (text: string) => text.replaceAll("\\n", "\n");

/** Whether `leaf` is a `button-layered` control's `text0` layer text. */
function isLayerText(control: unknown, { path, ancestors }: Leaf): boolean {
  return (
    isJsonObject(control) &&
    control["type"] === "button-layered" &&
    path.length === 5 &&
    path[0] === "style" &&
    path[1] === "layers" &&
    path[3] === "text" &&
    path[4] === "value" &&
    get(ancestors[3], "id") === "text0"
  );
}

/** Whether `leaf` is a feedback style override of `text`. */
function isOverrideText(leaf: Leaf): boolean {
  const key = valueKeyIndex(leaf);
  const override = leaf.ancestors[key];
  return (
    typeof leaf.value === "string" &&
    leaf.path[key] === "override" &&
    isJsonObject(override) &&
    override["elementProperty"] === "text" &&
    leaf.path[key - 2] === "styleOverrides"
  );
}

function textMatcher(text: string): Matcher {
  const needle = fold(text);
  const has = (value: string) => fold(value).includes(needle);
  return (control) => {
    const hits: Hit[] = [];
    walkLeaves(control, (leaf) => {
      const { path, value } = leaf;
      let matched: boolean;
      if (typeof value === "string" && isLayerText(control, leaf)) {
        matched = has(asLines(value));
      } else if (typeof value === "string" && isOverrideText(leaf)) {
        matched = has(asLines(value));
      } else if (isTrigger(control) && isTriggerName(path)) {
        matched = typeof value === "string" && has(value);
      } else if (inEntityOptions(leaf) && !isExpressionFlag(leaf)) {
        matched = has(
          typeof value === "string" ? value : JSON.stringify(value),
        );
      } else {
        matched = false;
      }
      if (matched) hits.push({ path, keys: [] });
    });
    return hits;
  };
}

// ---------------------------------------------------------------------------
// The scan

type Located = Omit<FindMatch, "paths" | "connections">;

interface Scanned {
  location: Located;
  control: unknown;
}

const NO_LOCATION = { page: null, row: null, column: null } as const;

/** Pages (as `null` controls with a name), placed and unplaced buttons, triggers. */
function scanTargets(db: DatabaseSync): Array<Scanned & { name?: string }> {
  const controls = readControls(db);
  const targets: Array<Scanned & { name?: string }> = [];
  const placed = new Set<string>();
  for (const { page, value, cells } of readPageStore(db).pages) {
    const name = value["name"];
    targets.push({
      location: {
        kind: "page",
        page,
        row: null,
        column: null,
        controlId: null,
        triggerName: null,
      },
      control: null,
      ...(typeof name === "string" ? { name } : {}),
    });
    for (const { row, column, controlId } of cells) {
      if (!controlId.startsWith("bank:") || !controls.has(controlId)) continue;
      placed.add(controlId);
      targets.push({
        location: {
          kind: "button",
          page,
          row,
          column,
          controlId,
          triggerName: null,
        },
        control: controls.get(controlId),
      });
    }
  }
  for (const controlId of [...controls.keys()].sort(byCodeUnit)) {
    if (!controlId.startsWith("bank:") || placed.has(controlId)) continue;
    targets.push({
      location: {
        kind: "unplaced",
        ...NO_LOCATION,
        controlId,
        triggerName: null,
      },
      control: controls.get(controlId),
    });
  }
  const triggers = readTriggers(db).sort(
    bySortOrderThen(
      ({ options }) =>
        typeof options["sortOrder"] === "number"
          ? options["sortOrder"]
          : undefined,
      ({ id }) => id,
    ),
  );
  for (const { id, options, control } of triggers) {
    const name = options["name"];
    targets.push({
      location: {
        kind: "trigger",
        ...NO_LOCATION,
        controlId: id,
        triggerName:
          typeof name === "string" ? name : JSON.stringify(name ?? null),
      },
      control,
    });
  }
  return targets;
}

/** The matches of `matcher`; `pageName` decides whether a page name matches. */
function scan(
  db: DatabaseSync,
  matcher: Matcher,
  pageName: (name: string) => boolean,
  connections?: readonly Connection[],
): FindMatch[] {
  const matches: FindMatch[] = [];
  for (const { location, control, name } of scanTargets(db)) {
    if (location.kind === "page") {
      if (name !== undefined && pageName(name))
        matches.push({ ...location, paths: ["name"] });
      continue;
    }
    const hits = matcher(control);
    if (hits.length === 0) continue;
    const paths = [
      ...new Set(hits.map((hit) => renderPath(control, hit.path))),
    ];
    const match: FindMatch = { ...location, paths };
    if (connections) {
      const keys = new Set(hits.flatMap((hit) => hit.keys));
      match.connections = connections.filter(({ id }) => keys.has(id));
    }
    matches.push(match);
  }
  return matches;
}

function findVariable(db: DatabaseSync, pattern: string) {
  const seen = new Set<string>();
  const matches = scan(db, variableMatcher(pattern, seen), () => false);
  const stored = new Set(variablesLister.read(db).map(({ name }) => name));
  const names = hasWildcard(pattern)
    ? [...new Set([...stored, ...seen])]
        .filter((name) => matchesNamePatterns(name, [pattern]))
        .sort(byCodeUnit)
    : [pattern];
  const exists = hasWildcard(pattern) ? null : stored.has(pattern);
  return {
    document: {
      variables: names.map((name) => ({ name, exists: stored.has(name) })),
      exists,
    },
    matches,
    note:
      exists === false ? `note: no custom variable "${pattern}" exists` : null,
  };
}

function findConnection(db: DatabaseSync, pattern: string) {
  const connections: Connection[] = [
    { id: INTERNAL_CONNECTION, label: INTERNAL_CONNECTION },
    ...readConnections(db).map(({ id, label }) => ({ id, label })),
  ];
  const matched = connections.filter(({ label }) =>
    matchesNamePatterns(label, [pattern]),
  );
  if (matched.length === 0 && !hasWildcard(pattern)) {
    throw new CliError(`no connection labelled "${pattern}"`, {
      code: "not_found",
      hint: "run companion-cli list connections",
    });
  }
  return {
    document: { connections: matched },
    matches: scan(db, connectionMatcher(matched), () => false, matched),
    note: null,
  };
}

function findText(db: DatabaseSync, text: string) {
  const needle = fold(text);
  return {
    document: {},
    matches: scan(db, textMatcher(text), (name) => fold(name).includes(needle)),
    note: null,
  };
}

/** Runs one query on a read-only snapshot of the database. */
export function find(
  query: FindQuery,
  dbPath: string | undefined,
  options: ReadOptions,
): FindResult {
  const { database, value } = readDatabase(dbPath, options, (db) =>
    "variable" in query
      ? findVariable(db, query.variable)
      : "connection" in query
        ? findConnection(db, query.connection)
        : findText(db, query.text),
  );
  return { database, query, ...value };
}

// ---------------------------------------------------------------------------
// Output

function whereText(match: FindMatch): string {
  switch (match.kind) {
    case "button":
      return `page ${match.page} row ${match.row} column ${match.column}`;
    case "page":
      return `page ${match.page} name`;
    case "unplaced":
      return "unplaced";
    case "trigger":
      return `trigger "${match.triggerName}"`;
  }
}

function pathsText(match: FindMatch): string {
  if (match.kind === "page") return "";
  const shown = match.paths.slice(0, SHOWN_PATHS);
  const more = match.paths.length - shown.length;
  return [...shown, ...(more > 0 ? [`+${more} more`] : [])].join(", ");
}

function viaText(connections: readonly Connection[]): string {
  return connections
    .map(({ id, label }) =>
      id === INTERNAL_CONNECTION ? INTERNAL_CONNECTION : `${label} (${id})`,
    )
    .join(", ");
}

/** One line per match (a headerless table), then the note. */
export function renderFind(result: FindResult): string[] {
  const via = "connection" in result.query;
  const rows = result.matches.map((match) => [
    whereText(match),
    match.controlId ?? "",
    ...(via ? [viaText(match.connections ?? [])] : []),
    pathsText(match),
  ]);
  const lines =
    rows.length === 0
      ? []
      : renderTable(
          rows[0]?.map(() => "") ?? [],
          rows,
          rows[0]?.map((_, index) =>
            index === 0 ? MAX_CELL_LENGTH : Number.POSITIVE_INFINITY,
          ),
        ).slice(1);
  return result.note === null ? lines : [...lines, result.note];
}

/** The `--json` document. */
export function findJson(result: FindResult): string {
  return JSON.stringify({
    database: result.database,
    query: result.query,
    ...result.document,
    matches: result.matches,
  });
}
