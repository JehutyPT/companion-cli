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
| Quit: `osascript -e 'quit app "Companion"'`. Wait until the process running `Companion.app/Contents/Resources/main.js` has exited before opening the database. | Prototype run |
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

Bearer API key; key scopes `read`, `write`, `execute`, `connections`, `admin`. Verified by OpenAPI and live calls during the prototype run.

| Purpose | Endpoint |
| --- | --- |
| Button runtime | `POST /api/location/:page/:row/:column/press`, `/down`, `/up`, `/rotate-left`, `/rotate-right`, `/step`, `/style` |
| Custom variable | `GET /api/custom-variable/:name/value`, `POST /api/custom-variable/:name/value` |
| Export | `/export/page/:page`, `/export/full`, and others |
| Connections | CRUD under `/api/v2/connections/v1` |
| Surfaces | list and get under `/api/v2/surfaces/v1`; `PATCH` changes brightness only |
| Spec | `GET /api/v2/openapi.json` |

Not possible over REST: creating or editing buttons, pages or triggers; moving a surface to a page.

Known quirk: rapid back-to-back presses can lose an increment, because the actions of overlapping presses race. Fine at human speed; a test harness should pace presses.
