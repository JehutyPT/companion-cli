/**
 * The census fixture: the standard fixture's rows cleared, then one or more
 * of every case the census counts. Every value a census must not print
 * contains `SENTINEL`; keys, types, module ids and definition ids do not.
 */
import type { DatabaseSync } from "node:sqlite";
import { buttonLayers } from "../src/writers/button-control.ts";
import { insert } from "./list-fixture.ts";

/** The text every value in the fixture contains. */
export const SENTINEL = "SENTINEL";

export const ALPHA_ID = "SENTINEL-conn-alpha";
export const NO_MODULE_ID = "SENTINEL-conn-nomodule";

const prop = (value: unknown, isExpression = false) => ({
  value,
  isExpression,
});

const action = (
  definitionId: string,
  connectionId: string,
  extra: Record<string, unknown> = {},
) => ({
  type: "action",
  id: `SENTINEL-id-${definitionId}`,
  definitionId,
  connectionId,
  options: { target: prop(`SENTINEL-option-${definitionId}`) },
  ...extra,
});

const feedback = (
  definitionId: string,
  connectionId: string,
  extra: Record<string, unknown> = {},
) => ({
  ...action(definitionId, connectionId),
  type: "feedback",
  ...extra,
});

const localVariable = (n: number) =>
  feedback("user_value", "internal", {
    variableName: `SENTINEL-local-${n}`,
    options: { startup_value: prop(`SENTINEL-startup-${n}`) },
  });

/** A local variable whose entity holds a child. */
const parentLocalVariable = () =>
  feedback("logic_and", "internal", {
    variableName: "SENTINEL-local-parent",
    options: { note: prop("SENTINEL-parent-option") },
    children: {
      conditions: [
        feedback("variable_value", ALPHA_ID, {
          options: { value: prop("SENTINEL-child-option", true) },
          headline: "SENTINEL-child-headline",
        }),
      ],
    },
  });

const emptySets = () => ({
  down: [],
  up: [],
  rotate_left: [],
  rotate_right: [],
});

const DEFAULT_OPTIONS = {
  stepProgression: "auto",
  stepExpression: "",
  rotaryActions: false,
  canModifyStyleInApis: true,
  notes: "",
};

/** A button exactly as the writers make it: matches the template. */
const templateButton = {
  type: "button-layered",
  options: DEFAULT_OPTIONS,
  localVariables: [],
  steps: {
    "0": {
      action_sets: {
        ...emptySets(),
        down: [
          action("custom_variable_set_value", "internal", {
            options: {
              name: prop("SENTINEL-varname"),
              value: prop("SENTINEL-expression + 1", true),
            },
          }),
        ],
      },
      options: { runWhileHeld: [] },
    },
  },
  feedbacks: [],
  style: { layers: buttonLayers("SENTINEL-text", 0x123456, 0x654321) },
};

/** A button made in the web UI: differs from the template everywhere. */
function oddButton() {
  const [, box, image, text] = buttonLayers("SENTINEL-text", 0x111111, 0);
  return {
    type: "button-layered",
    options: {
      stepProgression: "manual",
      stepExpression: "SENTINEL-step-expression",
      rotaryActions: true,
      canModifyStyleInApis: false,
      notes: "SENTINEL-button-notes",
      mysteryOption: "SENTINEL-mystery",
    },
    localVariables: [localVariable(1)],
    steps: {
      "0": {
        action_sets: {
          ...emptySets(),
          down: [
            action("run", ALPHA_ID, {
              disabled: true,
              headline: "SENTINEL-headline",
              upgradeIndex: 2,
              storeResult: {
                type: "custom-variable",
                variableName: prop("SENTINEL-store"),
                createIfNotExists: true,
              },
            }),
          ],
          "1000": [
            action("logic_if", "internal", {
              children: {
                default: [action("wait", "internal")],
                else: [],
              },
            }),
          ],
        },
        options: { runWhileHeld: [1000], name: "SENTINEL-step-name" },
      },
      "1": {
        action_sets: {
          ...emptySets(),
          rotate_left: [action("go", NO_MODULE_ID)],
        },
        options: { runWhileHeld: [] },
      },
      "2": {
        action_sets: {
          ...emptySets(),
          up: [action("lost", "SENTINEL-conn-missing")],
        },
        options: { runWhileHeld: [] },
      },
    },
    feedbacks: [
      feedback("tally", ALPHA_ID, {
        isInverted: prop(true),
        styleOverrides: [
          {
            overrideId: "SENTINEL-override-1",
            elementId: "box0",
            elementProperty: "color",
            override: prop(123456),
          },
          {
            overrideId: "SENTINEL-override-2",
            elementId: "text0",
            elementProperty: "text",
            override: prop("SENTINEL-override-text"),
          },
        ],
      }),
      feedback("check_expression", "internal", {
        options: { expression: prop("SENTINEL-feedback-expression", true) },
        isInverted: prop("SENTINEL-inverted-expression", true),
      }),
    ],
    style: {
      layers: [
        box,
        { ...image, base64Image: prop("SENTINEL-image") },
        {
          ...text,
          text: prop("SENTINEL-text-expression", true),
          fontsize: prop(80),
        },
        {
          id: "SENTINEL-layer-id",
          name: "SENTINEL-layer-name",
          type: "text",
          text: prop("SENTINEL-extra-text", true),
        },
      ],
    },
  };
}

