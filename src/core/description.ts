import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import {
  CliError,
  errorCode,
  errorMessage,
  ValidationError,
} from "./errors.ts";
import { expectMapping, expectString } from "./validate.ts";
import {
  DESCRIPTION_KINDS,
  type DescriptionKind,
  type Writer,
} from "./writer.ts";

/**
 * A description file is a YAML mapping with a `kind` that selects the writer.
 * The remaining top-level fields belong to that writer, which rejects any it
 * does not know:
 *
 *   kind: variables
 *   variables:
 *     - name: sk_presses
 *       default: 0
 */

export type WriterRegistry = Partial<Record<DescriptionKind, Writer>>;

export interface LoadedDescription {
  writer: Writer;
  plan: unknown;
}

export function readDescriptionFile(filePath: string): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new CliError(
      `cannot read description file ${filePath}: ${errorCode(error)}`,
    );
  }
  const doc = parseDocument(text, { uniqueKeys: true });
  const [first] = doc.errors;
  if (first) {
    throw new CliError(`invalid YAML in ${filePath}: ${errorMessage(first)}`);
  }
  return doc.toJS();
}

/** Validates the envelope and the writer-specific body. Touches no database. */
export function parseDescription(
  raw: unknown,
  writers: WriterRegistry,
): LoadedDescription {
  const fields = expectMapping(raw, "(top level)");
  if (!Object.hasOwn(fields, "kind")) {
    throw new ValidationError(
      "kind",
      `is required (one of: ${DESCRIPTION_KINDS.join(", ")})`,
    );
  }
  const kind = expectString(fields["kind"], "kind");
  if (!isDescriptionKind(kind)) {
    throw new ValidationError(
      "kind",
      `unknown kind "${kind}" (expected one of: ${DESCRIPTION_KINDS.join(", ")})`,
    );
  }
  const writer = writers[kind];
  if (!writer) {
    throw new ValidationError(
      "kind",
      `kind "${kind}" is reserved and not supported yet`,
    );
  }
  const { kind: _kind, ...body } = fields;
  return { writer, plan: writer.parse(body) };
}

export function loadDescription(
  filePath: string,
  writers: WriterRegistry,
): LoadedDescription {
  const raw = readDescriptionFile(filePath);
  try {
    return parseDescription(raw, writers);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new CliError(`invalid description ${filePath}: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

function isDescriptionKind(kind: string): kind is DescriptionKind {
  return (DESCRIPTION_KINDS as readonly string[]).includes(kind);
}
