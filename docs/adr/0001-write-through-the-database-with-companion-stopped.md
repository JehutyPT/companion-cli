# 1. Write through the database with Companion stopped

**Status:** accepted (2026-10-14)

## Context

Companion 5.1 has no supported API for creating buttons, pages or triggers. The REST API covers runtime actions (press, rotate, step, style), custom variable values, export, connections and surface brightness. It has export endpoints but no import or control-authoring endpoints.

Companion loads pages, controls and custom variables into memory at startup and writes them back as they change, so edits made to `db.sqlite` while it runs are ignored or overwritten.

## Decision

Author controls, pages and custom variables by writing the SQLite database directly, only while Companion is stopped. Every apply: quit Companion, wait for its server process to exit, back up the database and its WAL files, write in one transaction, run `pragma integrity_check`, restart Companion.

Target exactly one DB version (`page_config_version` 17, Companion 5.1) and refuse any other.

## Consequences

- Each apply restarts Companion. Acceptable for local test and preset work; unacceptable for a live show, which is out of scope.
- The database format is internal and changes between Companion versions (Companion ships upgrade scripts for it). Supporting a new version means re-verifying the shapes in `docs/companion-internals.md`.
- Because Companion runs its own upgrade scripts at startup, writing valid version-17 JSON lets Companion own any later migration.
- The REST API is still used for runtime checks after an apply.
