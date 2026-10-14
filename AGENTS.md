# AGENTS.md

A CLI that configures a local Bitfocus Companion 5.1 install from description files: buttons, pages, triggers and custom variables. It writes Companion's SQLite database with Companion stopped, because Companion has no API for authoring controls. Status: early; the `apply` command with the variable, button, page and trigger writers, and the REST helper's runtime commands, exist (TypeScript on Node 22.18+, `node:sqlite`, YAML descriptions; see [ADR 0003](docs/adr/0003-typescript-node-sqlite-and-yaml-descriptions.md)). See [README.md](README.md) for components and usage.

## Reference

- [docs/companion-internals.md](docs/companion-internals.md): database tables, control JSON shapes, action and feedback ids, REST endpoints, and how each fact was verified.
- [CONTEXT.md](CONTEXT.md): domain language. [docs/adr/](docs/adr/): decisions.
- [reference/python-prototype/](reference/python-prototype/): a working prototype that wrote a 47-button page into a real 5.1 database. Source of truth for shapes until the CLI exists. Reference only; do not extend it.

## Rules

- **Database writes only with Companion stopped.** The core quits Companion, waits for its server process to exit, backs up the database and its WAL files, writes in one transaction, runs `pragma integrity_check`, then restarts Companion. Never write while Companion runs.
- **Replace one thing per write.** Each writer replaces exactly one page, button, trigger or variable, idempotently. Never touch rows the description does not name. One exception: a page apply beyond the last page plus one also creates the empty pages in between, because Companion loads pages contiguously ([ADR 0004](docs/adr/0004-page-apply-creates-gap-pages.md)).
- **Validate before writing.** Parse and validate the whole description file, including locations against the grid size, before opening the database for writing.
- **Refuse unknown database versions.** Only `page_config_version` 17 (Companion 5.1) is supported. Anything else is an error, not a best-effort write.
- **Local development installs only.** Never target a production or remote Companion.
- **REST for runtime actions only.** Presses, rotations, variable reads and sets, and status go through the REST API. Authoring goes through the database.
- **Secrets in `.env.local`.** `COMPANION_URL` and `COMPANION_API_KEY` live there (gitignored). Never commit a key; `.env.example` holds the names only.
- **Do not touch the user's real Companion database during development.** Work on copies. Ask before applying anything to the live install.

## Conventions

- Commits are authored by the user alone: no `Co-Authored-By` trailers.
- Solo project: branch, commit, merge. No PR process.

## Agent skills

### Issue tracker

Use GitHub issues in `JehutyPT/companion-cli` for internal work. External issue and PR triage are disabled. Before tracker operations, read `docs/agents/issue-tracker.md`.

### Issue labels and readiness

Use `prd`, `bug`, `enhancement`, and `ready-for-agent`. Before categorizing work or changing readiness, read `docs/agents/issue-labels.md`.

### Implementation contracts

Before drafting, preparing, or implementing a ticket, read `docs/agents/implementation-contract.md` for the canonical `## Implementation Contract` section and its lifecycle.

### Domain docs

Before exploring domain behavior or recording decisions, read `docs/agents/domain.md`. This repository uses root `CONTEXT.md` and `docs/adr/`.
