/**
 * Every Companion 5.1 trigger event kind (#27): the stored options each kind
 * writes, its defaults, disabled events, and the refusals with field paths.
 * The stored shapes follow Resources/EventDefinitions.ts and
 * Triggers/Events/Timer.ts (docs/companion-internals.md, "Triggers").
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDescription } from "../src/core/description.ts";
import { ValidationError } from "../src/core/errors.ts";
import { writers } from "../src/writers/index.ts";
import {
  applyYaml,
  dumpDatabase,
  type Json,
  stripIds,
  type TableDump,
} from "./helpers.ts";

function newTrigger(before: TableDump, after: TableDump): Json {
  const known = new Set((before["controls"] ?? []).map((row) => row.id));
  const added = (after["controls"] ?? []).filter((row) => !known.has(row.id));
  assert.equal(added.length, 1);
  return JSON.parse(String(added[0]?.["value"])) as Json;
}

/** The stored events a trigger with these YAML event lines (and `rest`) gets. */
async function storedEvents(events: string, rest = ""): Promise<Json[]> {
  const { dbPath, before, result } = await applyYaml(
    `kind: trigger\nname: T\nevents:\n${events}${rest}`,
  );
  assert.equal(result.code, 0, result.stderr.join("\n"));
  const control = stripIds(newTrigger(before, dumpDatabase(dbPath))) as Json;
  return control["events"] as Json[];
}

const event = (type: string, options: Json, enabled = true) => ({
  id: "<id>",
  type,
  enabled,
  options,
});

describe("trigger events: stored options", () => {
  it("writes every event kind with its fields, in Companion's key order", async () => {
    assert.deepEqual(
      await storedEvents(
        `  - { event: intervalRandom, min: 2, max: 9 }
  - { event: timeofday, time: "08:30:00", days: [mon, tue, wed, thu, fri] }
  - { event: timeofday, time: "23:59:59", days: [sat, sun] }
  - { event: specificDate, date: "2026-12-31", time: "23:00:00" }
  - { event: specificDate, date: "2027-02-28", time: "07:15" }
  - { event: sun_event, sun: sunset, latitude: 38.72, longitude: -9.14, offset: -10 }
  - { event: client_connect, delay: 250 }
  - { event: button_press }
  - { event: button_release }
  - { event: computer_locked }
  - { event: computer_unlocked }
  - { event: variable_changed, variableId: "internal:time_hms" }
  - { event: variable_changed, variableId: "local:counter" }
`,
        "localVariables: [{ name: counter, value: 0 }]\n",
      ),
      [
        event("intervalRandom", { minimum: 2, maximum: 9 }),
        event("timeofday", { time: "08:30:00", days: [1, 2, 3, 4, 5] }),
        event("timeofday", { time: "23:59:59", days: [6, 0] }),
        event("specificDate", { date: "2026-12-31", time: "23:00:00" }),
        event("specificDate", { date: "2027-02-28", time: "07:15" }),
        event("sun_event", {
          type: "sunset",
          latitude: 38.72,
          longitude: -9.14,
          offset: -10,
        }),
        event("client_connect", { delay: 250 }),
        event("button_press", {}),
        event("button_release", {}),
        event("computer_locked", {}),
        event("computer_unlocked", {}),
        event("variable_changed", { variableId: "internal:time_hms" }),
        event("variable_changed", { variableId: "local:counter" }),
      ],
    );
  });

  it("fills Companion's defaults", async () => {
    assert.deepEqual(
      await storedEvents(`  - { event: intervalRandom }
  - { event: timeofday, time: "00:00:00" }
  - { event: sun_event }
  - { event: client_connect }
`),
      [
        event("intervalRandom", { minimum: 3, maximum: 10 }),
        event("timeofday", { time: "00:00:00", days: [0, 1, 2, 3, 4, 5, 6] }),
        event("sun_event", {
          type: "sunrise",
          latitude: 0,
          longitude: 0,
          offset: 0,
        }),
        event("client_connect", { delay: 0 }),
      ],
    );
  });

  it("writes enabled: false on any event, and true by default", async () => {
    assert.deepEqual(
      await storedEvents(`  - { event: startup, enabled: false }
  - { event: button_press, enabled: true }
  - { event: variable_changed, variable: fx_counter, enabled: false }
  - { event: interval, seconds: 1, enabled: false }
  - { event: intervalRandom, enabled: false }
  - { event: timeofday, time: "08:00:00", days: [sun], enabled: false }
  - { event: specificDate, date: "2026-12-31", time: "23:00", enabled: false }
  - { event: sun_event, enabled: false }
  - { event: client_connect, enabled: false }
  - { event: button_release, enabled: false }
  - { event: variable_changed, variableId: "internal:time_hms", enabled: false }
  - { event: computer_locked, enabled: false }
  - { event: computer_unlocked, enabled: false }
`),
      [
        event("startup", { delay: 10000 }, false),
        event("button_press", {}),
        event("variable_changed", { variableId: "custom:fx_counter" }, false),
        event("interval", { seconds: 1 }, false),
        event("intervalRandom", { minimum: 3, maximum: 10 }, false),
        event("timeofday", { time: "08:00:00", days: [0] }, false),
        event("specificDate", { date: "2026-12-31", time: "23:00" }, false),
        event(
          "sun_event",
          { type: "sunrise", latitude: 0, longitude: 0, offset: 0 },
          false,
        ),
        event("client_connect", { delay: 0 }, false),
        event("button_release", {}, false),
        event("variable_changed", { variableId: "internal:time_hms" }, false),
        event("computer_locked", {}, false),
        event("computer_unlocked", {}, false),
      ],
    );
  });
});

