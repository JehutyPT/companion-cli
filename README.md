# companion-cli

A small, deterministic CLI for configuring a local [Bitfocus Companion](https://bitfocus.io/companion) 5.1 install from description files: buttons, pages, triggers and custom variables. It exists so agents and humans can build test and preset pages cheaply and repeatably, instead of reverse-engineering Companion's internal JSON each time.

**Status:** pre-implementation. This repository holds the design docs and a working Python prototype (`reference/python-prototype/`). No CLI code yet.

## Why

Companion has no supported API to create buttons, pages or triggers. Its REST API can press buttons, set custom variables, export pages and manage connections, but not author controls. The only way to create them programmatically is to write Companion's SQLite database while Companion is stopped. See [ADR 0001](docs/adr/0001-write-through-the-database-with-companion-stopped.md) and [docs/companion-internals.md](docs/companion-internals.md).

## Components

| Component | Does |
| --- | --- |
| Shared core | Quits Companion, backs up the database, opens it, writes, runs `pragma integrity_check`, restarts Companion. Owns Companion's id format and JSON shapes. Refuses unknown database versions. |
| Button writer | Turns a short button description (text, colours, down/up/rotate actions, feedbacks, steps) into Companion's control JSON at a page/row/column. |
| Page writer | Takes a page name and a grid of button descriptions; replaces only that page's buttons. |
| Trigger writer | Writes triggers (same `controls` table, `trigger:` prefix), reusing the button writer's action and feedback building. Trigger events still need research. |
| Variable writer | Creates or updates custom variables: default value, persist on restart, description. |
| REST helper | Presses or rotates a button at a location, reads or sets a custom variable, reads surface status. Reads `COMPANION_URL` and `COMPANION_API_KEY` from `.env.local`. |

Every write is an idempotent "replace this one thing" operation, and every writer validates its description file before touching the database ([ADR 0002](docs/adr/0002-declarative-description-files.md)).

## Safety model

- **Local development installs only.** Not for production or remote Companion machines.
- **Stops Companion before writing.** Companion holds pages, controls and variables in memory and overwrites edits made while it runs.
- **Backs up first.** The database (and its WAL files) is copied before any write; the integrity check runs after.
- **One database version.** The tool targets Companion 5.1's database (`page_config_version` 17) and refuses anything else.

## Open decisions

- **Implementation language.** Not decided. Recommendation: TypeScript on Node 22+, using `node:sqlite` or `better-sqlite3`. It matches the author's Companion plugin work and Companion's own stack. The Python prototype stays as reference only.

## Consumers

- [JehutyPT/companion-surface-skaarhoj-rawpanel](https://github.com/JehutyPT/companion-surface-skaarhoj-rawpanel): its test page and planned preset page.
- The author's production Companion setup repository (IEV_StreamConfigs), for building pages offline.

## Non-goals

- A general Companion admin tool or UI replacement.
- Editing a running Companion.
- Remote or production installs.
- Supporting every Companion version.

## Setup

Copy `.env.example` to `.env.local` and fill in the API key from Companion's settings. `.env.local` is gitignored.

## Licence

MIT. See [LICENSE](LICENSE).
