import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Companion's ids: 21 characters from the nanoid default alphabet. Used for
 * control ids (after the `bank:` or `trigger:` prefix), page ids, action ids,
 * feedback ids and style-override ids. See docs/companion-internals.md, "Ids".
 */
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const ID_LENGTH = 21;

/** A fresh random id. The alphabet has 64 characters, so `byte & 63` is unbiased. */
export function newId(): string {
  let id = "";
  for (const byte of randomBytes(ID_LENGTH)) id += ALPHABET[byte & 63];
  return id;
}

/** A fresh id after `prefix` (for example `bank:`) for which `isUsed` is false. */
export function freshId(isUsed: (id: string) => boolean, prefix = ""): string {
  for (;;) {
    const id = `${prefix}${newId()}`;
    if (!isUsed(id)) return id;
  }
}

/** Whether the `controls` table has a row with this id. */
export function controlExists(db: DatabaseSync, id: string): boolean {
  return (
    db.prepare("SELECT 1 FROM controls WHERE id = ?").get(id) !== undefined
  );
}
