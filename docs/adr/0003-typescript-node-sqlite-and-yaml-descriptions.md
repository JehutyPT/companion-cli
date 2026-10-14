# 3. TypeScript on Node 22, node:sqlite, and YAML description files

**Status:** accepted (2026-10-14)

## Context

The README left the implementation language open, and ADR 0002 left the description file format (YAML, JSON or TypeScript) bound to that choice. The first writer (custom variables) needs both. The author's Companion plugin work is TypeScript, and Companion 5.1 itself is a Node application that uses the built-in `node:sqlite` module (its bundled `main.js` imports `backup` from `node:sqlite`).

## Decision

- **Language:** TypeScript, run on Node 22 or newer (22.18+, so tests can run `.ts` files with Node's built-in type stripping). `tsc` builds `dist/` for the `companion-cli` executable.
- **SQLite binding:** Node's built-in `node:sqlite` (`DatabaseSync`). No native addons such as `better-sqlite3`.
- **Description file format:** YAML, parsed with the `yaml` package (YAML 1.2 core schema, duplicate keys rejected). Every file is a mapping with a top-level `kind` (`variables` now; `button`, `page` and `trigger` reserved for later writers). The other top-level fields belong to that kind's writer. Unknown kinds and unknown fields at any level are errors that name the field, for example `variables[2].colour: unknown field`.

```yaml
kind: variables
variables:
  - name: sk_presses
    default: 0
    description: Button presses
    persist: false
```

This resolves the open point in ADR 0002.

## Consequences

- No compiler toolchain or prebuilt binaries to install; the SQLite library is the one Node ships.
- `node:sqlite` is still marked experimental on Node 22 and prints an `ExperimentalWarning`. The executable filters that one warning so stderr carries only the tool's own one-line reason. A future Node release could change the API; the database code is confined to `src/core/` and the writers.
- YAML is short to write by hand and by agents, and allows comments. Its implicit typing (`0` is a number, `"0"` a string) is visible in the stored `defaultValue`, which is what Companion stores too.
- Tests use `node --test` with type stripping, so the test runner adds no dependency. TypeScript code must stay within erasable syntax (no enums, namespaces or parameter properties).
