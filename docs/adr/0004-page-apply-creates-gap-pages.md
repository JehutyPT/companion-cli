# 4. A page apply creates the empty pages before it

**Status:** accepted (2026-10-14)

## Context

[ADR 0002](0002-declarative-description-files.md) says each write replaces exactly one thing. A page apply to a page that does not exist creates it, but Companion 5.1 loads `pages` rows `"1"`, `"2"`, … and stops at the first missing or falsy row. A row `"20"` written alone, with no rows `"2"` to `"19"`, is never loaded, so creating only the described page would leave a page Companion ignores. Companion itself refuses to insert a page above count + 1, and its full import fills the missing pages first (both from Companion 5.1's bundled main.js; see [docs/companion-internals.md](../companion-internals.md), "Tables").

## Decision

The user decided that a page apply for page P, when Companion loads N pages and P > N + 1, also creates pages N + 1 to P − 1 as empty pages in Companion's own new-page shape: `{id: <fresh nanoid>, name: "PAGE", controls: {}}`. These gap pages are the only rows a page apply writes besides the described page and its controls.

A `pages` row in N + 1 to P that Companion does not load (a stray row after a gap, or a row holding something other than a page object) refuses the apply instead of being overwritten. Rows above P are left alone. The button writer never creates pages; it refuses a page Companion would not load.

## Consequences

- A page apply always leaves a page Companion loads, whatever page number the file names.
- This is an exception to "replace one thing per write": one apply can add several empty pages. They are named `PAGE` and hold no controls, so they can be overwritten by later page applies.
- Removing gap pages is not automated; moving or deleting pages is out of scope.
