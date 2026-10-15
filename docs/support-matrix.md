# Support matrix

<!-- Generated from src/support-matrix.ts by `npm run gen:support-matrix`. Do not edit by hand. -->

What the description format covers of what Companion 5.1 stores. Export and apply cover the same surface ([ADR 0006](adr/0006-export-apply-symmetry.md)), and `npm test` fails when this file disagrees with the writers or omits an item from Companion's own lists.

- **supported**: apply writes it, and export reads it back (custom variables, triggers, pages and buttons). *Field* is the description field (`action: set.value` is the `value` field of an `action: set` entry); a supported row without one is a value the writers keep or always write.
- **planned**: not in the format yet; the ticket adds it.
- **unsupported**: not planned. Apply never writes it, export refuses content that has it, and `list` and `find` still show it.

An export refusal names the stored field it cannot express; this file says whether that field is planned.

## Control type

| Item | Status | Field | Note |
| --- | --- | --- | --- |
| `button-layered` | supported | `kind: button`, `button.location` | on a page cell |
| `trigger` | supported | `kind: trigger` |  |
| `page` | unsupported |  | the `page:<id>` control Companion creates for each page; never written |
| `pageup` | unsupported |  | page navigation button; a page apply deletes it with the rest |
| `pagenum` | unsupported |  | page navigation button; a page apply deletes it with the rest |
| `pagedown` | unsupported |  | page navigation button; a page apply deletes it with the rest |
| `button` | unsupported |  | pre-layered button type; Companion upgrades it to `button-layered` at load |
| `preset:button` | unsupported |  | a module preset |
| `preset-reference` | unsupported |  | a button showing a preset |
| `button-reference` | unsupported |  | a button mirroring another |
| `expression-variable` | unsupported |  |  |

## Page

| Item | Status | Field | Note |
| --- | --- | --- | --- |
| `pages.id` | supported | `kind: page`, `page.page` | the page number |
| `pages.name` | supported | `page.name` | a page beyond the last plus one also creates the pages in between (ADR 0004) |
| `pages.controls` | supported | `page.buttons` | every cell of the page; each entry is a button with a cell location |
| `pages.name (empty or missing)` | unsupported |  | a page description needs a name; set one in Companion |
| `pages.controls (missing, shared, null or non-button cells)` | unsupported |  | a cell whose control has no row, is held by another cell or page, is null, or is not a `bank:` control |

## Button

| Item | Status | Field | Note |
| --- | --- | --- | --- |
| `steps` | supported | `button.steps` | one step from the top-level action lists, or the `steps` list |
| `feedbacks` | supported | `button.feedbacks` |  |

## Button option

