# 2. Declarative description files

**Status:** accepted (2026-10-14)

## Context

Companion's control JSON is verbose (a single button is four style layers, wrapped option values, nested steps and action sets) and internal. Agents writing it by hand repeat the same reverse-engineering and make shape errors that Companion may silently drop.

## Decision

Users describe pages, buttons, triggers and custom variables in a short declarative description file in the tool's own format. The tool owns the mapping to Companion's JSON. Each write replaces exactly one thing (a page's buttons, one button, one trigger, one variable) and is idempotent: applying the same file twice yields the same database content apart from generated control ids.

The whole file is validated, including locations against the install's grid size, before the database is opened for writing.

## Consequences

- Only the tool's mapping has to change when Companion's shapes change.
- The description format covers what tests and presets need, not every Companion feature. Unsupported features are rejected, not passed through.
- The file format itself (YAML, JSON or TypeScript) is not yet decided and is bound to the implementation language decision.
