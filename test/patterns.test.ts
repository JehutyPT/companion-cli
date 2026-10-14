import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesNamePatterns } from "../src/core/patterns.ts";

const NAMES = [
  "fx_counter",
  "fx_label",
  "fx_gap",
  "FX_counter",
  "sk_presses",
  "a.b",
  "a+b",
  "a(b)",
  "a[b]",
  "axb",
  "aab",
  "a-b/c{1}|d^$",
  "",
];

const matching = (...patterns: string[]) =>
  NAMES.filter((name) => matchesNamePatterns(name, patterns));

describe("name patterns", () => {
  it("a pattern without * or ? is an exact name", () => {
    assert.deepEqual(matching("fx_label"), ["fx_label"]);
    assert.deepEqual(matching("fx_"), []);
    assert.deepEqual(matching("label"), []);
  });

  it("* matches any run of characters, at the start, middle and end", () => {
    assert.deepEqual(matching("fx_*"), ["fx_counter", "fx_label", "fx_gap"]);
    assert.deepEqual(matching("*_counter"), ["fx_counter", "FX_counter"]);
    assert.deepEqual(matching("fx_*r"), ["fx_counter"]);
    assert.deepEqual(matching("fx_counter*"), ["fx_counter"], "empty run");
    assert.deepEqual(matching("*").length, NAMES.length, "everything");
  });

  it("? matches exactly one character, at the start, middle and end", () => {
    assert.deepEqual(matching("?x_gap"), ["fx_gap"]);
    assert.deepEqual(matching("fx_ga?"), ["fx_gap"]);
    assert.deepEqual(matching("a?b"), ["a.b", "a+b", "axb", "aab"]);
    assert.deepEqual(matching("fx_gap?"), []);
    assert.deepEqual(matching("?"), []);
  });

  it("is case-sensitive", () => {
    assert.deepEqual(matching("FX_*"), ["FX_counter"]);
    assert.deepEqual(matching("Fx_label"), []);
  });

  it("takes regex metacharacters literally", () => {
    assert.deepEqual(matching("a.b"), ["a.b"]);
    assert.deepEqual(matching("a+b"), ["a+b"]);
    assert.deepEqual(matching("a(b)"), ["a(b)"]);
    assert.deepEqual(matching("a[b]"), ["a[b]"]);
    assert.deepEqual(matching("a[ax]b"), [], "no character classes");
    assert.deepEqual(matching("a\\.b"), [], "no escapes");
    assert.deepEqual(matching("^fx.*$"), []);
    assert.deepEqual(matching("a-b/c{1}|d^$"), ["a-b/c{1}|d^$"]);
  });

  it("several patterns match their union, each name once", () => {
    assert.deepEqual(matching("fx_label", "sk_*", "fx_l*"), [
      "fx_label",
      "sk_presses",
    ]);
  });

  it("no pattern matches every name; an unmatched pattern matches none", () => {
    assert.deepEqual(matching(), NAMES);
    assert.deepEqual(matching("nomatch*"), []);
  });
});
