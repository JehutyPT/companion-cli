/**
 * ADR 0006, rule 4: the support matrix (src/support-matrix.ts) cannot go
 * stale. It must agree with the writers' tables in both directions, give
 * every Companion item in the reference lists below a row, and match the
 * committed docs/support-matrix.md. The checks are pure functions of their
 * inputs, so each failure mode is also tested with a mutated input.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  type MatrixRow,
  renderSupportMatrix,
  SUPPORT_MATRIX,
  SUPPORT_MATRIX_DOC,
  tagged as taggedFields,
} from "../src/support-matrix.ts";
import { ACTION_KINDS } from "../src/writers/actions.ts";
import {
  ACTION_SETS,
  TOP_LEVEL_FIELDS as BUTTON_FIELDS,
} from "../src/writers/button-control.ts";
import {
  FEEDBACK_FIELDS,
  FEEDBACK_KINDS,
  STYLE_FIELDS,
} from "../src/writers/feedbacks.ts";
import { writers } from "../src/writers/index.ts";
import { FIELDS as PAGE_FIELDS } from "../src/writers/page.ts";
import {
  EVENT_KINDS,
  FIELDS as TRIGGER_FIELDS,
} from "../src/writers/trigger.ts";
import {
  TOP_LEVEL_FIELDS as VARIABLES_FIELDS,
  VARIABLE_FIELDS,
} from "../src/writers/variables.ts";

/*
 * Companion 5.1's own lists, from its bundled main.js source map
 * (/Applications/Companion.app/Contents/Resources/main.js.map, sources under
 * ../companion/lib/ and ../shared-lib/lib/). Every item needs a matrix row,
 * so "not supported" is a statement, never an omission.
 */

/** Resources/EventDefinitions.ts: `EventDefinitions` keys, including the darwin/win32 additions. */
const COMPANION_EVENT_TYPES = [
  "interval",
  "intervalRandom",
  "timeofday",
  "specificDate",
  "sun_event",
  "startup",
  "client_connect",
  "button_press",
  "button_release",
  "condition_true",
  "condition_false",
  "variable_changed",
  "computer_locked",
  "computer_unlocked",
];

/**
 * Controls/ControlTypes/Button/Base.ts `ButtonControlBase.DefaultOptions`
 * (`stepProgression`, `stepExpression`) and the additions in
 * Controls/ControlTypes/Button/Layered.ts's constructor.
 */
const COMPANION_BUTTON_OPTIONS = [
  "stepProgression",
  "stepExpression",
  "rotaryActions",
  "canModifyStyleInApis",
  "notes",
];

/** shared-lib/lib/Model/EntityModel.ts: `EntityModelBase` fields. */
const COMPANION_ENTITY_FIELDS = [
  "id",
  "type",
  "definitionId",
  "connectionId",
  "headline",
  "options",
  "disabled",
  "upgradeIndex",
  "children",
];
/** shared-lib/lib/Model/EntityModel.ts: `ActionEntityModel`'s own fields. */
const COMPANION_ACTION_FIELDS = ["storeResult"];
/** shared-lib/lib/Model/EntityModel.ts: `FeedbackEntityModel`'s own fields. */
const COMPANION_FEEDBACK_FIELDS = [
  "isInverted",
  "variableName",
  "styleOverrides",
];

/** shared-lib/lib/Model/EntityModel.ts: `FeedbackEntitySubType` values. */
const COMPANION_FEEDBACK_SUBTYPES = [
  "boolean",
  "advanced",
  "value",
  "style-override",
];

/**
 * Controls/ControlTypes/**: each control class's `readonly type`, plus the
 * pre-layered `button` type that main.js upgrades at load.
 */
const COMPANION_CONTROL_TYPES = [
  "button-layered",
  "trigger",
  "page",
  "pageup",
  "pagenum",
  "pagedown",
  "button",
  "preset:button",
  "preset-reference",
  "button-reference",
  "expression-variable",
];

interface ReferenceList {
  area: MatrixRow["area"];
  /** How a Companion name appears as a row's item. */
  item: (name: string) => string;
  names: readonly string[];
}

const REFERENCE_LISTS: readonly ReferenceList[] = [
  { area: "event", item: (name) => name, names: COMPANION_EVENT_TYPES },
  {
    area: "button option",
    item: (name) => `options.${name}`,
    names: COMPANION_BUTTON_OPTIONS,
  },
  {
    area: "action",
    item: (name) => `action.${name}`,
    names: [...COMPANION_ENTITY_FIELDS, ...COMPANION_ACTION_FIELDS],
  },
  {
    area: "feedback",
    item: (name) => `feedback.${name}`,
    names: [...COMPANION_ENTITY_FIELDS, ...COMPANION_FEEDBACK_FIELDS],
  },
  {
    area: "feedback",
    item: (name) => `feedbackType = "${name}"`,
    names: COMPANION_FEEDBACK_SUBTYPES,
  },
  {
    area: "control type",
    item: (name) => name,
    names: COMPANION_CONTROL_TYPES,
  },
];

/** The writers' tables and field lists, as exported. */
interface WriterTables {
  kinds: readonly string[];
  actionKinds: Record<string, { fields: readonly string[] }>;
  feedbackKinds: Record<string, { fields: readonly string[] }>;
  eventKinds: Record<string, { fields: readonly string[] }>;
  styleFields: readonly string[];
  feedbackFields: readonly string[];
  buttonFields: readonly string[];
  stepFields: readonly string[];
  pageFields: readonly string[];
  triggerFields: readonly string[];
  variablesFields: readonly string[];
  variableFields: readonly string[];
}

