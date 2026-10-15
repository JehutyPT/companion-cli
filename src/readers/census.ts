/**
 * `census`: counts how a database uses what the description format does and
 * does not support, to order the writer-extension tickets (#23–#27). It prints
 * counts and keys, never values: no option values, texts, names, labels,
 * expressions, notes, headlines, variable names, hold durations, connection
 * ids, `config` or `secrets`. Modules are named by `moduleId` (a public
 * package name), definitions as `<module>:<definitionId>`.
 *
 * A **tally** counts something that can occur several times in one control:
 * `{controls, occurrences}`.
 */
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { parseStoredJson } from "../core/database.ts";
import { type ReadOptions, readDatabase } from "../core/read.ts";
import { type Fields, isJsonObject } from "../core/validate.ts";
import { buttonLayers } from "../writers/button-control.ts";
import { INTERNAL_CONNECTION, readConnections } from "./connections-use.ts";
import { walkEntities } from "./entities.ts";
import { byCodeUnit, cellText } from "./list.ts";
import { readControls, readPageStore } from "./store.ts";

/** The census document's format version. */
export const CENSUS_VERSION = 1;

export interface TallyValue {
  controls: number;
  occurrences: number;
}

export interface Placement {
  total: number;
  placed: number;
  unplaced: number;
}

/** Counts per key: by distinct control and by occurrence. */
class Tally {
  readonly #entries = new Map<string, { ids: Set<string>; count: number }>();

  add(key: string, controlId: string, count = 1): void {
    if (count <= 0) return;
    const entry = this.#entries.get(key) ?? { ids: new Set(), count: 0 };
    entry.ids.add(controlId);
    entry.count += count;
    this.#entries.set(key, entry);
  }

  json(): Record<string, TallyValue> {
    return Object.fromEntries(
      [...this.#entries.keys()].sort(byCodeUnit).map((key) => {
        const { ids, count } = this.#entries.get(key)!;
        return [key, { controls: ids.size, occurrences: count }];
      }),
    );
  }
}

/** A tally of one thing. */
class Single {
  readonly #tally = new Tally();
  add(controlId: string, count = 1): void {
    this.#tally.add("", controlId, count);
  }
  json(): TallyValue {
    return this.#tally.json()[""] ?? { controls: 0, occurrences: 0 };
  }
}

