# 5. The dry-run diff ignores generated ids

**Status:** accepted (2026-10-14)

## Context

`apply --dry-run` (#7) runs the writer on a temporary copy of the database and reports the rows that differ before and after the write. Its contract requires that re-applying an unchanged description reports `no changes` (`"changed": false`, `"tables": {}`).

Every apply generates fresh ids, so a re-apply changes stored bytes even when nothing a user can see changes:

- the button and page writers delete each control they replace and insert a new one under a fresh `bank:` control id, and the page's cell then holds the new id;
- every action, feedback, style override and trigger event gets a fresh `id` or `overrideId`;
- a page apply gives gap pages and a created page a fresh page id (only when the row is new, so a re-apply keeps them).

Two approaches were considered:

- **(A)** the diff treats generated ids as unchanged, mapping them consistently between the before and after reads;
- **(B)** the writers reuse the existing ids when they replace something.

## Decision

(A), confined to the dry-run diff (`src/core/generated-ids.ts`, used by `src/core/table-diff.ts`). Writers are unchanged.

1. **Generated ids inside a control are masked by position.** In `controls` rows, only the positions the writers fill with a fresh id are ignored, and only when they hold a 21-character nanoid:
   - `steps.<step>.action_sets.<set>[i].id` (button actions, hold sets included);
   - `actions[i].id` and `condition[i].id` (trigger actions and conditions);
   - `feedbacks[i].id` and `localVariables[i].id` (button and trigger local variables, which are feedback entities);
   - on each of those entities, `styleOverrides[j].overrideId` when it has style overrides, and the same positions on every entity in its `children` groups (`children.<group>[k]`), at any depth;
   - `events[i].id` (trigger events).

   Nothing under an entry's `options` or `storeResult` is ever masked: Companion connection ids are 21-character nanoids too, and a pass-through action or feedback may name one, so a changed option is always a change. Layer ids such as `canvas` or `text0` are not at these positions and are compared. (Amended for #25: `localVariables` entities are masked like feedbacks; before it, the writers always wrote that list empty. Amended for #23: before it, the writers always wrote `children` empty and wrote style overrides only on top-level feedbacks, so only those positions were masked.)
2. **Controls are paired by location.** A `bank:` control that the write removed is paired with the control the write added at the same page and cell, but only when the two values are equal once rule 1 masks them. A paired control counts as unchanged, and the page cell that moved from the old id to the new id counts as unchanged too. For comparison the mapping rewrites the before read (old id to new id), so the new ids are the ones reported; the report's `before` and `after` values themselves are never rewritten.
3. **Key/value rows are compared as parsed JSON.** When a row's stored bytes differ, a row of a table with `id` and `value` columns is unchanged if the stored JSON parses to the same value. Page ids, trigger control ids and tables without that shape are compared by stored content.
4. **A missing `children` on an internal entity is `children: {}`.** An action or feedback (at any position rule 1 masks) with connection `internal` and no `children` key compares as if it had `children: {}`, which Companion's `asEntityModel` gives every internal entity and the writers store since #23. Every writer before #23, and the Python prototype, stored internal actions without it, so without this rule a re-apply to such a page reported every button as replaced and export refused it (#44). The export self-check uses the same masked comparison. A module entity's `children` is not touched: Companion drops it, so a stored one is still a change and still refused. (Added for #44.)

A changed button is not paired, so it is still reported as the new control id added (`+`), the old one removed (`-`) and the page cell changed (`~ 1: cell 0/2 bank:<old> -> bank:<new>`), as the contract's report format shows. The cell's text line also names up to three stored paths where the two controls differ once rule 1 masks them (`(changed: options.canModifyStyleInApis)`, `…` when there are more), so a cell whose content really changed reads differently from one whose only difference is an id (amended for #44: a dry run reporting all 47 buttons of a page as replaced gave no hint why). The JSON report is unchanged. A trigger keeps its control id, so a changed trigger is `~ trigger:<id>`.

(B) was rejected: it needs the button and page writers to update rows in place and to carry action, feedback, override and event ids over by position, which changes their tested behaviour, and #7's contract excludes changes to writers. (A) is a read-side transform with no effect on what an apply writes.

A variant of (A) that pairs controls by location regardless of content, reporting a changed button as `~ bank:<new id>`, was also considered. It was rejected because the contract's report format lists a replaced button as `+` and `-` with the page's cell change.

## Consequences

- A re-apply of an unchanged button, page or trigger reports `no changes`, although a real apply would still store new ids.
- The JSON report's `before` values are the stored rows, with the old ids; its `after` values are what the real apply stores, except that a real apply generates other fresh ids than the dry run did.

Remaining risks:

- The masked positions are a copy of what the writers produce. A writer that later generates ids somewhere else (child feedbacks, another property, another table) needs rule 1 extended, or its re-applies will report changes. A writer that stores a meaningful value at a masked position would have that value's changes hidden.
- A nanoid at a masked position is ignored whoever wrote it: a control Companion itself edited, whose action or feedback ids differ, compares equal to what the writer produces if nothing else differs.
- A control placed in more than one cell is never paired, so re-applying it reports `+`, `-` and a cell change although nothing visible changes.
- Rule 3 hides differences that are only whitespace or key order in stored JSON; a real apply still rewrites those bytes.
- Only the masked comparison is tested against the writers' current shapes; a Companion version with other control shapes is refused by the version guard, not handled here.
