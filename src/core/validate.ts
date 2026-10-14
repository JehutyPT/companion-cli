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

export function expectMapping(value: unknown, field: string): Fields {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
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
