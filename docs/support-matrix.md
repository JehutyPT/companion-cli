# Support matrix

<!-- Generated from src/support-matrix.ts by `npm run gen:support-matrix`. Do not edit by hand. -->

What the description format covers of what Companion 5.1 stores. Export and apply cover the same surface ([ADR 0006](adr/0006-export-apply-symmetry.md)), and `npm test` fails when this file disagrees with the writers or omits an item from Companion's own lists.

- **supported**: apply writes it, and export (#18, #19, not yet built) reads it back. *Field* is the description field (`action: set.value` is the `value` field of an `action: set` entry); a supported row without one is a value the writers keep or always write.
- **planned**: not in the format yet; the ticket adds it.
- **unsupported**: not planned. Apply never writes it, export (once built) refuses content that has it, and `list` and `find` still show it.

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

## Button

| Item | Status | Field | Note |
| --- | --- | --- | --- |
| `steps` | supported | `button.steps` | one step from the top-level action lists, or the `steps` list |
| `feedbacks` | supported | `button.feedbacks` |  |

## Button option

| Item | Status | Field | Note |
| --- | --- | --- | --- |
| `options.rotaryActions` | supported |  | set when any step lists rotate actions |
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
| `variable_changed (custom: variables)` | supported | `event: variable_changed`, `event: variable_changed.variable` |  |
| `variable_changed (other variables)` | planned (#27) |  |  |
| `intervalRandom` | planned (#27) |  |  |
| `timeofday` | planned (#27) |  |  |
| `specificDate` | planned (#27) |  |  |
| `sun_event` | planned (#27) |  |  |
| `client_connect` | planned (#27) |  |  |
| `button_press` | planned (#27) |  |  |
| `button_release` | planned (#27) |  |  |
| `condition_true` | planned (#27) |  |  |
| `condition_false` | planned (#27) |  |  |
| `computer_locked` | planned (#27) |  | macOS and Windows only |
| `computer_unlocked` | planned (#27) |  | macOS and Windows only |
| `enabled = false` | planned (#27) |  | disabled events; the writer stores every event enabled |

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
| `label` | planned (#31) |  |  |
| `enabled` | planned (#31) |  |  |
| `config keys` | planned (#31) |  | merged |
| `secrets` | planned (#31) |  | from the environment, write only |
| `create` | unsupported |  |  |
| `delete` | unsupported |  |  |
| `module` | unsupported |  |  |
| `version` | unsupported |  |  |
| `update policy` | unsupported |  |  |
| `removing config keys` | unsupported |  |  |

## Surface

| Item | Status | Field | Note |
| --- | --- | --- | --- |
| `name` | planned (#32) |  |  |
| `enabled` | planned (#32) |  |  |
| `Companion-owned config` | planned (#32) |  | merged |
| `transfer_input_*` | planned (#32) |  |  |
| `transfer_output_*` | planned (#32) |  |  |
| `plugin_cfg_*` | planned (#32) |  |  |
| `other config keys` | planned (#32) |  | merged |
| `groupId` | unsupported |  |  |
| `groupConfig` | unsupported |  |  |
| `surface groups` | unsupported |  |  |
| `outbound surfaces` | unsupported |  |  |
| `creating or forgetting surfaces` | unsupported |  |  |
