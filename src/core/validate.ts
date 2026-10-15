import { ValidationError } from "./errors.ts";

/**
 * Small helpers for validating parsed description files. Every failure names
 * the offending field as a path (`variables[2].persist`), so errors point at
 * the exact place in the file.
 */

export type Fields = Record<string, unknown>;

export function fieldPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return parent ? `${parent}.${key}` : key;
}

export function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "a mapping";
  return `a ${typeof value}`;
}

/** A JSON object: not null, not a list. */
export function isJsonObject(value: unknown): value is Fields {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function expectMapping(value: unknown, field: string): Fields {
  if (!isJsonObject(value)) {
    throw new ValidationError(
      field,
      `must be a mapping, got ${describeType(value)}`,
    );
  }
  return value as Fields;
}

export function expectList(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(
      field,
      `must be a list, got ${describeType(value)}`,
    );
  }
  return value;
}

/** Rejects any key of `fields` not in `allowed`, naming the first unknown one. */
export function rejectUnknownFields(
  fields: Fields,
  allowed: readonly string[],
  parent: string,
): void {
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) {
      throw new ValidationError(fieldPath(parent, key), "unknown field");
    }
  }
}

export function requireField(
  fields: Fields,
  key: string,
  parent: string,
): unknown {
  if (!Object.hasOwn(fields, key)) {
    throw new ValidationError(fieldPath(parent, key), "is required");
  }
  return fields[key];
}

export function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ValidationError(
      field,
      `must be a string, got ${describeType(value)}`,
    );
  }
  return value;
}

export function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ValidationError(
      field,
      `must be true or false, got ${describeType(value)}`,
    );
  }
  return value;
}

export function expectNonEmptyString(value: unknown, field: string): string {
  const text = expectString(value, field);
  if (text === "") throw new ValidationError(field, "must not be empty");
  return text;
}

function describeNumber(value: unknown): string {
  return typeof value === "number" ? String(value) : describeType(value);
}

/** A safe integer, which may be negative. */
export function expectInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ValidationError(
      field,
      `must be an integer, got ${describeNumber(value)}`,
    );
  }
  return value;
}

/** A finite number from `min` to `max`, inclusive. */
export function expectNumberInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    throw new ValidationError(
      field,
      `must be a number from ${min} to ${max}, got ${describeNumber(value)}`,
    );
  }
  return value;
}

/** A safe integer of at least 1. */
export function expectPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError(
      field,
      `must be a positive integer, got ${describeNumber(value)}`,
    );
  }
  return value;
}

/** A safe integer of at least 0. */
export function expectNonNegativeInteger(
  value: unknown,
  field: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(
      field,
      `must be an integer of at least 0, got ${describeNumber(value)}`,
    );
  }
  return value;
}

/** Rejects values that JSON cannot carry unchanged. */
export function expectJsonValue(value: unknown, field: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new ValidationError(field, `must be a finite number, got ${value}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      expectJsonValue(item, fieldPath(field, index)),
    );
    return;
  }
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    for (const [key, child] of Object.entries(value))
      expectJsonValue(child, fieldPath(field, key));
    return;
  }
  throw new ValidationError(
    field,
    `must be a JSON value, got ${describeType(value)}`,
  );
}
