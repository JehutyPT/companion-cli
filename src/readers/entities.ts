/**
 * Walks the entities (actions and feedbacks) a stored control holds, for the
 * census and meant for `find` (#14).
 *
 * Companion 5.1 (shared-lib/lib/Model: ButtonModel, TriggerModel,
 * EntityModel) keeps entities in a button's `steps[*].action_sets[*]` (the
 * named sets and the hold sets keyed by duration), its `feedbacks` and
 * `localVariables`, and a trigger's `actions`, `condition` and
 * `localVariables`. An entity may hold child entities in `children`, a
 * record of group id to entity list.
 */
import { type Fields, isJsonObject } from "../core/validate.ts";

/** The list an entity sits in. */
export type EntityList =
  "actions" | "feedbacks" | "condition" | "localVariables" | "children";

export interface EntityPlace {
  list: EntityList;
  /** The child group id, for `children`. */
  group?: string;
  /** Whether the entity is directly in the control's list, not a child. */
  topLevel: boolean;
}

const objects = (value: unknown): Fields[] =>
  Array.isArray(value) ? value.filter(isJsonObject) : [];

/**
 * Calls `visit` for every entity object in `control`, parents before their
 * children, in stored order. Entries that are not objects are skipped.
 */
export function walkEntities(
  control: unknown,
  visit: (entity: Fields, place: EntityPlace) => void,
): void {
  if (!isJsonObject(control)) return;
  const walk = (entity: Fields, place: EntityPlace) => {
    visit(entity, place);
    const children = entity["children"];
    if (!isJsonObject(children)) return;
    for (const [group, list] of Object.entries(children)) {
      for (const child of objects(list)) {
        walk(child, { list: "children", group, topLevel: false });
      }
    }
  };
  const top = (value: unknown, list: EntityList) => {
    for (const entity of objects(value)) walk(entity, { list, topLevel: true });
  };
  const steps = control["steps"];
  if (isJsonObject(steps)) {
    for (const step of Object.values(steps)) {
      if (!isJsonObject(step) || !isJsonObject(step["action_sets"])) continue;
      for (const set of Object.values(step["action_sets"])) top(set, "actions");
    }
  }
  top(control["actions"], "actions");
  top(control["feedbacks"], "feedbacks");
  top(control["condition"], "condition");
  top(control["localVariables"], "localVariables");
}
