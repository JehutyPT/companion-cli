import { randomBytes } from "node:crypto";

/**
 * Companion's ids: 21 characters from the nanoid default alphabet. Used for
 * control ids (after the `bank:` or `trigger:` prefix), action ids, feedback
 * ids and style-override ids. See docs/companion-internals.md, "Ids".
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
