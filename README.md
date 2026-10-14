# companion-cli

A small, deterministic CLI for configuring a local [Bitfocus Companion](https://bitfocus.io/companion) 5.1 install from description files: buttons, pages, triggers and custom variables. It exists so agents and humans can build test and preset pages cheaply and repeatably, instead of reverse-engineering Companion's internal JSON each time.

**Status:** early. The `apply` command, the variable writer and the single-button writer work against a database copy, and the REST helper's runtime commands work against a running local Companion; multi-step buttons, feedbacks, the page and trigger writers, and stopping and restarting Companion are not built yet. The Python prototype (`reference/python-prototype/`) remains the reference for shapes the CLI does not cover.

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

`button.yaml` replaces the button at one location:

```yaml
kind: button
location: { page: 1, row: 0, column: 2 }   # page >= 1; row and column within the grid size (may be negative)
text: "Count\n$(custom:fx_counter)"        # required, may be empty; line breaks become Companion's literal \n
background: "#000080"                      # required; quote it, an unquoted # starts a YAML comment
textColor: "#FFFFFF"                       # optional; black or white depending on the background's brightness
down:                                      # optional action list, run on press
  - { action: set, variable: fx_label, value: pressed }
  - { action: expression, variable: fx_label, expression: "$(custom:fx_counter) * 2" }
  - { action: increment, variable: fx_counter, by: 1 }   # by: optional positive integer, default 1
  - { action: decrement, variable: fx_counter }
  - action: passthrough                    # any connection's action, written as given
    connection: FixtureConnectionAAAA
    definition: some_definition_id
    options: { mode: 1, label: "x" }       # optional
up: []                                     # optional action list, run on release
```

The page must already exist, and every custom variable an action targets or a `$(custom:<name>)` reference names (in `text`, `set` values and expressions) must already exist; apply a `kind: variables` file first. The control previously at that location is deleted and a new `button-layered` control with fresh ids takes its place; the page's other cells are untouched. Rotary actions, steps, feedbacks and other style fields are not supported yet and are rejected as unknown fields. A `|` block scalar works for multi-line text; its trailing newline is dropped.

Applying a variable replaces its definition, with one exception. Companion keeps a persisted variable's current value in `defaultValue`, so when a variable is already persisted and the file still says `persist: true`, its stored value is kept. A new variable, `persist: false`, or switching persist on takes the file's `default`.

### Runtime commands (REST helper)

These talk to a running local Companion and never touch the database:

```sh
companion-cli press 1 0 2            # also down, up, rotate-left, rotate-right: <page> <row> <column>
companion-cli press 1 -1 0           # rows and columns may be negative
companion-cli variable get fx_counter
companion-cli variable set fx_counter 0          # sends the JSON number 0
companion-cli variable set fx_label hello        # sends the JSON string "hello"
companion-cli variable set --string fx_label 0   # sends the JSON string "0"
companion-cli surface list
companion-cli surface get streamdeck:AB12
```

They read `COMPANION_URL` and `COMPANION_API_KEY` from `.env.local` in the working directory; environment variables take precedence. Both are required for every command. `COMPANION_URL` must be an `http:` or `https:` URL on `localhost`, `127.0.0.1` or `[::1]`; any other host is refused before a request is sent. A path prefix in the URL is kept. Every request sends `Authorization: Bearer <key>`, and the key is never printed.

`variable set` sends the value as a bare JSON body with `Content-Type: application/json`: a finite number, `true` or `false` as that JSON value, anything else as a JSON string; `--string` always sends a string. `variable get` prints Companion's plain-text value. A surface prints as one line: `<id> connected|disconnected <rows>x<columns> page <number> "<name>"`, with `-` for a null size, page, page number or page name (a surface showing no page ends in `-`).

Press, rotate and variable commands use Companion's HTTP API (setting `http_api_enabled`, on by default). The surface commands use REST API v2, which must be enabled in Companion's settings and needs a key with the `read` scope. A press at an empty location, an unknown variable, a disabled API, a rejected key or an unreachable Companion exits 1 with one line on stderr. Callers pace presses: overlapping presses can lose increments. See [docs/companion-internals.md](docs/companion-internals.md#rest-api).

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
