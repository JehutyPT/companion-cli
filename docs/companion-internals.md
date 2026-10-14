# Companion 5.1 internals

Facts the tool depends on, for Companion 5.1.0 on macOS (DB version 17). Each section says how it was verified. These are internal formats: re-verify before supporting another Companion version.

Verification sources:

- **DB**: read from a real 5.1.0 `db.sqlite` (copied, never edited live).
- **main.js**: Companion's bundled server code, `/Applications/Companion.app/Contents/Resources/main.js` (minified; read-only greps).
- **Prototype**: `reference/python-prototype/fill_page20.py`, applied to a real 5.1.0 install, then exercised over REST.
- **OpenAPI**: `GET /api/v2/openapi.json` on the running install.

## Install and process (macOS)

| Fact | Verified by |
| --- | --- |
| Database: `~/Library/Application Support/companion/v5.1/db.sqlite`, SQLite in WAL mode. After a quit, `db.sqlite-wal` and `db.sqlite-shm` may still exist; a backup must copy all three or checkpoint first. | DB |
| Processes: the launcher is `Companion.app/Contents/MacOS/Companion` (with Electron helper processes). The server is its child, `node … Companion.app/Contents/Resources/main.js --config-dir=<…>/companion/ --admin-port=…`, run by a bundled runtime under `Companion.app/Contents/Resources/node-runtimes/`. Connection modules are children of the server and also run a `main.js`, from the configuration directory's `modules/<module>/` (`node … <…>/companion/modules/canon-ptz-2.5.0/main.js`); some carry `--allow-fs-read=…/Companion.app/Contents/Resources` but never `Resources/main.js`. Surface threads run `Companion.app/Contents/Resources/SurfaceThread.js`. "Running" therefore means a process whose command line contains `Companion.app/Contents/Resources/main.js`; a launcher without that process is not running. | `ps -axo pid,ppid,command` on a running 5.1 install (2026-10-14) |
| Quit: `osascript -e 'quit app "Companion"'`. Wait until the server process (the PIDs seen before the quit) has exited before opening the database. | Prototype run |
| In-use check: `lsof -t -- <db> <db>-wal <db>-shm` prints the PIDs that have any of the files open. It exits 1 when none is open and also when a listed file does not exist (a missing `-wal` or `-shm`); PIDs it prints still count. The tool refuses to write when any PID other than its own is listed, or when `lsof` exits with any other status. Matching by open files does not depend on the bundle name, so it also catches a renamed or development Companion. | lsof(8); not yet run against a live install |
| Restart: `open -a Companion`. The launcher starts the server on its own. | Prototype run |
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

- `pages.value.id` is an internal page id distinct from the page-number key. Writers keep it. The prototype requires the `pages` row to exist; creating a missing page row is unverified.
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
- **Colours** are integers `0xRRGGBB`.
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

`bank_current_step` (connection `internal`), used for a two-step latch:

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

`step` is 1-based: step key `"1"` is step 2 (inferred from the prototype latch, which showed ON on its second step). Verified by DB (shape copied from an existing control), main.js (definition id present) and prototype.

## Triggers

Stored in `controls` with id `trigger:<controlId>`. Action shapes are the same as for buttons. The trigger body, event types (startup, variable change, interval, …) and conditions are **unverified** and need research before the trigger writer.

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