| Item | Status | Field | Note |
| --- | --- | --- | --- |
| `options.rotaryActions` | supported |  | set when any step lists rotate actions |
| `options.rotaryActions = false with rotate actions` | unsupported |  | rotate actions Companion ignores; apply would turn them on |
| `options.stepProgression = "auto"` | supported |  | always written |
| `options.stepProgression = "manual"` | planned (#24) |  |  |
| `options.stepProgression = "expression"` | planned (#24) |  |  |
| `options.stepExpression` | planned (#24) |  |  |
| `options.canModifyStyleInApis` | planned (#24) |  | the writer stores `true` today; #24 adds opt-in `apiStyle` and Companion's default `false`; the CLI never uses the style API |
| `options.notes` | planned (#24) |  |  |

## Step

| Item | Status | Field | Note |
| --- | --- | --- | --- |
| `action_sets.down` | supported | `button.down`, `steps[].down` |  |
| `action_sets.up` | supported | `button.up`, `steps[].up` |  |
| `action_sets.rotate_left` | supported | `button.rotate_left`, `steps[].rotate_left` |  |
| `action_sets.rotate_right` | supported | `button.rotate_right`, `steps[].rotate_right` |  |
| `action_sets.<duration>` | planned (#24) |  | hold-duration action sets |
| `options.runWhileHeld` | planned (#24) |  |  |
| `options (other keys)` | unsupported |  |  |

## Style

| Item | Status | Field | Note |
| --- | --- | --- | --- |
| `layers (four-layer template)` | supported |  | `canvas`, `box0`, `image0`, `text0`, written from a template |
| `box0.color` | supported | `button.background`, `feedback.style.background` | also as a feedback override |
| `text0.color` | supported | `button.textColor`, `feedback.style.textColor` | also as a feedback override |
| `text0.text` | supported | `button.text`, `feedback.style.text` | also as a feedback override |
| `text0.text (trailing or raw line break)` | unsupported |  | a text ending in `\n`, or holding a line-feed character, does not round-trip |
| `other layer properties` | unsupported |  |  |
| `extra layers` | unsupported |  |  |
| `images` | unsupported |  |  |
| `expression-valued properties` | unsupported |  |  |

## Action

| Item | Status | Field | Note |
| --- | --- | --- | --- |
| `custom_variable_set_value (value)` | supported | `action: set`, `action: set.variable`, `action: set.value` |  |
| `custom_variable_set_value (expression)` | supported | `action: expression`, `action: expression.variable`, `action: expression.expression` |  |
| `custom_variable_set_value (increment)` | supported | `action: increment`, `action: increment.variable`, `action: increment.by` |  |
| `custom_variable_set_value (decrement)` | supported | `action: decrement`, `action: decrement.variable`, `action: decrement.by` |  |
| `module action` | supported | `action: passthrough`, `action: passthrough.connection`, `action: passthrough.definition`, `action: passthrough.options` | any connection's action, with literal options |
| `action.id` | supported |  | generated |
| `action.type` | supported |  | always `action` |
| `action.definitionId` | supported |  | from the action kind |
| `action.connectionId` | supported |  | from the action kind |
| `action.options` | supported |  | literal values |
| `action.options (expression values)` | planned (#23) |  |  |
| `action.disabled` | planned (#23) |  |  |
| `action.headline` | planned (#23) |  |  |
| `action.upgradeIndex` | planned (#23) |  |  |
| `action.children` | planned (#23) |  |  |
| `action.storeResult` | planned (#23) |  |  |

## Feedback

| Item | Status | Field | Note |
| --- | --- | --- | --- |
| `bank_current_step` | supported | `feedback: step`, `feedback: step.step` |  |
| `check_expression` | supported | `feedback: expression`, `feedback: expression.expression` |  |
| `module feedback` | supported | `feedback: passthrough`, `feedback: passthrough.connection`, `feedback: passthrough.definition`, `feedback: passthrough.options` | any connection's boolean feedback, with literal options |
| `feedbackType = "boolean"` | supported |  |  |
| `feedbackType = "advanced"` | planned (#23) |  |  |
| `feedbackType = "value"` | planned (#23) |  |  |
| `feedbackType = "style-override"` | planned (#23) |  | the feedback list type of a layered button's style list |
| `feedback.id` | supported |  | generated |
| `feedback.type` | supported |  | always `feedback` |
| `feedback.definitionId` | supported |  | from the feedback kind |
| `feedback.connectionId` | supported |  | from the feedback kind |
| `feedback.options` | supported |  | literal values |
| `feedback.options (expression values)` | planned (#23) |  |  |
| `feedback.isInverted` | supported | `feedback.invert` |  |
| `feedback.isInverted (expression)` | planned (#23) |  |  |
| `feedback.styleOverrides` | supported | `feedback.style`, `feedback.style.background`, `feedback.style.textColor`, `feedback.style.text` | on `box0.color`, `text0.color` and `text0.text` |
| `feedback.styleOverrides (empty)` | unsupported |  | a boolean feedback that overrides no style |
| `feedback.styleOverrides (other element properties)` | planned (#23) |  |  |
| `feedback.disabled` | planned (#23) |  |  |
| `feedback.headline` | planned (#23) |  |  |
| `feedback.upgradeIndex` | planned (#23) |  |  |
| `feedback.children` | planned (#23) |  |  |
| `feedback.variableName` | planned (#25) |  | names a feedback's value in a local-variables list |

## Local variable

| Item | Status | Field | Note |
| --- | --- | --- | --- |
| `localVariables (button)` | planned (#25) |  |  |
| `localVariables (trigger)` | planned (#25) |  |  |

## Trigger

| Item | Status | Field | Note |
| --- | --- | --- | --- |
| `events` | supported | `trigger.events` |  |
| `actions` | supported | `trigger.actions` |  |
| `several triggers in one file` | supported | `kind: triggers`, `triggers.triggers` | each entry is a `kind: trigger` body; `export triggers` writes one |

## Trigger option

| Item | Status | Field | Note |
| --- | --- | --- | --- |
| `options.name` | supported | `trigger.name` | the identity |
| `options.enabled` | supported | `trigger.enabled` |  |
| `options.sortOrder` | supported |  | kept; a new trigger goes after the highest |
| `options.collectionId` | supported |  | kept |
| `options.notes` | planned (#26) |  | reset to "" today |

## Event

| Item | Status | Field | Note |
| --- | --- | --- | --- |
| `startup` | supported | `event: startup`, `event: startup.delay` |  |
| `interval` | supported | `event: interval`, `event: interval.seconds` |  |
| `intervalRandom` | supported | `event: intervalRandom`, `event: intervalRandom.min`, `event: intervalRandom.max` | `minimum` and `maximum` |
| `timeofday` | supported | `event: timeofday`, `event: timeofday.time`, `event: timeofday.days` | time "HH:MM:SS"; day names in the file, numbers 0–6 (Sunday 0) stored |
| `specificDate` | supported | `event: specificDate`, `event: specificDate.date`, `event: specificDate.time` | date "YYYY-MM-DD", time "HH:MM:SS" or "HH:MM" |
| `sun_event` | supported | `event: sun_event`, `event: sun_event.sun`, `event: sun_event.latitude`, `event: sun_event.longitude`, `event: sun_event.offset` | `sun` is stored as `type` |
| `client_connect` | supported | `event: client_connect`, `event: client_connect.delay` |  |
| `button_press` | supported | `event: button_press` |  |
| `button_release` | supported | `event: button_release` |  |
| `variable_changed (custom: variables)` | supported | `event: variable_changed`, `event: variable_changed.variable` |  |
| `variable_changed (other variables)` | supported | `event: variable_changed.variableId` | any `<label>:<name>`, including `local:`; not checked against the database |
| `condition_true` | planned (#26) |  | fires when the trigger's conditions change |
| `condition_false` | planned (#26) |  | fires when the trigger's conditions change |
| `computer_locked` | supported | `event: computer_locked` | Companion registers it on macOS and Windows only; Companion on Linux ignores it |
| `computer_unlocked` | supported | `event: computer_unlocked` | Companion registers it on macOS and Windows only; Companion on Linux ignores it |
| `enabled = false` | supported | `event.enabled` | on any event; enabled by default |

## Condition

| Item | Status | Field | Note |
| --- | --- | --- | --- |
| `condition` | planned (#26) |  | boolean feedback entities |

## Custom variable

| Item | Status | Field | Note |
| --- | --- | --- | --- |
| `name` | supported | `kind: variables`, `variables.variables`, `variables[].name` |  |
| `defaultValue (string, number, boolean)` | supported | `variables[].default` | a persisted variable keeps its stored value |
| `description` | supported | `variables[].description` |  |
| `persistCurrentValue` | supported | `variables[].persist` |  |
| `sortOrder` | supported |  | kept; a new variable goes after the highest |
| `defaultValue (null, object or list)` | unsupported |  |  |

## Connection

| Item | Status | Field | Note |
| --- | --- | --- | --- |
| `label` | supported | `kind: connection`, `connection.connection`, `connection.label` | a rename is refused while controls reference the old label |
| `enabled` | supported | `connection.enabled` |  |
| `config keys` | supported | `connection.config` | merged; checked against the module's fields when Companion runs |
| `secrets` | supported | `connection.secrets` | from the environment, write only; never exported |
| `isFirstInit` | supported |  | set to false with a config, as Companion does |
| `rename while referenced` | unsupported |  | Companion rewrites references on its own rename; a database write cannot. Planned only with an ADR |
| `create` | unsupported |  |  |
| `delete` | unsupported |  |  |
| `module` | unsupported |  |  |
| `version` | unsupported |  |  |
| `update policy` | unsupported |  |  |
| `removing config keys` | unsupported |  | planned only with an ADR |
| `sortOrder` | unsupported |  |  |
| `collectionId` | unsupported |  |  |

## Surface

| Item | Status | Field | Note |
| --- | --- | --- | --- |
| `name` | supported | `kind: surface`, `surface.surface`, `surface.name` | an existing surface, by its stored id |
| `enabled` | supported | `surface.enabled` |  |
| `Companion-owned config` | supported | `surface.brightness`, `surface.rotation`, `surface.xOffset`, `surface.yOffset` | merged |
| `transfer_input_*` | supported | `surface.transferInputs` | a custom variable, checked |
| `transfer_output_*` | supported | `surface.transferOutputs` | an expression; $(custom:…) references checked |
| `plugin_cfg_*` | supported | `surface.plugin` |  |
| `other config keys` | supported | `surface.config` | merged; checked against the surface's config fields when it is connected |
| `groupId` | unsupported |  | a surface in a manual group is refused on export |
| `groupConfig` | unsupported |  | kept as stored, never exported |
| `removing config keys` | unsupported |  |  |
| `surface groups` | unsupported |  |  |
| `outbound surfaces` | unsupported |  |  |
| `creating or forgetting surfaces` | unsupported |  |  |

## Census

Not yet run. The user runs `companion-cli census` on a copy of their database (see the README) and records here the date, the summary counts per area and the order of tickets #23–#27 it leads to, without module or definition lists.