const WRITER_TABLES: WriterTables = {
  kinds: Object.keys(writers),
  actionKinds: ACTION_KINDS,
  feedbackKinds: FEEDBACK_KINDS,
  eventKinds: EVENT_KINDS,
  styleFields: Object.keys(STYLE_FIELDS),
  feedbackFields: FEEDBACK_FIELDS,
  buttonFields: BUTTON_FIELDS,
  stepFields: ACTION_SETS,
  pageFields: PAGE_FIELDS,
  triggerFields: TRIGGER_FIELDS,
  variablesFields: VARIABLES_FIELDS,
  variableFields: VARIABLE_FIELDS,
};

/** Every description field the writers accept, in the matrix's field notation. */
function writerFields(tables: WriterTables): Set<string> {
  const tagged = (
    tag: string,
    kinds: Record<string, { fields: readonly string[] }>,
  ) =>
    Object.entries(kinds).flatMap(([kind, { fields }]) =>
      taggedFields(tag, kind, fields),
    );
  const under = (prefix: string, fields: readonly string[]) =>
    fields.map((field) => `${prefix}.${field}`);
  return new Set([
    ...tables.kinds.map((kind) => `kind: ${kind}`),
    ...under("button", tables.buttonFields),
    ...under("steps[]", tables.stepFields),
    ...under("page", tables.pageFields),
    ...under("trigger", tables.triggerFields),
    ...under("variables", tables.variablesFields),
    ...under("variables[]", tables.variableFields),
    ...tagged("action", tables.actionKinds),
    ...tagged("feedback", tables.feedbackKinds),
    ...under("feedback", tables.feedbackFields),
    ...under("feedback.style", tables.styleFields),
    ...tagged("event", tables.eventKinds),
  ]);
}

/** Disagreements between the matrix, the writers and Companion's lists. */
function matrixProblems(
  rows: readonly MatrixRow[],
  tables: WriterTables,
  references: readonly ReferenceList[],
): string[] {
  const problems: string[] = [];
  const fromWriters = writerFields(tables);
  const supported = new Set(
    rows.flatMap((row) => (row.status === "supported" ? row.field : [])),
  );
  for (const field of fromWriters) {
    if (!supported.has(field))
      problems.push(`writer field ${field} has no supported row`);
  }
  for (const field of supported) {
    if (!fromWriters.has(field))
      problems.push(`supported field ${field} is not in any writer table`);
  }
  for (const { area, item, names } of references) {
    for (const name of names) {
      const expected = item(name);
      const covered = rows.some(
        (row) =>
          row.area === area &&
          (row.item === expected || row.item.startsWith(`${expected} `)),
      );
      if (!covered) problems.push(`${area} ${expected} has no row`);
    }
  }
  return problems;
}

const committedDoc = () => readFileSync(SUPPORT_MATRIX_DOC, "utf8");

/** The committed doc is the generated one. */
function docProblems(rows: readonly MatrixRow[], doc: string): string[] {
  return doc === renderSupportMatrix(rows)
    ? []
    : [
        "docs/support-matrix.md differs from src/support-matrix.ts; run npm run gen:support-matrix",
      ];
}

describe("support matrix", () => {
  it("agrees with the writers and Companion's lists", () => {
    assert.deepEqual(
      matrixProblems(SUPPORT_MATRIX, WRITER_TABLES, REFERENCE_LISTS),
      [],
    );
  });

  it("matches the committed docs/support-matrix.md", () => {
    assert.deepEqual(docProblems(SUPPORT_MATRIX, committedDoc()), []);
  });

  it("states a ticket for every planned row and a field for no unsupported row", () => {
    for (const row of SUPPORT_MATRIX) {
      if (row.status === "planned")
        assert.match(row.ticket ?? "", /^#\d+$/, row.item);
      else assert.equal(row.ticket, undefined, row.item);
      if (row.status !== "supported") assert.deepEqual(row.field, [], row.item);
    }
  });

  describe("fails when", () => {
    it("a kind is added to ACTION_KINDS without a matrix row", () => {
      const tables = {
        ...WRITER_TABLES,
        actionKinds: { ...ACTION_KINDS, toggle: { fields: ["variable"] } },
      };
      assert.deepEqual(
        matrixProblems(SUPPORT_MATRIX, tables, REFERENCE_LISTS),
        [
          "writer field action: toggle has no supported row",
          "writer field action: toggle.variable has no supported row",
        ],
      );
    });

    it("a supported row names a field no writer has", () => {
      const rows: MatrixRow[] = [
        ...SUPPORT_MATRIX,
        {
          area: "button",
          item: "notes",
          status: "supported",
          field: ["button.notes"],
          note: "",
        },
      ];
      assert.deepEqual(matrixProblems(rows, WRITER_TABLES, REFERENCE_LISTS), [
        "supported field button.notes is not in any writer table",
      ]);
    });

    it("a writer field loses its supported row", () => {
      const rows = SUPPORT_MATRIX.map((row) =>
        row.field.includes("trigger.enabled")
          ? { ...row, status: "planned" as const, ticket: "#26", field: [] }
          : row,
      );
      assert.deepEqual(matrixProblems(rows, WRITER_TABLES, REFERENCE_LISTS), [
        "writer field trigger.enabled has no supported row",
      ]);
    });

    it("the doc is edited by hand", () => {
      const edited = committedDoc().replace("| planned", "| supported");
      assert.notEqual(edited, committedDoc());
      assert.equal(docProblems(SUPPORT_MATRIX, edited).length, 1);
    });

    it("a Companion event type is removed from the matrix", () => {
      const rows = SUPPORT_MATRIX.filter(
        (row) => !(row.area === "event" && row.item === "timeofday"),
      );
      assert.deepEqual(matrixProblems(rows, WRITER_TABLES, REFERENCE_LISTS), [
        "event timeofday has no row",
      ]);
    });
  });
});