/** Seeds the census fixture over the standard fixture. */
export function seedCensus(db: DatabaseSync): void {
  for (const table of ["controls", "pages", "custom_variables", "instances"]) {
    db.exec(`DELETE FROM ${table}`);
  }
  insert(db, "instances", ALPHA_ID, {
    moduleInstanceType: "connection",
    moduleId: "alpha-module",
    moduleVersionId: "1.0.0",
    label: "SENTINEL-label-alpha",
    config: { password: "SENTINEL-config" },
    secrets: { token: "SENTINEL-secret" },
    enabled: true,
    sortOrder: 0,
  });
  insert(db, "instances", NO_MODULE_ID, {
    moduleInstanceType: "connection",
    label: "SENTINEL-label-nomodule",
    config: {},
    secrets: {},
    enabled: true,
    sortOrder: 1,
  });

  insert(db, "controls", "bank:SENTINEL-template", templateButton);
  insert(db, "controls", "bank:SENTINEL-odd", oddButton());
  insert(db, "controls", "bank:SENTINEL-nav", { type: "pageup" });
  insert(db, "controls", "bank:SENTINEL-stray", {
    type: "button-layered",
    options: {},
    steps: {},
  });
  insert(db, "controls", "bank:SENTINEL-weird", { type: "mystery-type" });
  insert(db, "controls", "trigger:SENTINEL-t1", {
    type: "trigger",
    options: {
      name: "SENTINEL-trigger-name",
      enabled: false,
      sortOrder: 0,
      notes: "SENTINEL-trigger-notes",
      collectionId: "SENTINEL-collection",
    },
    actions: [action("run", ALPHA_ID)],
    condition: [
      feedback("variable_value", "internal", {
        options: { value: prop("SENTINEL-condition") },
      }),
    ],
    events: [
      {
        id: "SENTINEL-e1",
        type: "interval",
        enabled: true,
        options: { seconds: 7777 },
      },
      {
        id: "SENTINEL-e2",
        type: "interval",
        enabled: false,
        options: { seconds: 8888 },
      },
      {
        id: "SENTINEL-e3",
        type: "weird_event",
        enabled: true,
        options: { x: "SENTINEL-event-option" },
      },
    ],
    localVariables: [
      localVariable(2),
      localVariable(3),
      localVariable(4),
      parentLocalVariable(),
    ],
  });
  insert(db, "controls", "trigger:SENTINEL-t2", {
    type: "trigger",
    options: { name: "SENTINEL-trigger-2", enabled: true, sortOrder: 1 },
    actions: [
      {
        type: "gizmo",
        id: "SENTINEL-g",
        definitionId: "thing",
        connectionId: "internal",
      },
    ],
    condition: [],
    events: [
      {
        id: "SENTINEL-e4",
        type: "startup",
        enabled: true,
        options: { delay: 1 },
      },
    ],
  });

  insert(db, "pages", "1", {
    id: "SENTINEL-page-id",
    name: "SENTINEL-page-name",
    controls: {
      "0": {
        "0": "bank:SENTINEL-template",
        "1": "bank:SENTINEL-odd",
        "2": "bank:SENTINEL-nav",
      },
    },
  });

  insert(db, "custom_variables", "SENTINEL_var1", {
    description: "SENTINEL-description",
    defaultValue: "SENTINEL-default",
    persistCurrentValue: true,
    sortOrder: 0,
  });
  insert(db, "custom_variables", "SENTINEL_var2", {
    description: "SENTINEL-description-2",
    defaultValue: 5,
    persistCurrentValue: false,
    sortOrder: 1,
  });
  insert(db, "custom_variables", "SENTINEL_var3", {
    defaultValue: null,
    sortOrder: 2,
  });
}
