# companion-cli

A small, deterministic CLI for configuring a local [Bitfocus Companion](https://bitfocus.io/companion) 5.1 install from description files: buttons, pages, triggers and custom variables. It exists so agents and humans can build test and preset pages cheaply and repeatably, instead of reverse-engineering Companion's internal JSON each time.

**Status:** early. The `apply` command, the variable writer, the button writer (single location: encoders, steps and feedbacks), the page writer (a page's name and all of its buttons) and the trigger writer (startup, interval and variable-change events) work against the local install (live-install mode, macOS: Companion is quit, written and started again) or a database copy (`--db`), `apply --dry-run [--json]` reports what an apply would change without writing, `validate` checks a description file without writing, `list variables`, `list triggers`, `list connections` and `list pages` read a snapshot copy of the database without stopping Companion, and the REST helper's runtime commands work against a running local Companion. Live-install mode is covered by tests with a fake process control and was run against a real local Companion 5.1 on macOS on 2026-10-14 (the SKAARHOJ test page; see [docs/companion-internals.md](docs/companion-internals.md#live-acceptance-run-2026-10-14)); triggers, `check_expression` and pass-through feedbacks and gap-page creation have not yet been checked live. The Python prototype (`reference/python-prototype/`) remains the reference for shapes the CLI does not cover.

## Why

Companion has no supported API to create buttons, pages or triggers. Its REST API can press buttons, set custom variables, export pages and manage connections, but not author controls. The only way to create them programmatically is to write Companion's SQLite database while Companion is stopped. See [ADR 0001](docs/adr/0001-write-through-the-database-with-companion-stopped.md) and [docs/companion-internals.md](docs/companion-internals.md).

## Components

| Component | Does |
| --- | --- |
| Shared core | Quits Companion, backs up the database, opens it, writes, runs `pragma integrity_check`, restarts Companion. Owns Companion's id format and JSON shapes. Refuses unknown database versions. |
| Button writer | Turns a short button description (text, colors, down/up/rotate actions, feedbacks, steps) into Companion's control JSON at a page/row/column. |
| Page writer | Takes a page name and a grid of button descriptions; replaces only that page's buttons. |
| Trigger writer | Creates or replaces one trigger by name (same `controls` table, `trigger:` prefix): startup, interval and variable-change events and the button writer's actions. |
| Variable writer | Creates or updates custom variables: default value, persist on restart, description. |
| Read path | Reads a snapshot copy of the database (integrity check, version guard) for the read commands; never writes and never stops Companion. |
| REST helper | Presses or rotates a button at a location, reads or sets a custom variable, reads surface status. Reads `COMPANION_URL` and `COMPANION_API_KEY` from `.env.local` or the user config file. |

Every write is an idempotent "replace this one thing" operation, and every writer validates its description file before touching the database ([ADR 0002](docs/adr/0002-declarative-description-files.md)). What the description format covers of Companion's stored content, item by item, is in [docs/support-matrix.md](docs/support-matrix.md); export and apply cover the same surface ([ADR 0006](docs/adr/0006-export-apply-symmetry.md)).

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
node dist/bin/companion-cli.js apply variables.yaml --dry-run                 # report only, write nothing
node dist/bin/companion-cli.js apply variables.yaml --dry-run --json          # the same report as JSON
```

`npm link` (after `npm run build`) puts `companion-cli` on your `PATH`, so it runs from any directory. The REST commands then need the user config file; see [Setup](#setup).

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

`apply --dry-run`, with or without `--db`, reports what an apply would change and writes nothing. It runs the same file and database checks as `apply` (and refuses with the same message), then runs the writer on a temporary copy of the database and its WAL files, compares every table before and after, rolls back and deletes the copy. It never takes a backup and never checks, quits or starts Companion, so it also works while Companion is running; a copy taken while Companion was writing can fail its integrity check, and then the dry run asks you to retry or quit Companion. The report lists each changed table with `+` (added), `~` (replaced) and `-` (removed) rows, page changes as the cells they change, then the summary `apply` would print:

```
dry run: nothing written to /path/to/db.sqlite
controls: 1 added, 0 replaced, 1 removed
  + bank:<new id>
  - bank:<old id>
pages: 0 added, 1 replaced, 0 removed
  ~ 1: cell 0/2 bank:<old id> -> bank:<new id>
apply would report: button at page 1, row 0, column 2: replaced bank:<old id> with bank:<new id>
```

When nothing would change it prints `no changes`. Generated ids do not count as changes: re-applying an unchanged button, page or trigger reports `no changes` although a real apply stores fresh ids. Only the ids the writers generate are ignored (action, feedback, style-override and event ids, and a replaced button's control id); a changed option, such as another connection id in a pass-through action, is always a change ([ADR 0005](docs/adr/0005-dry-run-diff-ignores-generated-ids.md)). `--dry-run --json` prints one JSON document instead: `{dryRun, database, changed, tables: {<table>: {added, changed, removed}}, summary}`, where each entry has the row's `key` and its stored `before` and/or `after` value. A dry run exits 0 whether or not anything would change, and 1 when `apply` would refuse or fail. `--json` without `--dry-run` is a usage error (exit 2).

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

`trigger.yaml` creates or replaces one trigger:

```yaml
kind: trigger
name: Reset counter                        # required, non-empty; identifies the trigger
enabled: true                              # optional, default true (Companion's own default is false)
events:                                    # required, at least one
  - { event: startup, delay: 0 }           # milliseconds after startup; optional, default 10000
  - { event: interval, seconds: 5 }        # positive integer
  - { event: variable_changed, variable: sk_presses }   # an existing custom variable
actions:                                   # optional, default []; the same actions as a button
  - { action: set, variable: sk_last, value: reset }
  - { action: increment, variable: sk_presses }
```

A trigger with the same name (compared exactly) is replaced under its control id, keeping its position in the trigger list and its collection (if that collection is disabled in Companion, the trigger does not run even with `enabled: true`; a collection that no longer exists is dropped by Companion at startup); everything else in it is replaced, including its notes and any condition. Otherwise a new trigger is added after the others. Two existing triggers with the name refuse the apply. Every variable an event watches or an action uses must already exist. Conditions, other event types and local variables are not supported; `condition` and any other unknown field are refused.

Applying a variable replaces its definition, with one exception. Companion keeps a persisted variable's current value in `defaultValue`, so when a variable is already persisted and the file still says `persist: true`, its stored value is kept. A new variable, `persist: false`, or switching persist on takes the file's `default`.

### Validate

```sh
companion-cli validate page.yaml                        # against the install's database (macOS)
companion-cli validate page.yaml --db /path/to/db.sqlite
companion-cli validate page.yaml --no-db                # the file only, any platform
companion-cli validate page.yaml --no-db --json
```

`validate` runs the checks `apply` runs before it writes, and refuses with the same one-line message and exit code 1 (the first error only, naming the field path, such as `buttons[3].location.column: 17 is outside the grid (0..7)`). With a database it reads a snapshot copy as the read commands below do (integrity check, version guard), then runs the writer's checks against it: grid bounds, page existence, known custom variables, ambiguous trigger names, stray page rows. `--no-db` reads and validates the file only, locating and opening no database. `validate` never writes, never takes a backup and never stops or starts Companion; what an apply would change is `apply --dry-run`'s job.

```
$ companion-cli validate examples/skaarhoj-test-page/page.yaml --no-db
valid: page 99 "SKAARHOJ TEST" (47 buttons) (structure only; not checked against a database)
```

`--json` prints `{"valid": true, "kind": "page", "file": "<path as given>", "database": "<resolved path>" | null, "checks": "database" | "structure"}`, and a failure as the error document described under [Read commands](#read-commands). `--db` with `--no-db` is a usage error (exit 2).

### Read commands

These read the database and print what is stored, one line per item:

```sh
companion-cli list variables                      # the local install (macOS)
companion-cli list variables 'fx_*' --db /path/to/copy/db.sqlite
companion-cli list triggers 'Reset*' 'Tick' --json
companion-cli list connections
companion-cli list pages 'SKAARHOJ*'
```

```
$ companion-cli list variables --db fixture.sqlite
NAME        DEFAULT  PERSIST  DESCRIPTION
fx_counter  0        no       Counter
fx_label    "idle"   yes      Label
fx_gap      ""       no       A custom variable
```

A read command copies the database and its WAL files to a temporary directory, checks the copy (`pragma integrity_check`, then the version guard), reads it and deletes it. It writes nothing, never stops or starts Companion and works while Companion runs, including on the install's database. Without `--db` it reads the install's database (macOS only).

- `list variables`: ordered by sort order, then name. `DEFAULT` is the stored value as JSON, so `"0"` and `0` differ; for a persisted variable it is Companion's current value.
- `list triggers`: ordered by sort order, then id. `EVENTS` summarises each event (`startup 0ms`, `interval 5s`, `var fx_counter`, or the bare type for other events), with ` (off)` after a disabled one. `ACTIONS` is the action count, with ` +cond` when the trigger has a condition. The id is shown because trigger names are not unique.
- `list connections`: Companion's built-in `internal` connection first, then the connections in Companion's order (sort order, then id), matched by label. `BUTTONS` counts the buttons on loaded pages and `TRIGGERS` the triggers that use the connection, through an action, feedback or condition (by id) or a `$(<label>:...)` reference; each control counts once. A connection id that a control uses but no connection has is listed last as `?` with module `(missing)`. Connection configuration and secrets are never printed. Surface instances are not listed.
- `list pages`: the pages Companion loads (1, 2, … up to the first missing one), matched by name. `BUTTONS` counts the occupied cells, `CONNECTIONS` names the connections the page's controls use, and `LABELS` shows the first three cells in row, then column order: a button's text quoted and cut to 20 characters, `<pageup>` and the like for other control types, `<missing>` for a cell whose control is gone. With `--json` every cell is listed, and `unloadedRows` names the numbered page rows Companion does not load.
- Text cells longer than 40 characters are cut to 39 and end with `…` (`LABELS` is not cut, its entries already are); line breaks show as `\n`. `--json` prints one document with full values: `{"database": ..., "<kind>": [...]}`, such as `{"database": ..., "variables": [...]}`.

**Name patterns.** Every name argument is a case-sensitive glob over the whole name: `*` matches any run of characters and `?` exactly one; nothing else is special. A pattern without `*` or `?` is an exact name. Several patterns list their union, and no match prints only the header (or an empty list) with exit 0. Quote patterns so the shell does not expand them.

**Errors.** Without `--json` a failure is one `error: <message>` line on stderr, exit 1 (exit 2 for a bad command line). With `--json` anywhere on a read command's line, every failure, a bad command line included, is instead one document on stdout and nothing on stderr, with the same exit code:

```json
{"error": {"code": "database_not_found", "message": "database not found: /path/db.sqlite", "hint": "pass --db <path>, or check that Companion 5.1 has been run once"}}
```

`message` is the stderr line without `error: `. `path` (a description field path) and `hint` (the next step) appear when they apply. `items` (one entry per refused item, when a command refuses several) and `committed` and `backup` (a write committed and then failed) are reserved for later commands. Codes are stable: new ones may be added, none is renamed or removed.

| Code | When |
| --- | --- |
| `usage` | bad command line (exit 2); `hint` is the usage line |
| `invalid_description` | a description file cannot be read or fails validation |
| `database_not_found` | the database does not exist |
| `unsupported_platform` | live-install mode (no `--db`) off macOS |
| `unsupported_version` | the database is not version 17 (Companion 5.1) |
| `snapshot_inconsistent` | the copy failed its integrity check, perhaps copied while Companion was writing; retry, or quit Companion and retry |
| `database_unreadable` | the database cannot be copied, opened or read |
| `check_failed` | a check against the database refused the description |
| `not_found` | a named item does not exist |
| `unexpected` | anything else: a bug in the tool |

`apply` and the REST commands keep their plain stderr errors for now.

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

They read `COMPANION_URL` and `COMPANION_API_KEY` from `.env.local` in the working directory or, if the working directory has none, from the user config file `~/.config/companion-cli/.env.local` (`$XDG_CONFIG_HOME/companion-cli/.env.local` when `XDG_CONFIG_HOME` is set). Only the first file that exists is read; the two are not merged. Environment variables take precedence over either file. Both are required for every command. `COMPANION_URL` must be an `http:` or `https:` URL on `localhost`, `127.0.0.1` or `[::1]`; any other host is refused before a request is sent. A path prefix in the URL is kept. Every request sends `Authorization: Bearer <key>`, and the key is never printed.

`variable set` sends the value as a bare JSON body with `Content-Type: application/json`: a finite number, `true` or `false` as that JSON value, anything else as a JSON string; `--string` always sends a string. `variable get` prints Companion's plain-text value. A surface prints as one line: `<id> connected|disconnected <rows>x<columns> page <number> "<name>"`, with `-` for a null size, page, page number or page name (a surface showing no page ends in `-`).

Press, rotate and variable commands use Companion's HTTP API (setting `http_api_enabled`, on by default). The surface commands use REST API v2, which must be enabled in Companion's settings and needs a key with the `read` scope. A press at an empty location, an unknown variable, a disabled API, a rejected key or an unreachable Companion exits 1 with one line on stderr. Callers pace presses: overlapping presses can lose increments. See [docs/companion-internals.md](docs/companion-internals.md#rest-api).

### Example: the SKAARHOJ test page

[`examples/skaarhoj-test-page/`](examples/skaarhoj-test-page/) holds the SKAARHOJ PTZ Extreme test page that the Python prototype wrote to page 20, as two description files: `variables.yaml` (12 `sk_*` custom variables) and `page.yaml` (47 buttons on page 99). `test/skaarhoj-test-page.test.ts` proves that applying them reproduces the prototype's output exactly, apart from generated ids and the page number.

- **Order:** apply `variables.yaml` first; the page apply refuses buttons that name a custom variable that does not exist yet.
- **Grid:** the install's grid must allow rows 0–3 and columns 0–16. On a smaller grid the page apply is refused before anything is written.
- **Page 99 and its gap pages:** if the install has N < 98 pages, the page apply also creates pages N + 1 … 98, empty and named `PAGE` ([ADR 0004](docs/adr/0004-page-apply-creates-gap-pages.md)). They show up in every surface's page up/down cycle, and the tool does not remove them. If page 99 exists, its name and every control on it are replaced.

To try it on a copy first, apply both files with `--db /path/to/copy/db.sqlite`.

Applying to the local install (live-install mode) quits and restarts Companion once per file. Run these steps yourself from the repository root, after `npm install` and `npm run build`, invoking the CLI as in [Usage](#usage): `node dist/bin/companion-cli.js …`.

1. **Pre-flight, in Companion's web UI** (do not open the database): check the grid size; note the current page count N and whether page 99 exists. Decide whether the 98 − N gap pages, or replacing an existing page 99, are acceptable. Check that `.env.local` in the directory you run the commands from, or the user config file `~/.config/companion-cli/.env.local` if that directory has none, holds `COMPANION_URL` and `COMPANION_API_KEY`.
2. **Dry-run the variables:** `node dist/bin/companion-cli.js apply examples/skaarhoj-test-page/variables.yaml --dry-run`. It writes nothing and does not touch Companion. Expect only the 12 `sk_*` rows in `custom_variables` to be added or replaced. If it prints `no changes` (the variables already exist and are identical, for example from the prototype), skip step 3: applying would only restart Companion.
3. **Apply the variables:** `node dist/bin/companion-cli.js apply examples/skaarhoj-test-page/variables.yaml`. Blast radius: the 12 `sk_*` custom-variable definitions, which the prototype's existing page 20 also uses, and one Companion restart. Note the `backup:` path and the summary line.
4. **Wait for Companion:** the tool does not wait for Companion to be ready after starting it. Repeat `node dist/bin/companion-cli.js variable get sk_presses` until it answers before going on.
5. **Dry-run the page:** `node dist/bin/companion-cli.js apply examples/skaarhoj-test-page/page.yaml --dry-run`. Run it only now: before the variables are applied, it is refused for unknown custom variables. This is the go/no-go check, before anything is written: when page 99 does not exist, its last line must read `apply would report: page 99 "SKAARHOJ TEST": created; deleted 0 controls, wrote 47 controls; created <98 − N> empty pages: <N + 1>, …, 98`, with the count matching the 98 − N expected from step 1. A different count, or a refusal naming a stray `pages` row, means stop and investigate.
6. **Apply the page:** `node dist/bin/companion-cli.js apply examples/skaarhoj-test-page/page.yaml`. Blast radius: page 99 (its name and every control on it, 47 new controls), the gap pages N + 1 … 98, and one Companion restart; no other page or control changes. Check the summary line matches the dry run, note the `backup:` path, then wait for Companion again as in step 4.
7. **Smoke-test over REST.** Paste this block (it defines `cli` as a shell function, which works in zsh and bash); it waits a second between commands and reads the variables before and after each press and rotation:

   ```sh
   cli() { node dist/bin/companion-cli.js "$@"; }
   cli variable get sk_presses
   cli variable get sk_last
   cli press 99 1 5          # S1: sk_presses + 1, sk_last = S1
   sleep 1
   cli variable get sk_presses
   cli variable get sk_last
   cli variable get sk_enc1
   cli rotate-right 99 0 3   # E1: sk_enc1 + 1
   sleep 1
   cli variable get sk_enc1
   cli rotate-left 99 0 3    # E1: sk_enc1 - 1
   sleep 1
   cli variable get sk_enc1
   cli press 99 0 3          # E1 push: sk_enc1 = 0, sk_last = E1 push
   sleep 1
   cli variable get sk_enc1
   cli variable get sk_last
   ```

   Then press S9 twice, one press at a time, checking page 99 in the web UI after each:

   ```sh
   cli() { node dist/bin/companion-cli.js "$@"; }
   cli press 99 1 13         # S9 press 1: sk_presses + 1, sk_last = S9; the button shows green ON
   sleep 1
   cli variable get sk_presses
   cli variable get sk_last
   ```

   ```sh
   cli() { node dist/bin/companion-cli.js "$@"; }
   cli press 99 1 13         # S9 press 2: sk_presses + 1, sk_last = S9; the button shows red OFF
   sleep 1
   cli variable get sk_presses
   cli variable get sk_last
   ```

8. **Check page 99 by eye in the web UI:** the 47 buttons show their texts, and the (0,0) button tracks `sk_last` and `sk_presses`.

**Undo.** Each apply prints its own backup. Restoring the first apply's backup (the variables apply) undoes both applies; restoring the page apply's backup undoes only the page.

1. Quit Companion and confirm it has fully stopped: `pgrep -fl "Companion.app/Contents/Resources/main.js"` prints nothing (or Activity Monitor shows no Companion process).
2. Copy the backup's `db.sqlite` over `~/Library/Application Support/companion/v5.1/db.sqlite`.
3. If the backup has `db.sqlite-wal` and `db.sqlite-shm`, copy them over the install's too. If it does not, delete the install's own `db.sqlite-wal` and `db.sqlite-shm`: a newer WAL would otherwise replay onto the restored database.
4. Start Companion.

## Development

`npm run build`, `npm test` (Node's test runner on the `.ts` sources), `npm run lint` (ESLint and `tsc`), `npm run format` / `npm run format:check` (Prettier), `npm run gen:support-matrix` (regenerates `docs/support-matrix.md` from `src/support-matrix.ts`). Tests build synthetic fixture databases in temp directories (`test/fixtures/companion-db.ts`); never point them at a real install.

## Consumers

- [JehutyPT/companion-surface-skaarhoj-rawpanel](https://github.com/JehutyPT/companion-surface-skaarhoj-rawpanel): its test page and planned preset page.
- The author's production Companion setup repository (IEV_StreamConfigs), for building pages offline.

## Non-goals

- A general Companion admin tool or UI replacement.
- Editing a running Companion.
- Remote or production installs.
- Supporting every Companion version.

## Setup

Copy `.env.example` to `.env.local` and fill in the API key from Companion's settings. `.env.local` is gitignored. To run the REST commands from any directory (for example after `npm link`), put the same file at `~/.config/companion-cli/.env.local` (`$XDG_CONFIG_HOME/companion-cli/.env.local` when `XDG_CONFIG_HOME` is set); a `.env.local` in the working directory still wins.

## Licence

MIT. See [LICENSE](LICENSE).
