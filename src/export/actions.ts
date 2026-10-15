/**
 * The inverse of src/writers/actions.ts: a stored action to an action entry.
 * Shared by every export that holds action lists (triggers here; buttons and
 * pages with #19). Each stored action takes the first rule that applies:
 *
 *  1. internal `custom_variable_set_value` with options exactly `name` and
 *     `value`, `name` a plain valid variable name: a plain string value is
 *     `set`; `$(this:current) + N` / `- N` is `increment` / `decrement`
 *     (`by` omitted when 1); any other non-empty expression is `expression`;
 *  2. every option `{value, isExpression: false}`: `passthrough`, with
 *     `options` omitted when empty;
 *  3. otherwise refused, naming the expression option.
 *
 * The mapping is not trusted: the caller's self-check rebuilds the action
 * with the writer's code and refuses any difference (an extra key such as
 * `disabled`, for example).
 */
import { CliError } from "../core/errors.ts";
import { type Fields, isJsonObject } from "../core/validate.ts";
import { parseVariableName } from "../writers/shared.ts";
import { describeStored, refuse } from "./export.ts";

/** What apply's `increment` and `decrement` store, with N a safe positive integer. */
const STEP = /^\$\(this:current\) ([+-]) ([1-9]\d{0,14})$/;

interface StoredOption {
  value: unknown;
  isExpression: boolean;
}

/** A wrapped option exactly as the writers store one. */
function isOption(value: unknown): value is StoredOption {
  return (
    isJsonObject(value) &&
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, "value") &&
    typeof value["isExpression"] === "boolean"
  );
}

function isVariableName(value: unknown): value is string {
  try {
    parseVariableName(value, "");
    return true;
  } catch (error) {
    if (error instanceof CliError) return false;
    throw error;
  }
}

/** Rule 1, when it applies. */
function variableAction(stored: Fields, options: Fields): Fields | undefined {
  if (
    stored["connectionId"] !== "internal" ||
    stored["definitionId"] !== "custom_variable_set_value"
  )
    return undefined;
  const keys = Object.keys(options).sort();
  if (keys.length !== 2 || keys[0] !== "name" || keys[1] !== "value")
    return undefined;
  const { name, value } = options;
  if (!isOption(name) || name.isExpression || !isVariableName(name.value))
    return undefined;
  if (!isOption(value) || typeof value.value !== "string") return undefined;
  const variable = name.value;
  if (!value.isExpression)
    return { action: "set", variable, value: value.value };
  const step = STEP.exec(value.value);
  if (step) {
    const by = Number(step[2]);
    return {
      action: step[1] === "+" ? "increment" : "decrement",
      variable,
      ...(by === 1 ? {} : { by }),
    };
  }
  if (value.value === "") return undefined;
  return { action: "expression", variable, expression: value.value };
}

/** One stored action at `path` (`actions[2]`) as an action entry. */
export function exportAction(stored: unknown, path: string): Fields {
  if (!isJsonObject(stored))
    refuse(path, `is ${describeStored(stored)}, not an action`, "action");
  const options = stored["options"];
  if (!isJsonObject(options))
    refuse(
      `${path}.options`,
      `is ${describeStored(options)}, not a mapping`,
      "action",
    );
  const named = variableAction(stored, options);
  if (named) return named;

  const { connectionId, definitionId } = stored;
  if (typeof connectionId !== "string" || connectionId === "")
    refuse(`${path}.connectionId`, "is not a connection id", "action");
  if (typeof definitionId !== "string" || definitionId === "")
    refuse(`${path}.definitionId`, "is not a definition id", "action");
  const plain: Fields = {};
  for (const [key, option] of Object.entries(options)) {
    const optionPath = `${path}.options.${key}`;
    if (!isOption(option))
      refuse(optionPath, "is not a {value, isExpression} option", "action");
    if (option.isExpression)
      refuse(
        optionPath,
        "is an expression, which the description format supports only in set, expression, increment and decrement actions",
        "action",
      );
    plain[key] = option.value;
  }
  return {
    action: "passthrough",
    connection: connectionId,
    definition: definitionId,
    ...(Object.keys(plain).length > 0 ? { options: plain } : {}),
  };
}