/** Plain counts per key. */
class Counter {
  readonly #counts = new Map<string, number>();
  constructor(keys: readonly string[] = []) {
    for (const key of keys) this.#counts.set(key, 0);
  }
  add(key: string): void {
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
  }
  json(): Record<string, number> {
    return Object.fromEntries(
      [...this.#counts.keys()]
        .sort(byCodeUnit)
        .map((key) => [key, this.#counts.get(key)!]),
    );
  }
}

/** A tally by module and by definition. */
class ByDefinition {
  readonly byModule = new Tally();
  readonly byDefinition = new Tally();
  add(module: string, definition: string, controlId: string): void {
    this.byModule.add(module, controlId);
    this.byDefinition.add(definition, controlId);
  }
  json() {
    return {
      byModule: this.byModule.json(),
      byDefinition: this.byDefinition.json(),
    };
  }
}

/** The counters every action and feedback gets. */
class EntityStats {
  readonly occurrences = new ByDefinition();
  readonly expression = new ByDefinition();
  readonly disabled = new ByDefinition();
  readonly headline = new ByDefinition();
  readonly upgradeIndex = new ByDefinition();
  readonly children = new ByDefinition();
  readonly childGroups = new Tally();
  readonly storeResult = new Tally();

  add(entity: Fields, module: string, definition: string, id: string): void {
    const add = (stats: ByDefinition, when: boolean) => {
      if (when) stats.add(module, definition, id);
    };
    add(this.occurrences, true);
    add(this.expression, hasExpressionOption(entity));
    add(this.disabled, entity["disabled"] === true);
    add(this.headline, nonEmpty(entity["headline"]));
    add(this.upgradeIndex, typeof entity["upgradeIndex"] === "number");
    const children = entity["children"];
    const groups = isJsonObject(children)
      ? Object.keys(children).filter((group) => nonEmpty(children[group]))
      : [];
    add(this.children, groups.length > 0);
    for (const group of groups) this.childGroups.add(group, id);
    const storeResult = entity["storeResult"];
    if (storeResult !== undefined && storeResult !== null) {
      const type = isJsonObject(storeResult) ? storeResult["type"] : undefined;
      this.storeResult.add(typeof type === "string" ? type : "(other)", id);
    }
  }

  json() {
    return {
      occurrences: this.occurrences.json(),
      expression: this.expression.json(),
      disabled: this.disabled.json(),
      headline: this.headline.json(),
      upgradeIndex: this.upgradeIndex.json(),
      children: this.children.json(),
      childGroups: this.childGroups.json(),
      storeResult: this.storeResult.json(),
    };
  }
}

/** A value that is set: not missing, null, `""`, `[]` or `{}`. */
function nonEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isJsonObject(value)) return Object.keys(value).length > 0;
  return true;
}

const isExpression = (value: unknown) =>
  isJsonObject(value) && value["isExpression"] === true;

function hasExpressionOption(entity: Fields): boolean {
  const options = entity["options"];
  return isJsonObject(options) && Object.values(options).some(isExpression);
}

/** A histogram bucket: the count itself up to 2, then `3+`. */
function bucket(count: number): string {
  return count >= 3 ? "3+" : String(count);
}

/** The writers' button option defaults: a different value is counted. */
const OPTION_DEFAULTS: Readonly<Record<string, unknown>> = {
  stepProgression: "auto",
  stepExpression: "",
  rotaryActions: false,
  canModifyStyleInApis: false,
  notes: "",
};

/** A hold set's key: its duration, which is never printed. */
const HOLD_KEY = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

const NAMED_ACTION_SETS = new Set([
  "down",
  "up",
  "rotate_left",
  "rotate_right",
]);

/** Template layer properties whose value the writers fill per button. */
const FREE_PROPERTIES = new Set(["box0.color", "text0.text", "text0.color"]);

const TEMPLATE: readonly Fields[] = buttonLayers("", 0, 0);
const TEMPLATE_IDS = TEMPLATE.map((layer) => layer["id"] as string);

/** Counts one button's differences from the writers' four-layer template. */
class StyleStats {
  template = 0;
  image = 0;
  layerOrder = 0;
  readonly missingLayer = new Tally();
  readonly extraLayer = new Tally();
  readonly layerType = new Tally();
  readonly property = new Tally();
  readonly expression = new Tally();

  add(control: Fields, id: string): void {
    const style = control["style"];
    const layers = isJsonObject(style) ? style["layers"] : undefined;
    const stored = Array.isArray(layers) ? layers.filter(isJsonObject) : [];
    let differs = Array.isArray(layers) && stored.length !== layers.length;
    const diff = (tally: Tally, key: string) => {
      tally.add(key, id);
      differs = true;
    };
    const matched = new Map<string, Fields>();
    for (const layer of stored) {
      const layerId = layer["id"];
      if (
        typeof layerId === "string" &&
        TEMPLATE_IDS.includes(layerId) &&
        !matched.has(layerId)
      ) {
        matched.set(layerId, layer);
      } else {
        const type = layer["type"];
        diff(this.extraLayer, typeof type === "string" ? type : "(none)");
        for (const [key, value] of Object.entries(layer)) {
          if (isExpression(value)) diff(this.expression, `extra.${key}`);
        }
      }
    }
    const order = stored
      .map((layer) => layer["id"])
      .filter((layerId) => matched.get(layerId as string) !== undefined);
    const expectedOrder = TEMPLATE_IDS.filter((layerId) =>
      matched.has(layerId),
    );
    if (!isDeepStrictEqual([...new Set(order)], expectedOrder)) {
      this.layerOrder += 1;
      differs = true;
    }
    for (const template of TEMPLATE) {
      const layerId = template["id"] as string;
      const layer = matched.get(layerId);
      if (layer === undefined) {
        diff(this.missingLayer, layerId);
        continue;
      }
      if (layer["type"] !== template["type"]) diff(this.layerType, layerId);
      const keys = new Set([...Object.keys(template), ...Object.keys(layer)]);
      for (const key of [...keys].sort(byCodeUnit)) {
        const path = `${layerId}.${key}`;
        const value = layer[key];
        if (key === "type") continue;
        if (isExpression(value)) {
          diff(this.expression, path);
          continue;
        }
        if (path === "image0.base64Image") {
          const image = isJsonObject(value) ? value["value"] : value;
          if (image !== null && image !== undefined) {
            this.image += 1;
            differs = true;
            continue;
          }
        }
        const same = FREE_PROPERTIES.has(path)
          ? isJsonObject(value) &&
            isDeepStrictEqual(Object.keys(value).sort(byCodeUnit), [
              "isExpression",
              "value",
            ])
          : isDeepStrictEqual(value, template[key]);
        if (!same) diff(this.property, path);
      }
    }
    if (!differs) this.template += 1;
  }

