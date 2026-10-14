import { ValidationError } from "../core/errors.ts";
import { expectString } from "../core/validate.ts";

/**
 * Companion shapes and rules shared by several writers. Writers import from
 * here, never from a sibling writer.
 */

/** A wrapped option value, as Companion stores options in layers, actions and feedbacks. */
export function prop<T>(
  value: T,
  isExpression = false,
): { value: T; isExpression: boolean } {
  return { value, isExpression };
}

/**
 * Companion 5.1's own name rule, from `createVariable` in its bundled main.js:
 * a name is valid when replacing `[^\w]` with `_` leaves it unchanged (that is,
 * non-empty and only ASCII letters, digits and `_`), and it is not one of these
 * reserved object keys.
 */
const VALID_NAME = /^\w+$/;
const RESERVED_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/**
 * Stricter than Companion: the `id` column is declared `STRING`, which SQLite
 * gives NUMERIC affinity, so a name such as `007` or `1e5` is stored as the
 * number 7 or 100000. Those names pass Companion's rule but cannot round-trip.
 */
const NUMERIC_NAME = /^\d+(?:[eE]\d+)?$/;

/** Validates a custom variable name, for definitions and references alike. */
export function parseVariableName(value: unknown, field: string): string {
  const name = expectString(value, field);
  if (!VALID_NAME.test(name)) {
    throw new ValidationError(
      field,
      `invalid variable name "${name}": use only letters A-Z/a-z, digits and _ (Companion's rule for $(custom:<name>))`,
    );
  }
  if (RESERVED_NAMES.has(name)) {
    throw new ValidationError(
      field,
      `variable name "${name}" is reserved by Companion`,
    );
  }
  if (NUMERIC_NAME.test(name)) {
    throw new ValidationError(
      field,
      `variable name "${name}" looks like a number; Companion's database would store it as ${Number(name)} and lose the name`,
    );
  }
  return name;
}
