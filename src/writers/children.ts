import { ValidationError } from "../core/errors.ts";
import {
  expectList,
  expectMapping,
  fieldPath,
  type Fields,
} from "../core/validate.ts";
import {
  type ActionSpec,
  actionReferences,
  buildAction,
  parseAction,
} from "./actions.ts";
import {
  buildFeedback,
  type FeedbackContext,
  feedbackReferences,
  type FeedbackSpec,
  parseFeedback,
} from "./feedbacks.ts";
import type { VariableReference } from "./shared.ts";

/**
 * `children` on an internal pass-through action or feedback (such as
 * `logic_if`): child entries by group name. Each child is a normal entry,
 * tagged `action:` or `feedback:`, parsed like a top-level one:
 *
 *   children:
 *     condition:
 *       - feedback: expression
 *         expression: "$(custom:fx_on) == 1"
 *     actions:
 *       - { action: set, variable: fx_label, value: "on" }
 *     else_actions: []
 *
 * actions.ts and feedbacks.ts import this module and it imports them; the
 * cycle is only used inside function bodies.
 */

export type ChildEntry =
  | { entity: "action"; spec: ActionSpec }
  | { entity: "feedback"; spec: FeedbackSpec };

/** Child entries by group, in file order. */
export type ChildGroups = Record<string, ChildEntry[]>;

/** Parses an entry's optional `children`. */
export function parseChildGroups(
  fields: Fields,
  path: string,
  context: FeedbackContext,
): ChildGroups | undefined {
  if (!Object.hasOwn(fields, "children")) return undefined;
  const childrenPath = fieldPath(path, "children");
  const groups = expectMapping(fields["children"], childrenPath);
  return Object.fromEntries(
    Object.entries(groups).map(([group, items]) => {
      const groupPath = fieldPath(childrenPath, group);
      if (group === "")
        throw new ValidationError(groupPath, "group names must not be empty");
      return [
        group,
        expectList(items, groupPath).map((item, index) =>
          parseChild(item, fieldPath(groupPath, index), context),
        ),
      ];
    }),
  );
}

function parseChild(
  item: unknown,
  path: string,
  context: FeedbackContext,
): ChildEntry {
  const fields = expectMapping(item, path);
  if (Object.hasOwn(fields, "action"))
    return { entity: "action", spec: parseAction(fields, path) };
  if (Object.hasOwn(fields, "feedback"))
    return { entity: "feedback", spec: parseFeedback(fields, path, context) };
  throw new ValidationError(
    path,
    "must be an action or a feedback entry (tagged `action:` or `feedback:`)",
  );
}

/** The custom variables the children use, in file order. */
export function childReferences(
  groups: ChildGroups | undefined,
  path: string,
): VariableReference[] {
  if (!groups) return [];
  return Object.entries(groups).flatMap(([group, entries]) =>
    entries.flatMap((child, index) => {
      const childPath = fieldPath(fieldPath(path, group), index);
      return child.entity === "action"
        ? actionReferences(child.spec, childPath)
        : feedbackReferences(child.spec, childPath);
    }),
  );
}

/** The stored child groups, with fresh ids. */
export function buildChildGroups(
  groups: ChildGroups,
): Record<string, Record<string, unknown>[]> {
  return Object.fromEntries(
    Object.entries(groups).map(([group, entries]) => [
      group,
      entries.map((child) =>
        child.entity === "action"
          ? buildAction(child.spec)
          : buildFeedback(child.spec),
      ),
    ]),
  );
}