describe("trigger events: refusals name the field", () => {
  const refusal = (entry: Json): string => {
    try {
      parseDescription(
        {
          kind: "triggers",
          triggers: [{ name: "T", events: [entry] }],
        },
        writers,
      );
    } catch (error) {
      if (error instanceof ValidationError) return error.message;
      throw error;
    }
    assert.fail("accepted");
  };
  const cases: Array<[string, Json, string]> = [
    [
      "a fractional random minimum",
      { event: "intervalRandom", min: 1.5 },
      "min: must be a positive integer, got 1.5",
    ],
    [
      "a zero random maximum",
      { event: "intervalRandom", max: 0 },
      "max: must be a positive integer, got 0",
    ],
    [
      "a random maximum below its minimum",
      { event: "intervalRandom", min: 5, max: 4 },
      "max: must be at least min (5), got 4",
    ],
    ["a time of day without time", { event: "timeofday" }, "time: is required"],
    [
      "a time of day without seconds",
      { event: "timeofday", time: "08:00" },
      'time: must be a time "HH:MM:SS", got "08:00"',
    ],
    [
      "a time of day past 23",
      { event: "timeofday", time: "24:00:00" },
      'time: must be a time "HH:MM:SS", got "24:00:00"',
    ],
    [
      "no days",
      { event: "timeofday", time: "08:00:00", days: [] },
      "days: must list at least one day",
    ],
    [
      "an unknown day",
      { event: "timeofday", time: "08:00:00", days: ["mon", "monday"] },
      'days[1]: unknown day "monday" (expected one of: sun, mon, tue, wed, thu, fri, sat)',
    ],
    [
      "a repeated day",
      { event: "timeofday", time: "08:00:00", days: ["mon", "mon"] },
      'days[1]: duplicate day "mon"',
    ],
    [
      "a date without its time",
      { event: "specificDate", date: "2026-01-01" },
      "time: is required",
    ],
    [
      "a date that is not a calendar date",
      { event: "specificDate", date: "2026-02-30", time: "10:00:00" },
      'date: must be a date "YYYY-MM-DD", got "2026-02-30"',
    ],
    [
      "a date in another format",
      { event: "specificDate", date: "1/2/2026", time: "10:00:00" },
      'date: must be a date "YYYY-MM-DD", got "1/2/2026"',
    ],
    [
      "a specific time with a bad minute",
      { event: "specificDate", date: "2026-01-01", time: "10:60" },
      'time: must be a time "HH:MM" or "HH:MM:SS", got "10:60"',
    ],
    [
      "an unknown sun event",
      { event: "sun_event", sun: "noon" },
      'sun: must be one of sunrise, sunset, got "noon"',
    ],
    [
      "a latitude beyond 90",
      { event: "sun_event", latitude: 91 },
      "latitude: must be a number from -90 to 90, got 91",
    ],
    [
      "a longitude below -180",
      { event: "sun_event", longitude: -180.5 },
      "longitude: must be a number from -180 to 180, got -180.5",
    ],
    [
      "an offset beyond 720",
      { event: "sun_event", offset: 721 },
      "offset: must be a number from -720 to 720, got 721",
    ],
    [
      "a negative connect delay",
      { event: "client_connect", delay: -1 },
      "delay: must be an integer of at least 0, got -1",
    ],
    [
      "a field on an event without options",
      { event: "button_press", delay: 1 },
      "delay: unknown field",
    ],
    [
      "a non-boolean enabled",
      { event: "button_release", enabled: "no" },
      "enabled: must be true or false",
    ],
    [
      "both variable and variableId",
      { event: "variable_changed", variable: "a", variableId: "x:y" },
      "variableId: give either variable or variableId, not both",
    ],
    [
      "neither variable nor variableId",
      { event: "variable_changed" },
      "variable: is required (or variableId for a variable that is not a custom variable)",
    ],
    [
      "a variableId without a label",
      { event: "variable_changed", variableId: "counter" },
      'variableId: must be "<label>:<name>", got "counter"',
    ],
    [
      "a custom variableId",
      { event: "variable_changed", variableId: "custom:fx_counter" },
      "variableId: is a custom variable; write variable: fx_counter instead",
    ],
    [
      "a condition event on a trigger without conditions",
      { event: "condition_true" },
      "event: condition_true needs at least one condition: without conditions it never fires",
    ],
  ];
  for (const [name, entry, expected] of cases) {
    it(`refuses ${name}`, () => {
      const message = refusal(entry);
      const prefix = "triggers[0].events[0].";
      assert.ok(
        message.startsWith(`${prefix}${expected}`),
        `${message}\n  expected: ${prefix}${expected}`,
      );
    });
  }
});
