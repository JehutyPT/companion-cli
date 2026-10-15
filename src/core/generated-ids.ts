import { isDeepStrictEqual } from "node:util";

/**
 * Ids the writers generate, which are not changes in a dry run (ADR 0005).
 *
 * Inside a control, only the positions the writers fill with `newId()` are
 * masked, and only when they hold a 21-character nanoid:
 *
 *  - the `id` of each entity (action or feedback) in
 *    `steps.<step>.action_sets.<set>` (button actions), `actions` and
 *    `condition` (trigger actions and conditions) and `feedbacks`;
 *  - each such entity's `styleOverrides[j].overrideId`;
 *  - the same, at any depth, for the entities in an entity's
 *    `children.<group>` lists;
 *  - `events[i].id` (trigger events).
 *
 * Nothing else is masked: never anything under an entry's `options`, where a
 * connection id or another nanoid may be the very value a description changes.
 * New button controls get a fresh `bank:` id; `pairRenamedControls` pairs it
 * with the control it replaced at the same page cell.
 */

const NANOID = /^[A-Za-z0-9_-]{21}$/;
const GENERATED = "<generated id>";

/** A stored row, as far as pairing needs it: its parsed value. */
export interface StoredValue {
  value: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `entry` with `entry[key]` masked when it holds a nanoid. */
function maskKey(entry: unknown, key: string): unknown {
  if (!isObject(entry)) return entry;
  const id = entry[key];
  return typeof id === "string" && NANOID.test(id)
    ? { ...entry, [key]: GENERATED }
    : entry;
}

/** Each entry of a list with its top-level `id` masked. */
function maskEntries(
  list: unknown,
  mask: (entry: unknown) => unknown = (entry) => maskKey(entry, "id"),
): unknown {
  return Array.isArray(list) ? list.map(mask) : list;
}

/**
 * An action or feedback with its `id`, its style overrides' `overrideId`s
 * and, recursively, its `children` entities' ids masked.
 */
function maskEntity(entry: unknown): unknown {
  const masked = maskKey(entry, "id");
  if (!isObject(masked)) return masked;
  const result: Record<string, unknown> = { ...masked };
  if ("styleOverrides" in masked)
    result["styleOverrides"] = maskEntries(
      masked["styleOverrides"],
      (override) => maskKey(override, "overrideId"),
    );
  if ("children" in masked)
    result["children"] = mapValues(masked["children"], (group) =>
      maskEntries(group, maskEntity),
    );
  return result;
}

function mapValues(value: unknown, fn: (child: unknown) => unknown): unknown {
  return isObject(value)
    ? Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, fn(child)]),
      )
    : value;
}

/** A control value with the writers' generated ids replaced by a placeholder. */
export function maskGeneratedIds(control: unknown): unknown {
  if (!isObject(control)) return control;
  const masked: Record<string, unknown> = { ...control };
  if ("steps" in control) {
    masked["steps"] = mapValues(control["steps"], (step) =>
      isObject(step)
        ? {
            ...step,
            action_sets: mapValues(step["action_sets"], (set) =>
              maskEntries(set, maskEntity),
            ),
          }
        : step,
    );
  }
  for (const key of ["actions", "condition", "feedbacks"]) {
    if (key in control) masked[key] = maskEntries(control[key], maskEntity);
  }
  if ("events" in control) masked["events"] = maskEntries(control["events"]);
  return masked;
}

/** Whether two control values are equal once generated ids are masked. */
export function equalButGeneratedIds(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(maskGeneratedIds(a), maskGeneratedIds(b));
}

/** A page row's cells as `row/column` to stored value; anything malformed is skipped. */
export function pageCells(value: unknown): Map<string, unknown> {
  const cells = new Map<string, unknown>();
  if (!isObject(value) || !isObject(value["controls"])) return cells;
  for (const [row, columns] of Object.entries(value["controls"])) {
    if (!isObject(columns)) continue;
    for (const [column, cell] of Object.entries(columns)) {
      if (cell !== null && cell !== undefined)
        cells.set(`${row}/${column}`, cell);
    }
  }
  return cells;
}

/** A page row with each renamed control id replaced by its new id. */
export function renameCells(
  value: unknown,
  renamed: ReadonlyMap<string, string>,
): unknown {
  if (renamed.size === 0 || !isObject(value) || !isObject(value["controls"]))
    return value;
  const controls = mapValues(value["controls"], (columns) =>
    mapValues(columns, (cell) =>
      typeof cell === "string" ? (renamed.get(cell) ?? cell) : cell,
    ),
  );
  return { ...value, controls };
}

/**
 * Each control id placed at exactly one location, with that location. A
 * control placed twice is left out, so it is never paired.
 */
function controlLocations(
  pages: ReadonlyMap<string, StoredValue> | undefined,
): Map<string, string> {
  const found = new Map<string, string | null>();
  for (const [page, row] of pages ?? []) {
    for (const [cell, id] of pageCells(row.value)) {
      if (typeof id !== "string") continue;
      found.set(id, found.has(id) ? null : `${page}/${cell}`);
    }
  }
  const locations = new Map<string, string>();
  for (const [id, location] of found) {
    if (location !== null) locations.set(id, location);
  }
  return locations;
}

type Tables = ReadonlyMap<string, ReadonlyMap<string, StoredValue>>;

/**
 * Pairs each removed control with the control added at its location when the
 * two are equal but for generated ids: old id to new id. A control whose
 * content changed is never paired, so it stays a removal and an addition.
 */
export function pairRenamedControls(
  before: Tables,
  after: Tables,
): Map<string, string> {
  const renamed = new Map<string, string>();
  const controlsBefore = before.get("controls");
  const controlsAfter = after.get("controls");
  if (!controlsBefore || !controlsAfter) return renamed;
  const locationsBefore = controlLocations(before.get("pages"));
  const idsAfterByLocation = new Map(
    [...controlLocations(after.get("pages"))].map(([id, location]) => [
      location,
      id,
    ]),
  );
  for (const [oldId, oldRow] of controlsBefore) {
    if (controlsAfter.has(oldId)) continue;
    const location = locationsBefore.get(oldId);
    const newId =
      location === undefined ? undefined : idsAfterByLocation.get(location);
    if (newId === undefined || controlsBefore.has(newId)) continue;
    const newRow = controlsAfter.get(newId);
    if (newRow && equalButGeneratedIds(oldRow.value, newRow.value)) {
      renamed.set(oldId, newId);
    }
  }
  return renamed;
}
