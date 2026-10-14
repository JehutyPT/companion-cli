# Companion 5.1 internals

Facts the tool depends on, for Companion 5.1.0 on macOS (DB version 17). Each section says how it was verified. These are internal formats: re-verify before supporting another Companion version.

Verification sources:

- **DB**: read from a real 5.1.0 `db.sqlite` (copied, never edited live).
- **main.js**: Companion's bundled server code, `/Applications/Companion.app/Contents/Resources/main.js` (minified; read-only greps).
- **Prototype**: `reference/python-prototype/fill_page20.py`, applied to a real 5.1.0 install, then exercised over REST.
- **OpenAPI**: `GET /api/v2/openapi.json` on the running install.
- **Live run**: the CLI's own `apply` in live-install mode against a local 5.1.0 install on macOS (a copy of a production configuration), then a REST smoke test, on 2026-10-14 (#10). See [Live acceptance run](#live-acceptance-run-2026-10-14).

## Install and process (macOS)

| Fact | Verified by |
| --- | --- |
| Database: `~/Library/Application Support/companion/v5.1/db.sqlite`, SQLite in WAL mode. After a quit, `db.sqlite-wal` and `db.sqlite-shm` may still exist; a backup must copy all three or checkpoint first. | DB |
| Processes: the launcher is `Companion.app/Contents/MacOS/Companion` (with Electron helper processes). The server is its child, `node … Companion.app/Contents/Resources/main.js --config-dir=<…>/companion/ --admin-port=…`, run by a bundled runtime under `Companion.app/Contents/Resources/node-runtimes/`. Connection modules are children of the server and also run a `main.js`, from the configuration directory's `modules/<module>/` (`node … <…>/companion/modules/canon-ptz-2.5.0/main.js`); some carry `--allow-fs-read=…/Companion.app/Contents/Resources` but never `Resources/main.js`. Surface threads run `Companion.app/Contents/Resources/SurfaceThread.js`. "Running" therefore means a process whose command line contains `Companion.app/Contents/Resources/main.js`; a launcher without that process is not running. | `ps -axo pid,ppid,command` on a running 5.1 install (2026-10-14) |
| Quit: `osascript -e 'quit app "Companion"'`. Wait until the server process (the PIDs seen before the quit) has exited before opening the database. | Prototype run; live run (the tool's quit and server wait) |
| In-use check: `lsof -t -- <db> <db>-wal <db>-shm` prints the PIDs that have any of the files open. It exits 1 when none is open and also when a listed file does not exist (a missing `-wal` or `-shm`); PIDs it prints still count. The tool refuses to write when any PID other than its own is listed, or when `lsof` exits with any other status. Matching by open files does not depend on the bundle name, so it also catches a renamed or development Companion. | lsof(8); live run (the guard passed after the quit, with no spurious holder) |
| Restart: `open -a Companion`. The launcher starts the server on its own. | Prototype run; live run |
| Companion holds pages, controls and custom variables in memory and writes them back; edits made while it runs are ignored or overwritten. | Observed behaviour; basis of ADR 0001 |

Only macOS has been checked. Windows and Linux paths and process handling are unverified.

## DB version

`main` table, key `page_config_version`, value `17` on 5.1.0.

Verified by DB and main.js: the upgrade list `mee` has 16 steps and the target is `mee.length + 1` = 17. Companion logs `Upgrade from version X to 17 not possible: too new` and refuses a newer database. Older databases are upgraded at startup by those steps.

## Tables

| Table | Key | Value (JSON) |
| --- | --- | --- |
| `main` | setting name | e.g. `page_config_version`, `userconfig` (includes `gridSize {minColumn, maxColumn, minRow, maxRow}`) |
| `pages` | page number as a string (`"20"`) | `{"name", "controls": {row: {col: "bank:<controlId>"}}, "id": <pageId>}` |
| `controls` | `bank:<controlId>` (button) or `trigger:<controlId>` | control JSON, below |
| `custom_variables` | variable name | `{description, defaultValue, persistCurrentValue, sortOrder}` |
| `surfaces`, `surface_groups`, `surfaces_remote`, `instances`, others | | not used by the tool yet |

Verified by DB; `trigger:` prefix also by main.js (controls are upgraded with `id.startsWith("trigger:")` deciding trigger vs button).

Notes:

- `pages.value.id` is an internal page id distinct from the page-number key. Writers keep it. At load, a missing or duplicate `id` is replaced with a fresh one. Verified by main.js.
- Pages load contiguously: the page store loads rows `"1"`, `"2"`, … and stops at the first missing or falsy row (`if(!o)break`; a row holding `null` ends the run too), so a row `"20"` without rows `"2"`…`"19"` is never loaded. Companion's own `insertPages` refuses a page number above count + 1, and its full import fills missing pages first. The page writer therefore creates the missing pages in between and refuses a stray or non-object row in that range ([ADR 0004](adr/0004-page-apply-creates-gap-pages.md)); the button writer refuses a page that is not loaded. The tool counts only JSON-object rows as loaded, which is stricter than Companion. Verified by main.js.
- A new page row is `{id: <nanoid>, name, controls: {}}` (`_addPages`). The default name is `"PAGE"`: `_addPages` falls back to it, the page store creates its first page with it, and `resetPage` renames a cleared page to it. The page writer creates gap pages in this shape. Verified by main.js. The live run replaced an existing page 99, so Companion loading a page row the tool rewrote is observed, but loading gap pages the tool created is not yet observed.
- Each page has a `page:<page id>` control, created at startup by `ensurePageControlsExist` for every loaded page. The tool never writes it, and keeping the page `id` keeps an existing page's control. Verified by main.js.
- The navigation buttons Companion adds to new pages (`pageup`, `pagenum`, `pagedown`) are ordinary `bank:` controls on the page; a page apply deletes them with the rest. Verified by main.js.
- Companion's location cache maps each control id to one location, so a control id in two cells is already inconsistent; the page writer refuses to delete a control another page also references. Verified by main.js.
- `pages.value.controls` keys rows and columns as strings. Locations must lie within `userconfig.gridSize`; the prototype's rows 0–3, columns 0–16 fit only because that install's grid had been widened.
- Custom variable `sortOrder` is an integer; the prototype appends new variables after the current maximum and keeps an existing variable's order.
- Custom variable names: Companion's `createVariable` accepts a name only when `name.replace(/[^\w]/gi, "_") === name` (non-empty, ASCII letters, digits and `_`) and it is not one of `__proto__`, `constructor`, `prototype`, `__defineGetter__`, `__defineSetter__`, `__lookupGetter__`, `__lookupSetter__`. A new variable gets `description: "A custom variable"`, `persistCurrentValue: false` and `sortOrder` = max existing + 1 (or 0). Verified by main.js.
- With `persistCurrentValue: true`, Companion writes the variable's current value into `defaultValue` (and `setVariableDefaultValue` refuses with "Cannot change default"). The variable writer therefore keeps the stored `defaultValue` of an already persisted variable that stays persisted, and takes the file's default otherwise. Verified by main.js.
- Every table is `CREATE TABLE IF NOT EXISTS <name> (id STRING UNIQUE, value STRING)`. `STRING` is not a SQLite type name, so both columns get NUMERIC affinity: `"17"` is stored as the integer 17, and a numeric-looking id such as `007` or `1e5` becomes a number (7, 100000). Read values as text before `JSON.parse`. Verified by main.js and SQLite behaviour.

## Ids

Control ids are 21 characters from `A-Za-z0-9_-` (nanoid default alphabet). The same format is used for action, feedback and style-override ids inside a control.

Verified by DB (observed ids such as `EcAicmU5ReMbt07HSVKMT`). No custom nanoid alphabet was found in main.js, consistent with the nanoid default. The prototype generates ids this way and Companion accepted them.

## Button control (`button-layered`)

Verified by DB (shapes copied from existing controls), prototype (`verify.py` compared every generated control's key paths against Companion-made controls) and a successful load in 5.1.0.

```json
{
  "type": "button-layered",
  "options": {"stepProgression": "auto", "stepExpression": "", "rotaryActions": false,
              "canModifyStyleInApis": true, "notes": ""},
  "localVariables": [],
  "steps": {
    "0": {"action_sets": {"down": [], "up": [], "rotate_left": [], "rotate_right": []},
          "options": {"runWhileHeld": []}}
  },
  "feedbacks": [],
  "style": {"layers": ["canvas", "box0", "image0", "text0"]}
}
```

(`layers` abbreviated: each is an object, below.)

- **Option values** inside layers, actions and feedbacks are wrapped: `{"value": <v>, "isExpression": false}`.
- **Layers**, in order:
  - `canvas` (type `canvas`): `decoration`, `showStatusIcons` (both `"default"`).
  - `box0` (type `box`, "Background"): common geometry (`enabled`, `opacity`, `x`, `y`, `width`, `height`, `rotation`), `color`, `borderWidth`, `borderColor`, `borderPosition: "inside"`, `pinnedProperties: ["color"]`.
  - `image0` (type `image`): common geometry, `base64Image: null`, `halign`, `valign`, `fillMode: "fit"`, `pinnedProperties`.
  - `text0` (type `text`): common geometry, `text`, `color`, `halign`, `valign`, `fontsize: 100`, `fontsizeAllowShrink: true`, `font: "companion-sans"`, `outlineColor: 4278190080`, `pinnedProperties`.
  - Every layer has `id`, `name`, `usage: "auto"`, `type`.
- **Colors** are integers `0xRRGGBB`.
- **Text line breaks** are stored as a literal backslash followed by `n` (two characters), not a newline.
- **Steps** are keyed `"0"`, `"1"`, …. With `stepProgression: "auto"`, each press advances to the next step.
- **Rotary**: `options.rotaryActions: true` enables `rotate_left` / `rotate_right` sets for encoders.

## Actions

```json
{"type": "action", "id": "<nanoid>", "definitionId": "custom_variable_set_value",
 "connectionId": "internal",
 "options": {"name": {"value": "sk_last", "isExpression": false},
             "value": {"value": "S1", "isExpression": false}}}
```

Increment: `"value": {"isExpression": true, "value": "$(this:current) + 1"}`.

Verified by DB, prototype and main.js: in 5.1 the upgrade rewrites `custom_variable_set_expression` into `custom_variable_set_value` with `options.value = {isExpression: true, …}`; the older `math_operation` style actions are folded into it too. Over REST, presses on the prototype page incremented `sk_presses` and encoders counted up and down.

## Feedbacks

Feedbacks live at control level (`feedbacks`, a list), not per step. Every feedback the CLI writes is a boolean feedback with this shape; the kinds differ only in `definitionId`, `connectionId` and `options`:

```json
{"type": "feedback", "id": "<nanoid>", "definitionId": "bank_current_step",
 "connectionId": "internal",
 "options": {"step": {"value": 2, "isExpression": false},
             "location": {"value": "$(this:location)", "isExpression": false}},
 "isInverted": {"value": false, "isExpression": false},
 "styleOverrides": [{"overrideId": "<nanoid>", "elementId": "box0",
                     "elementProperty": "color",
                     "override": {"value": 65280, "isExpression": false}}],
 "children": {}}
```

- **Style overrides** name a layer and one of its properties: background color is `box0` / `color`, text color `text0` / `color`, text `text0` / `text`. Values are wrapped like layer properties (colors as integers, text with literal backslash-n line breaks). Only the listed properties change while the feedback holds. Verified by DB (shape copied from an existing control) and prototype; main.js converts old-style button styles into overrides with the same `{overrideId, elementId, elementProperty, override}` entries, using `elementProperty` `"color"` for colors and `"text"` for text, and wraps them in a `check_expression` feedback with `options: {expression: qs("true")}`.
- **`bank_current_step`** (connection `internal`): holds while the button is on step `step`. `step` is **1-based**: step key `"0"` is step 1. Verified by main.js: the feedback is evaluated as `actionSets.getActiveStepIndex() + 1 === Number(step)`, and its definition ("Button: Check step", `feedbackType: "boolean"`, `showInvert: true`) declares `step` as a `number` option with `default: 1, min: 1`. Consistent with the prototype latch, which showed ON on its second step with `step: 2`. Observed live: the CLI-written S9 latch on page 99 showed green `ON` after one press and red `OFF` after the second (live run).
- **`check_expression`** (connection `internal`): holds while a boolean expression is true.

  ```json
  {"definitionId": "check_expression", "connectionId": "internal",
   "options": {"expression": {"value": "$(custom:fx_label) == 'on'", "isExpression": true}}}
  ```

  Verified by main.js: the internal feedback definition `check_expression` ("Variable: Check boolean expression", `feedbackType: "boolean"`, `showInvert: true`) has one option, `id: "expression"` of `type: "expression"`; the definition sets `optionsSupportExpressions: true`, and for such definitions the option parser sets `forceExpression` on `type: "expression"` options, so this value is always evaluated as an expression (definitions without `optionsSupportExpressions` do not get that branch). Companion's own upgrade code builds this feedback as `options: {expression: qs(...)}`, where `qs(t)` returns `{value: t, isExpression: true}`.
- **Pass-through** (any connection): `definitionId` is the module's feedback id, `connectionId` the connection id, and each option is wrapped as `{"value": <v>, "isExpression": false}`, the same as pass-through actions. Observed in main.js: module feedbacks carry the same `type`, `definitionId`, `connectionId`, `options`, `isInverted` and `styleOverrides` fields as internal ones. Valid definition ids and options are the module's own and are not checked.
- **`isInverted`** is a wrapped boolean (`{"value": true, "isExpression": false}` inverts the condition); the boolean feedbacks above declare `showInvert: true` in main.js.

`bank_current_step` rows written by the CLI loaded and rendered in the live run. Companion loading and rendering the `check_expression` and pass-through rows the CLI writes is not yet observed: the SKAARHOJ test page has neither.

## Triggers

Stored in `controls` with id `trigger:<controlId>` (21-character nanoid, like button ids). Every fact below is verified by main.js (5.1.0); Companion loading a trigger the tool wrote is not yet observed: the live run (#10) applied no trigger.

Stored control, from the trigger class's `toJSON` (the class with `type="trigger"` and `static DefaultOptions`), which its constructor reads back (`this.options=n.options||this.options`, `this.entities.loadStorage(n,…)`, `this.events=n.events||this.events`):

```json
{
  "type": "trigger",
  "options": { "name": "New Trigger", "enabled": false, "sortOrder": 0, "notes": "" },
  "actions": [ /* action entities, as on buttons */ ],
  "condition": [ /* feedback entities: the condition, checked before the actions run */ ],
  "events": [ { "id": "<nanoid>", "type": "interval", "enabled": true, "options": { "seconds": 10 } } ],
  "localVariables": []
}
```

- Default options are `DefaultOptions={name:"New Trigger",enabled:!1,sortOrder:0,notes:""}`. `options.collectionId` is optional: it is set when the trigger is in a trigger collection. The stored `options` replace the defaults wholesale (no merge), so the tool writes all four keys. The tool's own default for `enabled` is `true`, unlike Companion's.
- The legacy shape with `action_sets: {0: [...]}` and `options.relativeDelay` belongs only to the import and old-version upgrade code (`bBt`, `hee`); 5.1 stores `actions`.
- Actions are the same entities as button actions (`{type: "action", id, definitionId, connectionId, options}` with wrapped options). `custom_variable_set_value` builds its parser with `createChildParser({"this:current": <the target variable's value>})`, independent of the control, so `increment` and `decrement` work in triggers.
- Events are created by `createEventItem(e)`: `{id: xe(), type: e, enabled: !0, options: {}}`, then each option of the event definition (table `VK`) is copied with `structuredClone(o.default)`. Option values are **plain**, not wrapped: `eventSetOptions` assigns the raw value (`o.options[r]=n`), and the runtime (`#g`) reads `Number(e.options.seconds)`, `Number(e.options.delay)` and `Re(e.options.variableId)`.
  - `startup`: `options: {delay: <ms>}`, `min:0`, default `1e4` (10000). Runs the actions `delay` ms after startup.
  - `interval`: `options: {seconds: <n>}`, `min:1`, default `10` ("Time Interval: Fixed").
  - `variable_changed`: `options: {variableId: "custom:<name>"}` (an `internal:variable` option). The description renders `$(` + variableId + `)`, and the change listener matches the id against the changed variable ids, which `setVariableValues` emits as `${e}:${a.id}` (label and name, so `custom:<name>` for a custom variable).
  - Also defined, not written by the tool: `intervalRandom`, `timeofday`, `specificDate`, `sun_event`, `client_connect`, `button_press`, `button_release`, `condition_true`, `condition_false`, and on macOS and Windows `computer_locked`, `computer_unlocked`.
- Loading: at startup the controls store's `init()` reads every `controls` row and calls `createClassForControl(id, "all", value, …)`, which builds a trigger for `value.type === "trigger"` (the stored type decides, not the id prefix). It then calls `setCollectionEnabled(isCollectionEnabled(options.collectionId))`, and `isCollectionEnabled` returns `true` for a missing `collectionId`, so a trigger outside any collection runs whenever `options.enabled` is true. A kept `collectionId` has two cases. If it names an existing collection that is disabled, `isCollectionEnabled` returns false and the replaced trigger never runs, however `enabled` is set. If it names a collection that no longer exists, `isCollectionEnabled` also returns false at first, but `init()` then calls `checkCollectionIdIsValid` with `collectAllCollectionIds()` on every trigger. That clears the unknown `collectionId`, calls `setCollectionEnabled(!0)` and saves, so the trigger moves out of any collection and runs.
- Sort order: the UI's create adds the new trigger, then sets `sortOrder` to `Math.max(0, ...all triggers' sortOrder)`. The tool appends instead: 1 + the highest existing trigger `sortOrder`, or 0 for the first trigger. A replace keeps the `sortOrder` and `collectionId` of the trigger it replaces.
- Identity: Companion has no unique trigger name; the tool identifies a trigger by `options.name` and refuses when several share it.

## REST API

Companion serves two separate runtime APIs on its web port. They are enabled by different settings, authenticate differently and answer in different formats. Verified by main.js (5.1.0) and OpenAPI, plus a live read-only `GET /api/v2/openapi.json` on 2026-10-14.

| | HTTP API | REST API v2 |
| --- | --- | --- |
| Paths | `/api/location/...`, `/api/custom-variable/...`, others | `/api/v2/...` |
| Enabled by | `http_api_enabled` (default on). Disabled: every route answers `403` with an empty body. (main.js) | `rest_api_enabled` (default off). Disabled: `403 {"error": {"code": "API_DISABLED", "message": "REST API is disabled"}}`. (main.js) |
| Auth | None: the Bearer token is not checked. (main.js) | `Authorization: Bearer <key>`; key scopes `read`, `write`, `execute`, `connections`, `admin`. Surfaces need `read`. (OpenAPI) |
| Responses | Plain text (`ok`, `No control`, `Not found`, the value). (main.js) | JSON: `{"data": ...}`; errors `{"error": {"code", "message"}}`. (OpenAPI, main.js) |
| Described in OpenAPI | No | Yes, `GET /api/v2/openapi.json` (served before auth, still subject to `rest_api_enabled`). |

The deprecated `http_legacy_api_enabled` routes (`/press/bank/...`, `/set/custom-variable/...`) are not used.

### HTTP API

| Purpose | Endpoint | Verified by |
| --- | --- | --- |
| Button runtime | `POST /api/location/:page/:row/:column/press`, `/down`, `/up`, `/rotate-left`, `/rotate-right`, `/step`, `/style` | main.js |
| Custom variable | `GET` and `POST /api/custom-variable/:name/value` | main.js |
| Module variable | `GET /api/variable/:label/:name/value` (not used) | main.js |

Location commands answer `200 ok` on success and `204 No control` when no control exists at the location (a 204 carries no body to the client). `press` presses and auto-releases about 20 ms later on Companion's side. Verified by main.js.

`GET /api/custom-variable/:name/value` answers `200` with the value as plain text (numbers stringified), or `404 Not found`. Verified by main.js.

`POST /api/custom-variable/:name/value` takes the value from the first of these that applies (main.js, `#h` handler):

1. a `value` query parameter (always a string);
2. a JSON body, only when `Content-Type` is exactly `application/json` (compared lowercased to that literal, so `application/json; charset=utf-8` does not match). The app-wide parser is `express.json({strict: false})`, so a bare JSON primitive (`0`, `true`, `"abc"`) is accepted and stored with its type. A non-empty object or array is stored as given and an empty object stores `undefined`;
3. any other truthy, non-object body (for example `text/plain`), stringified and trimmed.

When none applies, it answers `400 No value`. An unknown variable gives `404 Not found`; success gives `200 ok`. Because `express.json` still parses a JSON body sent with a `charset` parameter, such a body skips branch 2 and falls to branch 3: a typed value is stored as a string, and a falsy one (`0`, `false`) is refused with `400 No value`. Verified by main.js.

### REST API v2

| Purpose | Endpoint | Verified by |
| --- | --- | --- |
| Surfaces | `GET /api/v2/surfaces/v1` (`{"data": [surface], "meta"}`), `GET /api/v2/surfaces/v1/:surfaceId` (`{"data": surface}`); `PATCH` changes brightness only | OpenAPI |
| Connections | CRUD under `/api/v2/connections/v1` | OpenAPI |
| Spec | `GET /api/v2/openapi.json` | OpenAPI, live call |

A surface has `id`, `type`, `integrationType`, `name`, `displayName`, `isConnected`, `size` (`{rows, columns}` or null), `brightness`, `page` (`{id, number, name}` or null; `number` and `name` are each nullable) and `groupId`. Documented error statuses are `400`, `401`, `403` and `404`. Verified by OpenAPI.

### Other

Export lives under `/export/page/:page`, `/export/full` and others (prototype run).

Not possible over REST: creating or editing buttons, pages or triggers; moving a surface to a page.

Known quirk: rapid back-to-back presses can lose an increment, because the actions of overlapping presses race. Fine at human speed; a test harness should pace presses.

## Live acceptance run (2026-10-14)

The SKAARHOJ test page (`examples/skaarhoj-test-page/`, #10) was applied to a local Companion 5.1.0 install on macOS, a copy of a production configuration, in live-install mode (no `--db`).

- **Variables.** The dry run printed `no changes` and `custom variables: 0 created, 12 replaced`: the 12 `sk_*` variables already existed from the prototype and were identical, so the variables apply was skipped.
- **Page.** The dry run reported 47 controls added and page 99 replaced. Page 99 already existed as an empty page named "Blank page" (the install had 99 or more pages), so no gap pages were created. The real apply printed `quitting Companion`, a `backup:` path under `<db dir>/companion-cli-backups/<timestamp>`, `starting Companion`, then `page 99 "SKAARHOJ TEST": replaced; deleted 0 controls, wrote 47 controls`.
- **Live-install mode.** This was the first real run of the `osascript` quit, the server-process wait, the `lsof` in-use guard, the backup and `open -a Companion`. All worked, with no quit prompt or spurious holder reported. After the restart, `variable get sk_presses` answered `0`.
- **REST smoke test** (paced, values read before and after):
  - press S1 (99/1/5): `sk_presses` 0 to 1, `sk_last` "" to `S1`;
  - rotate-right then rotate-left E1 (99/0/3): `sk_enc1` 0 to 1 to 0;
  - press E1: `sk_enc1` `0`, `sk_last` `E1 push`.
- **Visual check.** S9 (99/1/13), the two-step latch with a `bank_current_step` feedback, pressed twice: green `ON`, then red `OFF`.

So Companion 5.1.0 loads and runs what the CLI writes for page rows, button controls with actions, rotary actions, steps, and the `bank_current_step` feedback with style overrides.

Not yet verified live:

- `check_expression` and pass-through feedbacks;
- triggers (#9);
- creating gap pages;
- a dry run against a database whose variables differ from the description.