  json() {
    return {
      template: this.template,
      differences: {
        image: this.image,
        layerOrder: this.layerOrder,
        missingLayer: this.missingLayer.json(),
        extraLayer: this.extraLayer.json(),
        layerType: this.layerType.json(),
        property: this.property.json(),
        expression: this.expression.json(),
      },
    };
  }
}

/** The census document, without its `database` and `version` fields. */
export type CensusCounts = ReturnType<typeof countDatabase>;

/** Counts one database, open read-only. */
export function countDatabase(db: DatabaseSync) {
  const modules = new Map<string, string>();
  for (const connection of readConnections(db)) {
    modules.set(connection.id, connection.moduleId ?? "(unknown)");
  }
  const moduleOf = (connectionId: unknown): string => {
    if (connectionId === INTERNAL_CONNECTION) return INTERNAL_CONNECTION;
    if (typeof connectionId !== "string" || connectionId === "")
      return "(none)";
    return modules.get(connectionId) ?? "(missing)";
  };
  const definitionOf = (entity: Fields, module: string) => {
    const definitionId = entity["definitionId"];
    return `${module}:${typeof definitionId === "string" ? definitionId : "(none)"}`;
  };

  const placedIds = new Set(
    readPageStore(db).pages.flatMap((page) =>
      page.cells.map((cell) => cell.controlId),
    ),
  );

  const types = new Map<string, Placement>();
  const entityTypes = new Tally();
  const buttons = {
    total: 0,
    notes: 0,
    rotaryActions: 0,
    options: new Counter(),
    stepProgression: new Counter(),
    canModifyStyleInApis: new Counter(["false", "missing", "true"]),
  };
  const steps = {
    counts: new Counter(["0", "1", "2", "3+"]),
    runWhileHeld: new Single(),
    actionSets: new Tally(),
    options: new Tally(),
  };
  const style = new StyleStats();
  const actions = new EntityStats();
  const feedbacks = new EntityStats();
  const feedbackOnly = {
    lists: new Tally(),
    styleOverrides: new Single(),
    inverted: new Single(),
    invertedExpression: new Single(),
    variableName: new Single(),
    elementProperty: new Tally(),
  };
  const localVariables = {
    controls: new Counter(),
    counts: new Counter(["1", "2", "3+"]),
    definitions: new ByDefinition(),
  };
  const triggers = {
    total: 0,
    disabled: 0,
    notes: 0,
    collection: 0,
    condition: 0,
    conditionDefinitions: new Tally(),
    events: new Tally(),
    disabledEvents: new Single(),
  };

  const controls = readControls(db);
  for (const id of [...controls.keys()].sort(byCodeUnit)) {
    const control = controls.get(id);
    const fields: Fields = isJsonObject(control) ? control : {};
    const rawType = fields["type"];
    const type = typeof rawType === "string" ? rawType : "(none)";
    const placement = types.get(type) ?? { total: 0, placed: 0, unplaced: 0 };
    placement.total += 1;
    if (placedIds.has(id)) placement.placed += 1;
    else placement.unplaced += 1;
    types.set(type, placement);

    walkEntities(fields, (entity, place) => {
      const entityType = entity["type"];
      entityTypes.add(
        typeof entityType === "string" ? entityType : "(none)",
        id,
      );
      const module = moduleOf(entity["connectionId"]);
      const definition = definitionOf(entity, module);
      if (place.list === "localVariables" && place.topLevel) {
        localVariables.definitions.add(module, definition, id);
      }
      if (place.list === "condition" && place.topLevel) {
        triggers.conditionDefinitions.add(definition, id);
      }
      if (entityType === "action") {
        actions.add(entity, module, definition, id);
      } else if (entityType === "feedback") {
        feedbacks.add(entity, module, definition, id);
        feedbackOnly.lists.add(place.list, id);
        const overrides = entity["styleOverrides"];
        if (nonEmpty(overrides)) feedbackOnly.styleOverrides.add(id);
        for (const override of Array.isArray(overrides) ? overrides : []) {
          const property = isJsonObject(override)
            ? override["elementProperty"]
            : undefined;
          feedbackOnly.elementProperty.add(
            typeof property === "string" ? property : "(none)",
            id,
          );
        }
        const inverted = entity["isInverted"];
        if (isExpression(inverted)) feedbackOnly.invertedExpression.add(id);
        else if (isJsonObject(inverted) && inverted["value"] === true)
          feedbackOnly.inverted.add(id);
        if (nonEmpty(entity["variableName"])) feedbackOnly.variableName.add(id);
      }
    });

    const locals = fields["localVariables"];
    if (Array.isArray(locals) && locals.length > 0) {
      localVariables.controls.add(type);
      localVariables.counts.add(bucket(locals.length));
    }

    if (type === "button-layered") {
      buttons.total += 1;
      const options = isJsonObject(fields["options"]) ? fields["options"] : {};
      for (const [key, value] of Object.entries(options)) {
        if (
          !Object.hasOwn(OPTION_DEFAULTS, key) ||
          !isDeepStrictEqual(value, OPTION_DEFAULTS[key])
        )
          buttons.options.add(key);
      }
      const progression = options["stepProgression"];
      buttons.stepProgression.add(
        progression === undefined
          ? "missing"
          : typeof progression === "string"
            ? progression
            : "(other)",
      );
      const canModify = options["canModifyStyleInApis"];
      buttons.canModifyStyleInApis.add(
        canModify === undefined
          ? "missing"
          : typeof canModify === "boolean"
            ? String(canModify)
            : "(other)",
      );
      if (nonEmpty(options["notes"])) buttons.notes += 1;
      if (options["rotaryActions"] === true) buttons.rotaryActions += 1;

      const stored = isJsonObject(fields["steps"]) ? fields["steps"] : {};
      steps.counts.add(bucket(Object.keys(stored).length));
      for (const step of Object.values(stored)) {
        if (!isJsonObject(step)) continue;
        const stepOptions = isJsonObject(step["options"])
          ? step["options"]
          : {};
        for (const [key, value] of Object.entries(stepOptions)) {
          if (key === "runWhileHeld") {
            if (nonEmpty(value)) steps.runWhileHeld.add(id);
          } else if (nonEmpty(value)) {
            steps.options.add(key, id);
          }
        }
        const sets = isJsonObject(step["action_sets"])
          ? step["action_sets"]
          : {};
        for (const [key, set] of Object.entries(sets)) {
          if (!nonEmpty(set)) continue;
          steps.actionSets.add(
            NAMED_ACTION_SETS.has(key)
              ? key
              : HOLD_KEY.test(key)
                ? "hold"
                : key,
            id,
          );
        }
      }
      style.add(fields, id);
    }

    if (type === "trigger") {
      triggers.total += 1;
      const options = isJsonObject(fields["options"]) ? fields["options"] : {};
      if (options["enabled"] !== true) triggers.disabled += 1;
      if (nonEmpty(options["notes"])) triggers.notes += 1;
      if (nonEmpty(options["collectionId"])) triggers.collection += 1;
      if (nonEmpty(fields["condition"])) triggers.condition += 1;
      const events = Array.isArray(fields["events"]) ? fields["events"] : [];
      for (const event of events) {
        const eventType = isJsonObject(event) ? event["type"] : undefined;
        triggers.events.add(
          typeof eventType === "string" ? eventType : "(none)",
          id,
        );
        if (isJsonObject(event) && event["enabled"] === false)
          triggers.disabledEvents.add(id);
      }
    }
  }

  const variables = { total: 0, persisted: 0, defaultTypes: new Counter() };
  for (const row of db.prepare("SELECT value FROM custom_variables").all()) {
    const value = parseStoredJson(row["value"]);
    if (!isJsonObject(value)) continue;
    variables.total += 1;
    if (value["persistCurrentValue"] === true) variables.persisted += 1;
    variables.defaultTypes.add(
      Object.hasOwn(value, "defaultValue")
        ? jsonType(value["defaultValue"])
        : "missing",
    );
  }

  return {
    controls: {
      types: Object.fromEntries(
        [...types.keys()].sort(byCodeUnit).map((key) => [key, types.get(key)!]),
      ),
      entityTypes: entityTypes.json(),
    },
    buttons: {
      total: buttons.total,
      notes: buttons.notes,
      rotaryActions: buttons.rotaryActions,
      options: buttons.options.json(),
      stepProgression: buttons.stepProgression.json(),
      canModifyStyleInApis: buttons.canModifyStyleInApis.json(),
    },
    steps: {
      runWhileHeld: steps.runWhileHeld.json(),
      counts: steps.counts.json(),
      actionSets: steps.actionSets.json(),
      options: steps.options.json(),
    },
    style: style.json(),
    actions: actions.json(),
    feedbacks: {
      ...feedbacks.json(),
      styleOverrides: feedbackOnly.styleOverrides.json(),
      inverted: feedbackOnly.inverted.json(),
      invertedExpression: feedbackOnly.invertedExpression.json(),
      variableName: feedbackOnly.variableName.json(),
      lists: feedbackOnly.lists.json(),
      elementProperty: feedbackOnly.elementProperty.json(),
    },
    localVariables: {
      controls: localVariables.controls.json(),
      counts: localVariables.counts.json(),
      ...localVariables.definitions.json(),
    },
    triggers: {
      total: triggers.total,
      disabled: triggers.disabled,
      notes: triggers.notes,
      collection: triggers.collection,
      condition: triggers.condition,
      disabledEvents: triggers.disabledEvents.json(),
      events: triggers.events.json(),
      conditionDefinitions: triggers.conditionDefinitions.json(),
    },
    variables: {
      total: variables.total,
      persisted: variables.persisted,
      defaultTypes: variables.defaultTypes.json(),
    },
    /** The export self-check (#18, #19) does not exist yet. */
    support: "not available",
  };
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** The census of the target database. `database` is left out on purpose. */
export function census(dbPath: string | undefined, options: ReadOptions) {
  const { value } = readDatabase(dbPath, options, countDatabase);
  return { database: null, version: CENSUS_VERSION, ...value };
}

export type Census = ReturnType<typeof census>;

export function censusJson(document: Census): string {
  return JSON.stringify(document);
}

const isTally = (value: unknown): value is TallyValue =>
  isJsonObject(value) &&
  isDeepStrictEqual(Object.keys(value), ["controls", "occurrences"]);

const isPlacement = (value: unknown): value is Placement =>
  isJsonObject(value) &&
  isDeepStrictEqual(Object.keys(value), ["total", "placed", "unplaced"]);

const isLeaf = (value: unknown) =>
  !isJsonObject(value) || isTally(value) || isPlacement(value);

function leafCount(value: unknown): number {
  if (typeof value === "number") return value;
  if (isTally(value)) return value.occurrences;
  if (isPlacement(value)) return value.total;
  return Number.NEGATIVE_INFINITY;
}

function leafText(value: unknown): string {
  if (isTally(value)) {
    return value.controls === value.occurrences
      ? String(value.occurrences)
      : `${value.occurrences} in ${value.controls} controls`;
  }
  if (isPlacement(value)) {
    return `${value.total} (${value.placed} placed, ${value.unplaced} unplaced)`;
  }
  return String(value);
}

/**
 * The text report: for each object in the document, a header (its dotted
 * path) and its counts as `key  count` lines, sorted by count descending,
 * then key; `(none)` for an empty one. Sections are separated by a blank line.
 */
export function renderCensus(document: Census): string[] {
  const sections: string[][] = [];
  const visit = (path: string, node: Record<string, unknown>) => {
    const leaves = Object.entries(node).filter(([, value]) => isLeaf(value));
    const hasChildren = leaves.length < Object.keys(node).length;
    if (leaves.length > 0 || !hasChildren) {
      leaves.sort(
        ([ka, a], [kb, b]) =>
          leafCount(b) - leafCount(a) || 0 || byCodeUnit(ka, kb),
      );
      const keys = leaves.map(([key]) => cellText(key, Infinity));
      const width = Math.max(0, ...keys.map((key) => [...key].length));
      sections.push([
        path,
        ...(leaves.length === 0
          ? ["  (none)"]
          : leaves.map(
              ([, value], index) =>
                `  ${keys[index]!}${" ".repeat(width - [...keys[index]!].length)}  ${leafText(value)}`,
            )),
      ]);
    }
    for (const [key, value] of Object.entries(node)) {
      if (!isLeaf(value)) visit(`${path}.${key}`, value as Fields);
    }
  };
  const { database: _database, version, ...counts } = document;
  sections.push([`census version ${version}`]);
  for (const [key, value] of Object.entries(counts)) {
    if (isLeaf(value)) sections.push([key, `  ${leafText(value)}`]);
    else visit(key, value as Fields);
  }
  return sections.flatMap((section, index) =>
    index === 0 ? section : ["", ...section],
  );
}
