# companion-cli

A small, deterministic CLI for configuring a local [Bitfocus Companion](https://bitfocus.io/companion) 5.1 install from description files: buttons, pages, triggers and custom variables. It exists so agents and humans can build test and preset pages cheaply and repeatably, instead of reverse-engineering Companion's internal JSON each time.

**Status:** early. The `apply` command, the variable writer, the button writer (single location: encoders, steps and feedbacks), the page writer (a page's name and all of its buttons), the trigger writer (every event type but the condition events), the connection writer (one existing connection's label, enabled flag, config and secrets from the environment) and the surface writer (one stored surface's name, enabled flag and config keys) work against the local install (live-install mode, macOS: Companion is quit, written and started again) or a database copy (`--db`), `apply --dry-run` reports what an apply would change without writing, `apply --json` prints the result or any failure as one JSON document, `validate` checks a description file without writing, `list variables`, `list triggers`, `list connections`, `list pages` and `list surfaces`, `find` and `export variables`, `export trigger`, `export triggers`, `export page`, `export connection` and `export surface` (description files that apply back unchanged) read a snapshot copy of the database without stopping Companion, `schema` prints the JSON Schema of description files for editors, `schema --connection` lists a connection's module actions and feedbacks from the running Companion, `census` counts what a database uses without printing values, and the REST helper's runtime commands work against a running local Companion. Live-install mode is covered by tests with a fake process control and was run against a real local Companion 5.1 on macOS on 2026-10-14 (the SKAARHOJ test page; see [docs/companion-internals.md](docs/companion-internals.md#live-acceptance-run-2026-10-14)); triggers, `check_expression` and pass-through feedbacks and gap-page creation have not yet been checked live. The Python prototype (`reference/python-prototype/`) remains the reference for shapes the CLI does not cover.

## Why

Companion has no supported API to create buttons, pages or triggers. Its REST API can press buttons, set custom variables, export pages and manage connections, but not author controls. The only way to create them programmatically is to write Companion's SQLite database while Companion is stopped. See [ADR 0001](docs/adr/0001-write-through-the-database-with-companion-stopped.md) and [docs/companion-internals.md](docs/companion-internals.md).

## Components

| Component | Does |
| --- | --- |
| Shared core | Quits Companion, backs up the database, opens it, writes, runs `pragma integrity_check`, restarts Companion. Owns Companion's id format and JSON shapes. Refuses unknown database versions. |
| Button writer | Turns a short button description (text, colors, down/up/rotate actions, feedbacks, steps) into Companion's control JSON at a page/row/column. |
| Page writer | Takes a page name and a grid of button descriptions; replaces only that page's buttons. |
| Trigger writer | Creates or replaces one trigger by name (same `controls` table, `trigger:` prefix): every Companion 5.1 event type except the condition events, and the button writer's actions. |
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
node dist/bin/companion-cli.js apply variables.yaml --json                    # the result, or any failure, as JSON
node dist/bin/companion-cli.js apply variables.yaml --rest-timeout 60        # wait up to 60 s for REST after the restart
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

After starting Companion again following a successful write, `apply` waits for Companion's REST API so that the next runtime command does not race its startup. It reads the endpoint as the [runtime commands](#runtime-commands-rest-helper) do and polls `GET /api/v2/openapi.json` every 0.5 s. A 2xx, 401 or 403 counts as ready (the route answers 403 while REST API v2 is disabled, Companion's default); any other status, a refused connection or a probe that does not answer keeps polling. When it answers, apply logs `Companion REST ready after <N>s`. After 30 s, or `--rest-timeout <seconds>` (a number, fractions allowed; 0 skips the wait), it prints `warning: Companion started; REST not ready after <N>s` on stderr and still exits 0, because the write is committed. Without `COMPANION_URL` and `COMPANION_API_KEY`, or with invalid ones, it logs `note: REST not configured; not waiting for Companion's API` (with the reason for an invalid setting) and does not wait. There is no wait with `--db`, in a dry run, when Companion was not running beforehand, or when it did not start again.

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

When nothing would change it prints `no changes`. Generated ids do not count as changes: re-applying an unchanged button, page or trigger reports `no changes` although a real apply stores fresh ids. Only the ids the writers generate are ignored (action, feedback, style-override and event ids, and a replaced button's control id); a changed option, such as another connection id in a pass-through action, is always a change ([ADR 0005](docs/adr/0005-dry-run-diff-ignores-generated-ids.md)). `--dry-run --json` prints one JSON document instead: `{dryRun, database, changed, tables: {<table>: {added, changed, removed}}, summary, warnings}`, where each entry has the row's `key` and its stored `before` and/or `after` value, and `warnings` lists the writer's warning lines (see `--unchecked` under [connections](#connections)). Every value under `secrets` in an `instances` row reads `<secret>`, in text and JSON, before and after: the report never carries a secret. A dry run exits 0 whether or not anything would change, and 1 when `apply` would refuse or fail.

`apply --json`, with or without `--dry-run`, makes stdout machine-readable: exactly one JSON document, success or failure. A real apply prints, when it finishes:

```json
{"applied": true, "kind": "variables", "summary": "<the summary line>", "database": "/path/to/db.sqlite", "live": true, "backup": "/path/to/companion-cli-backups/<timestamp>", "restarted": true, "rest": "ready", "warnings": []}
```

`live` is false with `--db`. `restarted` is true only when live-install mode quit Companion and started it again. `rest` is the outcome of the wait for REST after the restart: `"ready"`, `"timeout"` or `"not_configured"`, and `null` when there was no wait (no restart, or `--rest-timeout 0`). `warnings` lists the warning lines, which also go to stderr: the keys `--unchecked` let through unchecked, the REST timeout warning, or none. The progress lines (`quitting Companion`, `backup: …`, `starting Companion`, and the REST ready line or note) go to stderr instead of stdout. Any failure, a bad command line included, is one [JSON error document](#read-commands) on stdout with nothing on stderr apart from progress lines already printed, and the exit code is unchanged. Nothing is streamed: the document comes once, at the end.

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
  - { event: variable_changed, variableId: "internal:time_hms" }   # any other variable, <label>:<name>, not checked
  - { event: intervalRandom, min: 3, max: 10 }          # random whole seconds from min to max; defaults 3 and 10
  - { event: timeofday, time: "08:00:00", days: [mon, tue, wed, thu, fri] }   # HH:MM:SS; days default all (sun..sat)
  - { event: specificDate, date: "2026-12-31", time: "23:00" }   # once; a real date YYYY-MM-DD, HH:MM or HH:MM:SS
  - { event: sun_event, sun: sunset, latitude: 38.72, longitude: -9.14, offset: 10 }   # offset in minutes; defaults sunrise, 0, 0, 0
  - { event: client_connect, delay: 0 }  # a web client connects; ms, default 0
  - { event: button_press }              # any button pressed; also button_release
  - { event: computer_locked, enabled: false }   # also computer_unlocked; macOS and Windows only
actions:                                   # optional, default []; the same actions as a button
  - { action: set, variable: sk_last, value: reset }
  - { action: increment, variable: sk_presses }
```

A trigger with the same name (compared exactly) is replaced under its control id, keeping its position in the trigger list and its collection (if that collection is disabled in Companion, the trigger does not run even with `enabled: true`; a collection that no longer exists is dropped by Companion at startup); everything else in it is replaced, including its notes and any condition. Otherwise a new trigger is added after the others. Two existing triggers with the name refuse the apply. Every custom variable an event watches (`variable`) or an action uses must already exist; a `variableId` is stored as given, and a `custom:` one is refused (use `variable`). Every event takes `enabled` (default true; `false` stores the event disabled). Times and dates are in Companion's configured timezone. Quote times and dates if another tool reads the file as YAML 1.1, which reads `23:00` as the number 1380. Conditions, the condition events (`condition_true`, `condition_false`) and local variables are not supported; `condition` and any other unknown field are refused.

`triggers.yaml` creates or replaces several triggers in one apply:

```yaml
kind: triggers
triggers:                                  # required, at least one
  - name: Reset counter                    # each entry is a kind: trigger body, without kind
    events: [ { event: startup, delay: 0 } ]
  - name: Tick
    events: [ { event: interval, seconds: 5 } ]
    actions: [ { action: increment, variable: sk_presses } ]
```

Each entry is validated, checked and written exactly as a `kind: trigger` file, in list order and in one transaction, so new triggers are added in that order. Errors name the entry, for example `triggers[1].events[0].seconds`. Two entries with the same name are refused. Triggers the file does not name are untouched.

<a id="connections"></a>`connection.yaml` edits one existing connection:

```yaml
kind: connection
connection: atem                           # required: its label (exact), or id:<id>
label: atem_main                           # optional: rename
enabled: true                              # optional
config:                                    # optional: merged into the stored config, key by key
  host: 10.0.0.20
  fadeFps: 25
secrets:                                   # optional: merged; values only from the environment
  password: { env: ATEM_PASSWORD }
```

Set at least one of `label`, `enabled`, `config` or `secrets`. Only the one `instances` row changes; every stored key the file does not name is kept, and connections cannot be created, deleted or moved to another module or version. `config` and `secrets` merge shallowly, as Companion's own update does; a key cannot be removed. Writing `config` sets `isFirstInit: false`, as Companion does. A label shared by several connections, an unknown connection and a surface instance are `not_found`; name a shared one by `id:<id>` (`list connections --json` shows ids).

- **Label.** Letters, digits, `_` and `-` only, and not `internal`, `this`, `local`, `companion`, `image`, `custom`, `expression` or `page` in any case (Companion's rule); no other connection may have it. Companion rewrites `$(<label>:…)` references on its own rename; a database write cannot, so a rename is refused while any control holds `$(<old>:` in a string or a `variableId` starting `<old>:`. The refusal names the count and up to three control ids.
- **Secrets** come only from environment variables, as `{env: NAME}`, so a description file never holds one; a literal is refused. A missing variable is refused, naming it. Secret values are never printed: not in summaries, errors, warnings or the dry-run report.
- **Checking config keys.** Config fields are defined by the module and known only to the running Companion. In live-install mode (`apply`, `apply --dry-run` or `validate` without `--db`) the tool first asks it for the connection's fields (`GET /api/v2/connections/v1/<id>/config-fields`, REST API v2 with the [REST settings](#runtime-commands-rest-helper); it requests nothing else). Each named key must be a field; numbers respect `min`/`max`, dropdowns take a choice, checkboxes a boolean, text a string matching the field's `regex` and `minLength`. A secret field under `config` is refused (`invalid_description`), and a key under `secrets` must be a secret field. Without the fields (with `--db`, REST not configured, Companion stopped, the connection disabled or not running, or REST refusing the request) the strict rule applies: a key must already be stored, with a value of the same JSON type. `--unchecked` (on `apply`, `apply --dry-run` and `validate`) accepts such keys and prints `warning: <path>: not checked (<why>)` on stderr and in the JSON `warnings`.

<a id="surfaces"></a>`surface.yaml` changes one stored surface's settings:

```yaml
kind: surface
surface: "skaarhoj:SK_RAWPANEL_123"        # required: the stored surface id (list surfaces)
name: Desk panel                           # optional
enabled: true                              # optional
brightness: 80                             # optional: 0 to 100
rotation: surface90                        # optional: 0, surface-90, surface90 or surface180
xOffset: 0                                 # optional: integers
yOffset: 0
transferInputs:                            # config.transfer_input_<id>: a custom variable, or "" for none
  hwc_12: skaarhoj_enc1
transferOutputs:                           # config.transfer_output_<id>: an expression
  hwc_40_led: "$(custom:tally_pgm) == 1"
plugin:                                    # config.plugin_cfg_<id>
  sleepTimer: 300
config:                                    # any other config key, as given
  canChangePage: true
```

A file naming only `surface` changes nothing. Only the one `surfaces` row changes: `name` and `enabled` when named, and the named config keys, merged key by key. Every other key is kept, including the surface's group settings (`groupConfig`), its `groupId` and its identity (`type`, `integrationType`, `gridSize`). Surfaces cannot be created or forgotten, a config key cannot be removed, and surface groups are not supported (`config.groupId` is refused). A key with a named field (`config.brightness`, `config.transfer_input_hwc_12`, …) is refused under `config`: use the named field. A transfer input must name an existing custom variable, and `$(custom:…)` references in a transfer output must exist. An unknown surface id is `not_found`. Surface names need not be unique, as in Companion.

- **Checking config keys.** `brightness`, `rotation`, `xOffset` and `yOffset` are Companion's own and always checked by the tool. Every other key is defined by the surface's module, and Companion knows the fields only while the surface is connected. In live-install mode (`apply`, `apply --dry-run` or `validate` without `--db`), when the file sets such a key, the tool first reads the surface's fields over Companion's local socket (`COMPANION_URL`, no API key; the same version gate as [`schema --connection`](#module-actions-and-feedbacks-schema---connection)). Each key must be a field and its value must suit the field's type (as for connections; a `custom-variable` or `expression` field takes a string). Without the fields (with `--db`, no `COMPANION_URL`, another Companion build, Companion stopped, or the surface unknown or disconnected) the strict rule applies: a key must already be stored, with a value of the same JSON type. `--unchecked` accepts such keys and prints `warning: <path>: not checked (<why>)` on stderr and in the JSON `warnings`.

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

`--json` prints `{"valid": true, "kind": "page", "file": "<path as given>", "database": "<resolved path>" | null, "checks": "database" | "structure", "warnings": []}`, and a failure as the error document described under [Read commands](#read-commands). `--db` with `--no-db` is a usage error (exit 2).

### Read commands

These read the database and print what is stored, one line per item (`list variables` also asks the running Companion for current values; see below):

```sh
companion-cli list variables                      # the local install (macOS), with current values
companion-cli list variables --no-current         # database values only, no REST request
companion-cli list variables 'fx_*' --db /path/to/copy/db.sqlite
companion-cli list triggers 'Reset*' 'Tick' --json
companion-cli list connections
companion-cli list pages 'SKAARHOJ*'
companion-cli list surfaces 'skaarhoj:*'
```

```
$ companion-cli list variables
NAME        DEFAULT  CURRENT  PERSIST  DESCRIPTION
fx_counter  0        "3"      no       Counter
fx_label    "idle"   "busy"   yes      Label
fx_gap      ""       ""       no       A custom variable
```

A read command copies the database and its WAL files to a temporary directory, checks the copy (`pragma integrity_check`, then the version guard), reads it and deletes it. It writes nothing, never stops or starts Companion and works while Companion runs, including on the install's database. Without `--db` it reads the install's database (macOS only).

- `list variables`: ordered by sort order, then name. `DEFAULT` is the stored value as JSON, so `"0"` and `0` differ; for a persisted variable it is Companion's current value. `CURRENT` is the value the running Companion holds now (see below).
- `list triggers`: ordered by sort order, then id. `EVENTS` summarises each event (`startup 0ms`, `interval 5s`, `random 3-10s`, `timeofday 08:00:00 mon-fri` (runs of three or more days as a range, others as `sun,sat`), `date 2026-12-31 23:00`, `sun sunset +10m`, `connect 0ms`, `press`, `release`, `var fx_counter`, `locked`, `unlocked`, or the bare type for condition events and options the writer would not store), with ` (off)` after a disabled one. `ACTIONS` is the action count, with ` +cond` when the trigger has a condition. The id is shown because trigger names are not unique.
- `list connections`: Companion's built-in `internal` connection first, then the connections in Companion's order (sort order, then id), matched by label. `BUTTONS` counts the buttons on loaded pages and `TRIGGERS` the triggers that use the connection, through an action, feedback or condition (by id) or a `$(<label>:...)` reference; each control counts once. A connection id that a control uses but no connection has is listed last as `?` with module `(missing)`. Connection configuration and secrets are never printed. Surface instances are not listed.
- `list pages`: the pages Companion loads (1, 2, … up to the first missing one), matched by name. `BUTTONS` counts the occupied cells, `CONNECTIONS` names the connections the page's controls use, and `LABELS` shows the first three cells in row, then column order: a button's text quoted and cut to 20 characters, `<pageup>` and the like for other control types, `<missing>` for a cell whose control is gone. With `--json` every cell is listed, and `unloadedRows` names the numbered page rows Companion does not load.
- `list surfaces`: the stored surface rows by id, matched by id or name. `KEYS` is the number of stored config keys; config values and keys are never printed (a surface module may keep its own data there). A missing `enabled` reads as enabled, as in Companion. `--json` adds `integrationType` and gives `configKeys`.
- Text cells longer than 40 characters are cut to 39 and end with `…` (`LABELS` is not cut, its entries already are); line breaks show as `\n`. `--json` prints one document with full values: `{"database": ..., "<kind>": [...]}`, such as `{"database": ..., "variables": [...]}`.

**Current values.** After the database read, `list variables` asks the running Companion for each listed variable's value (`GET /api/custom-variable/<name>/value`), one request at a time with a 2 s timeout each and no retries, using the settings described under [Runtime commands](#runtime-commands-rest-helper). Only the variables the patterns match are asked for. REST returns text, so `CURRENT` is a quoted string and `currentValue` in JSON a string; a variable Companion does not know shows `-` (`null`). The REST part never fails the command and never touches Companion's process:

- **Read** (`"values": "live"`): every listed variable was asked for.
- **Unavailable** (`"values": "unavailable"`): the settings are missing or invalid (`"reason": "not_configured"`); Companion refused the connection, timed out or answered unexpectedly (`not_reachable`); or it refused the request with 401 or 403 (`unauthorised`; a 403 means its HTTP API is disabled). Every value is then `-` (`null`), even ones read before the failure. JSON adds `note` (why, in one line) and `reason`; text output adds `note: current values unavailable (<why>); showing database values only` after the table.
- **Skipped** (`"values": "skipped"`): `--no-current` makes no request and adds no note. `--db` makes no request either, because the running Companion's values do not belong to another database file; it adds the note `current values are only read for the install's database` (a `note:` line in text, `note` in JSON).

```json
{"database": "...", "variables": [{"name": "fx_counter", "defaultValue": 0, "currentValue": "3", "persistCurrentValue": false, "description": "Counter", "sortOrder": 0}], "values": "live"}
```

**Find.** `find` prints the controls that use a custom variable, a connection or a text, one line each: where the control is, its id, and the paths inside it that matched (at most three, then `+N more`; `--json` lists them all). Give exactly one query:

```sh
companion-cli find --variable fx_counter          # a custom variable name, or a pattern: 'fx_*'
companion-cli find --connection 'atem*'           # a connection label, or a pattern; internal included
companion-cli find "camera 1"                     # a text, ignoring case
```

```
$ companion-cli find --variable fx_counter
page 1 row 0 column 0     bank:<id>     down[0].variable, text
unplaced                  bank:<id>     text
trigger "Reset counter"   trigger:<id>  events[2].variable, actions[1].variable
```

- It scans the buttons on loaded pages (page, row, column order), then `bank:` controls placed on no loaded page (`unplaced`, by id), then triggers (sort order, then id). Paths use description-file terms where a writer has one (`text`, `steps[1].rotate_left[0].expression`, `feedbacks[0].style.text`, `events[2].variable`), and the stored JSON path otherwise (`style.layers[2].text`, `feedbacks[1].options.input`, `feedbacks[0].children.group[1].options.input`).
- `--variable` matches `$(custom:<name>)` in any string, the target of an internal set-value action and a `variable_changed` event. A pattern is matched against stored and referenced names, so references to deleted variables are found; an exact name that names no variable adds `note: no custom variable "<name>" exists` (`"exists": false`). JSON adds `variables` (each matched name with `exists`) and `exists` (`null` for a pattern).
- `--connection` uses the rule `list connections` counts by: a `connectionId` anywhere, or a `$(<label>:...)` reference. Each line names the connections it matched through. An exact label that names no connection fails with `not_found`; a pattern that matches none finds nothing. JSON adds `connections`, and each match has `connections`.
- A text matches the `text0` layer text and feedback text overrides (a stored `\n` is a line break), trigger names, page names (`page <n> name`), every action and feedback option value and every trigger event option value (numbers and booleans as JSON text; event options are named by their description fields, such as `events[1].time` or `events[3].sun`). Option keys, ids, definition and connection ids are not matched.
- No match prints nothing and exits 0. JSON: `{"database", "query", ..., "matches": [{"kind", "page", "row", "column", "controlId", "triggerName", "paths"}]}`, with fields that do not apply `null`.

**Name patterns.** Every name argument is a case-sensitive glob over the whole name: `*` matches any run of characters and `?` exactly one; nothing else is special. A pattern without `*` or `?` is an exact name. Several patterns list their union, and for `list` no match prints only the header (or an empty list) with exit 0. Quote patterns so the shell does not expand them.

**Export.** `export` prints stored content as a description file that `apply` accepts, on the same snapshot read path ([ADR 0006](docs/adr/0006-export-apply-symmetry.md)):

```sh
companion-cli export variables ['fx_*' ...]       # kind: variables
companion-cli export trigger 'Reset counter'      # kind: trigger, one exact name
companion-cli export triggers ['Reset*' ...]      # kind: triggers
companion-cli export page 20                      # kind: page, the name and every button
companion-cli export page 20 --button 1/13        # kind: button, the control at row 1, column 13
companion-cli export connection atem              # kind: connection, one label or id:<id>
companion-cli export surface skaarhoj:SK_RAWPANEL_123  # kind: surface, one id
```

A page export lists buttons in row, then column order, each with its cell location; a single-step button uses the top-level action lists, a latch uses `steps`. `--button <row>/<column>` exports one cell as a `kind: button` file located on that page (`--button -1/0` works for negative cells). A page or cell that does not exist, a page Companion does not load, a cell outside the grid and an empty cell are `not_found`. Pages built in Companion's own editor often refuse: the button writer stores a fixed four-layer style, so any changed font size, alignment, image, extra layer, page navigation button, notes or manual step progression has no description field and refuses with `export_unsupported`. Pages written by `apply` (and edited only in what the format covers: text, background and text colour, actions, steps and boolean feedbacks) round-trip. A page export names every refused cell in one error, up to ten, with `items` listing each.

The YAML starts with two comment lines, the [schema](#schema-and-editor-setup) modeline and `# companion-cli export: <kind> (<count>)`; `--json` prints the same description as one JSON document. Variables come in sort order, then name, with all four fields; triggers in sort order, then id. The round-trip promise: applying an export to the same database changes nothing (`apply --dry-run` reports `no changes`, generated ids aside), and exporting again prints the same bytes. Each item is proved before it is printed: the writer's own parse, check and build must reproduce the stored row. Anything the description format cannot express (a condition, a disabled event, an expression option in a pass-through action, notes, local variables, …) refuses the item with `export_unsupported`, naming the stored field and the [support matrix](docs/support-matrix.md) area in `hint`; a stored item that apply's checks would refuse (a trigger watching a deleted variable, two selected triggers with one name) fails with `check_failed`. `export connection` prints `connection` (the label, or `id:<id>` when another connection shares it), `enabled` and the full stored `config`. Config values are printed: they may hold hostnames and similar, while Companion keeps secret fields in `secrets` by design (an old module that keeps a password in a plain config field would have it printed). Secrets are never exported; when the connection has some, the YAML gets one comment naming their keys only (`# secrets not exported: password (…)`), and applying the export leaves them as they are. A connection never configured (`isFirstInit: true`) is refused, because applying its export would set that flag. `export surface` prints `surface`, `name` and `enabled` (each when stored), Companion's own config keys as top-level fields, `transferInputs`, `transferOutputs` and `plugin` with their prefixes stripped, and every other config key under `config`; config values are printed. A stored `config.groupId: null` (no group) is left out. The YAML gets one comment naming what apply keeps as stored and the file leaves out (`groupConfig`, `type`, …). A surface in a manual group (`groupId`, or a non-null `config.groupId`) is refused with `export_unsupported`. Export is all or nothing: if any selected item is refused, nothing is printed, and with several refusals the message names up to ten and `items` lists each. With no patterns every item is exported; an exact name that matches nothing, patterns matching nothing, or nothing to export at all is `not_found`.

**Errors.** Without `--json` a failure is one `error: <message>` line on stderr, exit 1 (exit 2 for a bad command line). With `--json` anywhere on a read command's line, every failure, a bad command line included, is instead one document on stdout and nothing on stderr, with the same exit code:

```json
{"error": {"code": "database_not_found", "message": "database not found: /path/db.sqlite", "hint": "pass --db <path>, or check that Companion 5.1 has been run once"}}
```

`message` is the stderr line without `error: `. `path` (a description field path; for `export`, the refused item's stored field) and `hint` (the next step) appear when they apply. `items` is a list of `{message, path}`, one per refused item, when `export` refuses several. `backup` is the backup directory when an `apply` failed after taking one, and `committed: true` says the write was committed before the failure (`restart_failed`): do not retry it. Codes are stable: new ones may be added, none is renamed or removed.

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
| `companion_running` | `apply`: Companion or another process holds the database, Companion could not be quit, or the check failed (fails closed); hint `quit Companion and retry` |
| `quit_timeout` | `apply`: Companion's server did not exit in time; nothing written |
| `backup_failed` | `apply`: the backup could not be written; nothing written |
| `write_failed` | `apply`: the database could not be opened for writing, or the write or its integrity check failed and was rolled back; nothing committed. `backup` is set (a dry run has neither `backup` nor a hint). If the rollback also failed the hint says to restore from the backup |
| `restart_failed` | `apply`: the write committed but Companion did not start again; `committed: true` and `backup` are set |
| `export_unsupported` | `export` met stored content the description format cannot express; `hint` names the support-matrix area |
| `unsupported_companion_build` | `schema --connection`: the Companion app in `/Applications` is not build `5.1.0+9981-stable-257b325d09`, or the running Companion answered the socket in a way 5.1 does not |
| `companion_build_unknown` | `schema --connection`: the app's `Resources/BUILD` file is missing or unreadable |
| `companion_not_running` | `schema --connection`: Companion's socket refused the connection or closed it before answering |
| `companion_timeout` | `schema --connection`: Companion did not answer within 5 s |
| `unexpected` | anything else: a bug in the tool |

`apply` and the read commands use this envelope. When Companion was quit and starting it again after a failure also fails, the error keeps the original code, and its hint says to start Companion manually and, for `write_failed`, repeats what the original hint said about the database. The REST commands keep their plain stderr errors for now.

### Schema and editor setup

`companion-cli schema` prints the JSON Schema (draft 2020-12) of description files: every kind, field, default and tagged entry, with a description of each. It reads no database or file, and `--json` gives the same output. The schema is generated from the writers' own tables, and a test checks that it accepts exactly the files `apply` accepts, apart from three cross-field rules it cannot express and states in `$comment`s: a `step` feedback must name one of the button's steps, variable names in a file must be distinct, and page locations must be distinct. The schema checks structure only: `apply` and `validate --db` also check `$(custom:…)` references, locations and pages against the database, and pass-through actions and feedbacks are written literally without checks.

The committed copy is [`schema/description.schema.json`](schema/description.schema.json) (`npm run gen:schema` regenerates it). For the YAML language server (VS Code's Red Hat YAML extension and others), start a description file with:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/JehutyPT/companion-cli/main/schema/description.schema.json
kind: button
```

or map files to it in VS Code's `settings.json`, by URL or by a path to a checkout:

```json
{
  "yaml.schemas": {
    "https://raw.githubusercontent.com/JehutyPT/companion-cli/main/schema/description.schema.json": ["**/companion/*.yaml"]
  }
}
```

### Module actions and feedbacks: `schema --connection`

`companion-cli schema --connection <label> [--json]` lists one connection's module actions and feedbacks with their options, to write pass-through actions and feedbacks (`action: passthrough` / `feedback: passthrough`). `--connection internal` lists Companion's built-in ones.

```
connection "mixer" (vb-voicemeeter 2.1.0, id 0ZnJ2…)
actions (3):
  busMute       "Bus - Mute"  options: bus dropdown=A1 [A1,A2,A3,A4,A5,…], type dropdown=Toggle [Toggle,Mute,Unmute]
  recorderGain  "Recorder - Gain"  options: value number=0 (-60..12)
feedbacks (1):
  busEQ  boolean "Bus - EQ"  options: bus dropdown=A1 [A1,A2,A3,A4,A5,…]
use: {action: passthrough, connection: 0ZnJ2…, definition: <id>, options: {…}}
use: {feedback: passthrough, connection: 0ZnJ2…, definition: <id>, options: {…}}
```

Each option is `<id> <type>=<default>`, then up to five choice ids and `(min..max)` when it has them. `--json` gives `{connection: {id, label, moduleId, moduleVersionId}, build, actions: [{id, label, description, options: [{id, type, label, default, choices, min, max}]}], feedbacks: [{id, label, description, feedbackType, options}]}`, with only those fields.

Modules send these definitions to Companion when they start, and Companion keeps them in memory only, so this is a runtime command: it needs Companion running and reads no database (`--db` is a usage error). It reads `COMPANION_URL` like the REST commands below (same files, same loopback rule) but needs no API key, and talks to Companion's local tRPC WebSocket (`/trpc`, unauthenticated), the one Companion's web UI uses. It only subscribes and stops its subscriptions, never sends a query or a change, and sends no `Origin` header. Connection configuration and secrets are never printed.

That socket is a private API, so before connecting the command checks the Companion app's build in `/Applications/Companion.app/Contents/Resources/BUILD` and refuses anything but `5.1.0+9981-stable-257b325d09`. Known limitation: the app in `/Applications` may not be the copy that is running. See [docs/companion-internals.md](docs/companion-internals.md#module-definitions).

### Usage census

`census` counts how a database uses what the description format does and does not cover, so that the writer extensions (#23–#27) are built in the order real content needs them. It reads a snapshot copy like the read commands above and is safe on the install's database, but run it on a copy of your own:

```sh
mkdir -p /tmp/census
cp ~/Library/Application\ Support/companion/v5.1/db.sqlite* /tmp/census/
companion-cli census --db /tmp/census/db.sqlite --json > census.json
companion-cli census --db /tmp/census/db.sqlite           # the same counts as text
```

It counts control types (placed on a loaded page or not), button options against the writers' defaults, steps (count, hold actions, `runWhileHeld`), button styles against the writers' four-layer template, actions and feedbacks by module and definition (expression options, `disabled`, headlines, `upgradeIndex`, children, stored results, inversion, style overrides), local variables, trigger events, conditions, notes and collections, and custom variables. A count of something that can occur several times in one control is `{"controls": n, "occurrences": m}` in JSON, and `m in n controls` in text when the two differ. Unknown keys and types are counted under their name. Feedback subtypes (boolean, advanced, value) are not stored in the database, so feedbacks are counted by the list they sit in instead. The export self-check that would say how much exports cleanly does not exist yet, so `support` is `"not available"`.

**The output holds no values**: no option values, texts, names, labels, notes, expressions, variable names, connection ids, `config` or `secrets`, and the JSON leaves out the database path (`"database": null`). It does name the modules (`moduleId`) and definitions (`<module>:<definitionId>`) the install uses, so keep the full output local: only a summary (counts per area and the resulting ticket order, no module or definition lists) goes into the public tracker and the census section of [docs/support-matrix.md](docs/support-matrix.md).

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

`npm run build`, `npm test` (Node's test runner on the `.ts` sources), `npm run lint` (ESLint and `tsc`), `npm run format` / `npm run format:check` (Prettier), `npm run gen:support-matrix` (regenerates `docs/support-matrix.md` from `src/support-matrix.ts`), `npm run gen:schema` (regenerates `schema/description.schema.json` after a writer's fields or docs change). Tests build synthetic fixture databases in temp directories (`test/fixtures/companion-db.ts`); never point them at a real install.

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
