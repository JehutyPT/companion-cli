# companion-cli

A small, deterministic CLI for configuring a local [Bitfocus Companion](https://bitfocus.io/companion) 5.1 install from description files: buttons, pages, triggers and custom variables. It exists so agents and humans can build test and preset pages cheaply and repeatably, instead of reverse-engineering Companion's internal JSON each time.

**Status:** early. The `apply` command, the variable writer, the button writer (single location: encoders, steps and feedbacks) and the page writer (a page's name and all of its buttons) work against the local install (live-install mode, macOS: Companion is quit, written and started again) or a database copy (`--db`), and the REST helper's runtime commands work against a running local Companion; the trigger writer is not built yet. Live-install mode is covered by tests with a fake process control; it has not yet been run against a real Companion. The Python prototype (`reference/python-prototype/`) remains the reference for shapes the CLI does not cover.

## Why

Companion has no supported API to create buttons, pages or triggers. Its REST API can press buttons, set custom variables, export pages and manage connections, but not author controls. The only way to create them programmatically is to write Companion's SQLite database while Companion is stopped. See [ADR 0001](docs/adr/0001-write-through-the-database-with-companion-stopped.md) and [docs/companion-internals.md](docs/companion-internals.md).

## Components

| Component | Does |
| --- | --- |
| Shared core | Quits Companion, backs up the database, opens it, writes, runs `pragma integrity_check`, restarts Companion. Owns Companion's id format and JSON shapes. Refuses unknown database versions. |
| Button writer | Turns a short button description (text, colors, down/up/rotate actions, feedbacks, steps) into Companion's control JSON at a page/row/column. |
| Page writer | Takes a page name and a grid of button descriptions; replaces only that page's buttons. |
| Trigger writer | Writes triggers (same `controls` table, `trigger:` prefix), reusing the button writer's action and feedback building. Trigger events still need research. |
| Variable writer | Creates or updates custom variables: default value, persist on restart, description. |
| REST helper | Presses or rotates a button at a location, reads or sets a custom variable, reads surface status. Reads `COMPANION_URL` and `COMPANION_API_KEY` from `.env.local`. |

Every write is an idempotent "replace this one thing" operation, and every writer validates its description file before touching the database ([ADR 0002](docs/adr/0002-declarative-description-files.md)).

## Safety model

- **Local development installs only.** Not for production or remote Companion machines.
- **Stops Companion before writing.** Companion holds pages, controls and variables in memory and overwrites edits made while it runs. On macOS it also refuses to write a database any other process has open.
- **Backs up first.** The database (and its WAL files) is copied before any write; the integrity check runs after.
- **One database version.** The tool targets Companion 5.1's database (`page_config_version` 17) and refuses anything else.

## Open decisions

- **Implementation language, SQLite binding and description format:** decided in [ADR 0003](docs/adr/0003-typescript-node-sqlite-and-yaml-descriptions.md): TypeScript on Node 22.18+, the built-in `node:sqlite`, and YAML description files with a top-level `kind`.

## Usage

```sh
npm install
npm run build
node dist/bin/companion-cli.js apply variables.yaml                    # the local install (macOS)
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

`apply` validates the whole file, checks on a read-only snapshot that the database is version 17, copies `db.sqlite` and any `-wal` / `-shm` files to `companion-cli-backups/<timestamp>/` next to the database, then creates or replaces the named variables in one transaction and runs `pragma integrity_check`. Any failure rolls back and exits non-zero with a one-line reason on stderr. Backups always sit next to the database being written, including the install's: `~/Library/Application Support/companion/v5.1/companion-cli-backups/<timestamp>/`.

Without `--db`, `apply` targets the install's database, `~/Library/Application Support/companion/v5.1/db.sqlite` (macOS only; other platforms are refused). After the file and the snapshot checks pass, it quits Companion if its server is running (`osascript -e 'quit app "Companion"'`), waits up to 30 seconds for the server process to exit, backs up and writes, then starts Companion again (`open -a Companion`), also after a failed write. If Companion was not running, it is neither quit nor started. If the server does not exit in time, nothing is written and Companion may be partly stopped. If the write succeeds but Companion does not start, the apply fails with a reason saying the change was written and Companion must be started manually.

With `--db`, `apply` never quits or starts Companion. It refuses to write the install's database (through `~`, symlinks or hard links too) while Companion is running, or when it cannot tell whether Companion is running.

On macOS, in both modes, `apply` also refuses right before the backup if any other process has the database or its `-wal` / `-shm` file open (checked with `lsof -t`), or if that check fails. This catches a Companion the process match misses, such as a renamed bundle or a development build, and any other SQLite client. In live-install mode Companion is still started again if the tool quit it. If quitting Companion or waiting for it fails with an error, nothing is written and the tool starts Companion again; only a wait timeout leaves it as it is.

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
rotate_left:  [ { action: decrement, variable: fx_counter } ]   # optional, encoder turned left
rotate_right: [ { action: increment, variable: fx_counter } ]   # optional, encoder turned right
feedbacks:                                 # optional list; each overrides parts of the style while it holds
  - feedback: expression                   # Companion's "Variable: Check boolean expression"
    expression: "$(custom:fx_label) == 'pressed'"
    style: { background: "#FFA500" }       # at least one of background, textColor, text
    invert: false                          # optional, default false
  - feedback: passthrough                  # any connection's feedback, written as given
    connection: FixtureConnectionAAAA
    definition: some_feedback_id
    options: { input: 1 }                  # optional
    style: { text: "LIVE" }
```

A two-step latch uses `steps` in place of the top-level `down`, `up`, `rotate_left` and `rotate_right` lists (combining them is refused). Each press advances to the next step; a `step` feedback (1-based) restyles the button on that step:

```yaml
kind: button
location: { page: 1, row: 0, column: 3 }
text: "OFF"
background: "#FF0000"
steps:                                     # non-empty; each step accepts down, up, rotate_left, rotate_right
  - { down: [ { action: set, variable: fx_label, value: "on" } ] }
  - { down: [ { action: set, variable: fx_label, value: "off" } ] }
feedbacks:
  - feedback: step
    step: 2                                # between 1 and the number of steps
    style: { background: "#00FF00", textColor: "#000000", text: "ON" }
```

The page must already exist and be one Companion loads (pages 1, 2, … up to the first missing one), and every custom variable an action targets or a `$(custom:<name>)` reference names (in `text`, `set` values, action and feedback expressions, and feedback style `text`) must already exist; apply a `kind: variables` file first. The control previously at that location is deleted and a new `button-layered` control with fresh ids takes its place; the page's other cells are untouched. Giving `rotate_left` or `rotate_right` (even as an empty list, at top level or in a step) turns on the control's rotary actions. A feedback's `style` overrides only the fields it gives; a feedback `background` does not pick a text color. Pass-through actions and feedbacks are not checked against the database. Other feedback kinds, style fields and unknown fields are refused. A `|` block scalar works for multi-line text; its trailing newline is dropped.

`page.yaml` replaces a whole page, its name and every button on it:

```yaml
kind: page
page: 20                                   # >= 1
name: SKAARHOJ TEST                        # required, non-empty
buttons:                                   # required list; [] clears the page
  - location: { row: 0, column: 0 }        # row and column only; the page comes from `page`
    text: "Last\n$(custom:sk_last)"
    background: "#000080"
    down: [ { action: increment, variable: sk_presses } ]
  - location: { row: 1, column: 5 }        # every other kind: button field works here too
    text: S1
    background: "#FF0000"
```

Every control the page held is deleted, including the page up / page number / page down buttons Companion puts on new pages, and one new `button-layered` control per entry takes its place; two entries at the same row and column are refused. The page keeps its internal id. Errors name the entry, for example `buttons[3].down[0].variable`. Custom variables must already exist, as for a button. The apply is refused if a cell on the page holds anything but a button control id, or if one of its controls is also placed on another page.

When the page does not exist it is created. Companion loads pages 1, 2, 3, … up to the first missing number, so a page beyond the last page plus one needs the pages in between: they are created empty and named `PAGE`, as Companion names a new page. A `pages` row in that range that Companion does not load (a stray row after a gap, or a row holding something other than a page, such as `null`) refuses the apply ([ADR 0004](docs/adr/0004-page-apply-creates-gap-pages.md)). Only the page writer creates pages; `kind: button` refuses a page that does not exist or that Companion does not load.

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
