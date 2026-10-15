# companion-cli

Configuring a local Bitfocus Companion install from description files.

## Language

**Companion install**:
One Companion application and its configuration directory on the local machine (on macOS, `~/Library/Application Support/companion/v5.1/`).
_Avoid_: Server, instance (Companion uses "instance" for connections)

**Companion server process**:
The `node … Companion.app/Contents/Resources/main.js` process, a child of the Companion launcher, that holds the database open while Companion runs. "Companion is running" means this process exists; the launcher alone does not count.
_Avoid_: Server on its own (ambiguous with the install), instance

**Database**:
The install's `db.sqlite` (SQLite in WAL mode) where Companion persists pages, controls, custom variables, surfaces and connections.

**DB version**:
The value of `page_config_version` in the database's `main` table. Companion 5.1.0 uses 17. The tool supports exactly one DB version.
_Avoid_: Schema version, Companion version (several Companion releases can share one DB version)

**Page**:
A numbered grid of locations with a name. Page numbers start at 1 and are contiguous: Companion loads pages 1, 2, 3, … up to the first missing or empty row. A page Companion creates is named `PAGE`.

**Location**:
A page, row and column triple identifying one grid cell. Rows and columns are bounded by the install's grid size and may be negative.
_Avoid_: Bank, slot, key (Companion's older names)

**Cell**:
A row and column pair on one page, without the page number. A page description places each of its buttons at a cell; with the page number it becomes a location.
_Avoid_: Bank, slot, key

**Grid size**:
The row and column bounds of every page, from `userconfig.gridSize` in the database.

**Control**:
One row in the `controls` table: a button (id prefix `bank:`) or a trigger (id prefix `trigger:`), addressed by a control id.

**Control id**:
A 21-character nanoid-style identifier generated per control, stored with its `bank:` or `trigger:` prefix.

**Button**:
A control placed at a location. In 5.1 its type is `button-layered`: a style made of layers, one or more steps, and feedbacks.

**Step**:
One state of a button, holding its own action sets. Pressing advances to the next step when step progression is `auto`.

**Step progression**:
How a button moves between its steps: `auto` (each press advances), `manual` (only actions change the step) or `expression` (a step expression picks the step). Written `progression` in a description.

**Action set**:
The list of actions a step runs for one input: `down`, `up`, `rotate_left`, `rotate_right`, or a hold set.

**Hold set**:
An action set keyed by a duration in milliseconds, run when the button has been held that long: on release, or while still held when the duration is in the step's `runWhileHeld` list. Written as a `hold` entry (`after`, `whileHeld`, `actions`) in a description.

**Action**:
One operation run by a button or trigger, identified by a connection id and a definition id (for example `internal` / `custom_variable_set_value`).

**Feedback**:
A condition evaluated by Companion that overrides parts of a button's style while it holds (for example `bank_current_step`). Its definition's subtype (boolean, advanced, value, style-override) is not stored; an advanced feedback's style overrides name properties of the module's result.

**Entity**:
An action or a feedback: what the two share in Companion's stored shape (options, `headline`, `disabled`, `upgradeIndex`, `children`). _Avoid_: item, step (a step is something else).

**Expression option**:
An entity option, store field or `invert` holding an expression that Companion evaluates, rather than a plain value. Written `{expr: "…"}` in a description; stored as `{value, isExpression: true}`.

**Child group**:
A named list of entities nested inside an `internal` entity (for example `logic_if`'s `condition`, `actions` and `else_actions`). Written as `children` in a description. Only internal entities have them.

**Store**:
Where an action puts its result: a custom, local or page variable. Written as `store` in a description; stored as `storeResult`.

**Trigger**:
A control with no location that runs actions when one of its events occurs (startup, variable change, interval and others) and all its conditions hold. The tool identifies a trigger by its name.

**Condition**:
A boolean feedback on a trigger that must hold for the trigger's actions to run. Written as a `conditions` entry tagged `condition:` in a description; stored in the trigger's `condition` list, without style overrides. The `condition_true` and `condition_false` events fire when the conditions, taken together, change.

**Event**:
One occurrence a trigger listens for, such as startup (after a delay), a fixed interval, or a change of a custom variable. A trigger has one or more events.
_Avoid_: Hook, schedule

**Custom variable**:
A user-defined variable with a name, default value, description and a persist-on-restart flag. Referenced in text and expressions as `$(custom:<name>)`.

**Description file**:
A short declarative file describing one page, button, trigger or set of variables in the tool's own format, not Companion's JSON.
_Avoid_: Config, preset (Companion uses "preset" for module-provided buttons)

**Kind**:
The top-level `kind` field of a description file (`variables`, `button`, `page`, `trigger`, `triggers`, `connection`, `surface`) that selects which writer applies it.

**Apply**:
Validate a description file, stop Companion, back up the database, replace the described thing, check integrity and restart Companion.
_Avoid_: Import (Companion's own import is a different feature), sync

**Dry run**:
An apply that writes nothing: the same checks, then the writer runs on a temporary copy of the database, and the rows it would add, replace and remove are reported. It never takes a backup and never stops or starts Companion. Generated ids alone are not changes.
_Avoid_: Preview, simulation ("plan" is the parsed description)

**Validate**:
The checks an apply runs before it writes, and nothing else: against a read-only snapshot of a database, or the description file alone (*structure only*, `--no-db`). It reports the first refusal or that the file is valid, never what would change (that is the dry run).
_Avoid_: Lint, check (a writer's `check` is one step of validating)

**Usage census**:
Counts of how a database uses what the description format does and does not cover (control types, button options, steps, styles, actions, feedbacks, local variables, triggers, custom variables), read from a snapshot. It prints counts and keys, never values, and orders the writer extensions. The user runs it on a copy of their own database; only a summary is shared.
_Avoid_: Stats, report, audit

**Snapshot**:
A private temporary copy of the database and its `-wal` (never `-shm`) that read commands and the dry run open instead of the database itself, so the original stays byte-identical and Companion can keep running. Deleted after use.
_Avoid_: Backup (a backup is kept and copies all three files)

**Backup**:
A copy of the database and its WAL files taken immediately before an apply.

**REST helper**:
The part of the tool that talks to a running Companion over its HTTP API, for runtime actions only: press, rotate, read or set a custom variable, read surface status. `list variables` also uses it to read each listed variable's current value, and still succeeds from the database when it cannot. Definitions that exist only in the running Companion (a connection's module actions and feedbacks, a surface's config fields) are read separately, over its tRPC socket, subscribe-only.
