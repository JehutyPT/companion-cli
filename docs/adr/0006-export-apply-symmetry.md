# 6. Export and apply cover the same surface

**Status:** accepted (2026-10-15)

## Context

The read side (PRD #11) adds `export`, which turns stored Companion content back into description files. [ADR 0002](0002-declarative-description-files.md) says the description format covers what tests and presets need and rejects unsupported features. Without a rule tying the two directions together, they drift: the format grows a field that export never emits, or export learns to read a stored shape that apply cannot write. Either way an export, edit and apply loop can lose data the user never touched, because apply replaces the whole page, button, trigger or variable it names.

Today the format covers a subset of Companion 5.1: four style layers with three free properties, `auto` step progression, three trigger event kinds, no conditions, no notes, no local variables. Stored content made in Companion's UI often goes beyond that subset.

## Decision

Export and apply cover the same surface.

1. **Every field the description format accepts is exportable.** A writer change that adds a field also adds its export, in the same ticket, and its round-trip test.
2. **Export accepts only what the format expresses.** Export maps a stored row to a description, parses it with the writer's own `parse`, builds the stored value with the writer's own build code, and compares the result with the stored value (masking only the generated ids of [ADR 0005](0005-dry-run-diff-ignores-generated-ids.md)). Any difference refuses the export, naming the item and the exact stored field the format cannot express. Export never drops, normalises or guesses.
3. **Both directions share one implementation.** The writers' parse and build code is the single source of the mapping. Export holds only the inverse lookup (stored value to description field), never a second copy of a shape.
4. **The supported surface is written down and enforced.** `docs/support-matrix.md` states, for buttons, button options, steps, actions, feedbacks, local variables, triggers, events, conditions and custom variables, what is supported and what is not. A test fails when the matrix and the writers disagree, so the matrix cannot go stale.
5. **Unsupported stored content stays visible.** `list` and `find` read stored content generically and show it whether or not it is exportable. Nothing is silently dropped on any path.

The surface grows ticket by ticket (button options and full steps, full action and feedback entities, local variables, trigger conditions and notes, all trigger event types), prioritised by a usage census of the user's own database. Not everything Companion stores has to be supported; it has to be explicit.

## Consequences

- An exported file applied unchanged changes nothing, for every kind, and the round-trip test is the proof.
- Some real content cannot be exported until its part of the format exists. The refusal names the field, and the support matrix says whether it is planned.
- Every writer ticket costs more: a new field needs its export, its round-trip test and its matrix row.
- The matrix test needs a machine-readable source: the writers' tagged-kind tables and field lists, which `schema` also uses.
- ADR 0002's "unsupported features are rejected" now applies in both directions.
