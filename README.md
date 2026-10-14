# companion-cli

A small, deterministic CLI for configuring a local [Bitfocus Companion](https://bitfocus.io/companion) 5.1 install from description files: buttons, pages, triggers and custom variables. It exists so agents and humans can build test and preset pages cheaply and repeatably, instead of reverse-engineering Companion's internal JSON each time.

**Status:** early. The `apply` command and the variable writer work against a database copy; the button, page and trigger writers, stopping and restarting Companion, and the REST helper are not built yet. The Python prototype (`reference/python-prototype/`) remains the reference for shapes the CLI does not cover.

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

- **Implementation language, SQLite binding and description format:** decided in [ADR 0003](docs/adr/0003-typescript-node-sqlite-and-yaml-descriptions.md): TypeScript on Node 22.18+, the built-in `node:sqlite`, and YAML description files with a top-level `kind`.

## Usage

```sh
npm install
npm run build
node dist/bin/companion-cli.js apply variables.yaml --db /path/to/copy/db.sqlite
```

`variables.yaml`:

```yaml
kind: variables
variables:
  - name: sk_presses   # letters, digits and _ only (Companion's rule)
    default: 0         # string, number or boolean
    description: Button presses   # optional, default "A custom variable"
    persist: false     # optional persist-on-restart flag, default false
```

`apply` validates the whole file, checks on a read-only snapshot that the database is version 17, copies `db.sqlite` and any `-wal` / `-shm` files to `companion-cli-backups/<timestamp>/` next to the database, then creates or replaces the named variables in one transaction and runs `pragma integrity_check`. Any failure rolls back and exits non-zero with a one-line reason on stderr. Until live-install mode exists, `--db` is required and the install's default database is refused.

Applying a variable replaces its whole definition. For a variable with `persist: true`, Companion keeps the last value in `defaultValue`, so re-applying the file resets that stored value to the file's `default`.

## Development

`npm run build`, `npm test` (Node's test runner on the `.ts` sources), `npm run lint` (ESLint and `tsc`), `npm run format` / `npm run format:check` (Prettier). Tests build synthetic fixture databases in temp directories (`test/fixtures/companion-db.ts`); never point them at a real install.

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
