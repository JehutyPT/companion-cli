import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ValidationError } from "../src/core/errors.ts";
import {
  buttonVariableReferences,
  parseButton,
} from "../src/writers/button-control.ts";

/**
 * The page writer embeds button descriptions (`buttons[3]`), so the button
 * parser and its variable references take a path prefix.
 */
const PREFIX = "buttons[3]";

function parseError(fields: Record<string, unknown>): string {
  try {
    parseButton(fields, PREFIX);
  } catch (error) {
    assert.ok(error instanceof ValidationError, String(error));
    return error.message;
  }
  assert.fail("expected a ValidationError");
}

const base = {
  location: { page: 1, row: 0, column: 0 },
  text: "t",
  background: "#000000",
};

describe("button paths under a prefix", () => {
  it("prefixes parse errors at every level", () => {
    assert.match(
      parseError({ ...base, x: 1 }),
      /^buttons\[3\]\.x: unknown field/,
    );
    assert.match(
      parseError({ ...base, location: { page: 0, row: 0, column: 0 } }),
      /^buttons\[3\]\.location\.page: must be at least 1/,
    );
    assert.match(
      parseError({ ...base, background: "red" }),
      /^buttons\[3\]\.background: must be a color/,
    );
    assert.match(
      parseError({ ...base, down: [], steps: [{}] }),
      /^buttons\[3\]\.down: cannot be combined with steps/,
    );
    assert.match(
      parseError({ ...base, steps: [] }),
      /^buttons\[3\]\.steps: must not be empty/,
    );
    assert.match(
      parseError({ ...base, steps: [{}, { down: [{ action: "nope" }] }] }),
      /^buttons\[3\]\.steps\[1\]\.down\[0\]\.action: unknown action/,
    );
    assert.match(
      parseError({
        ...base,
        feedbacks: [{ feedback: "step", step: 2, style: { text: "a" } }],
      }),
      /^buttons\[3\]\.feedbacks\[0\]\.step: must be an integer between 1 and 1/,
    );
  });

  it("prefixes variable references", () => {
    const withSteps = parseButton(
      {
        ...base,
        text: "$(custom:a)",
        steps: [{ up: [{ action: "increment", variable: "b" }] }],
        feedbacks: [
          {
            feedback: "expression",
            expression: "$(custom:c)",
            style: { text: "$(custom:d)" },
          },
        ],
      },
      PREFIX,
    );
    assert.deepEqual(buttonVariableReferences(withSteps, PREFIX), [
      { field: "buttons[3].text", name: "a" },
      { field: "buttons[3].steps[0].up[0].variable", name: "b" },
      { field: "buttons[3].feedbacks[0].expression", name: "c" },
      { field: "buttons[3].feedbacks[0].style.text", name: "d" },
    ]);
    const topLevel = parseButton(
      { ...base, rotate_left: [{ action: "decrement", variable: "e" }] },
      PREFIX,
    );
    assert.deepEqual(buttonVariableReferences(topLevel, PREFIX), [
      { field: "buttons[3].rotate_left[0].variable", name: "e" },
    ]);
    assert.deepEqual(buttonVariableReferences(topLevel), [
      { field: "rotate_left[0].variable", name: "e" },
    ]);
  });
});
