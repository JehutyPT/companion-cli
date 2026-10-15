/**
 * The schema-versus-parser check: a description is accepted by the generated
 * JSON Schema exactly when the writers' parsers accept it. Tests that produce
 * description files (examples, exports) run them through `agreement`.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseDescription } from "../src/core/description.ts";
import { ValidationError } from "../src/core/errors.ts";
import { descriptionSchema } from "../src/schema.ts";
import { writers } from "../src/writers/index.ts";

/** A strict validator: unknown keywords and ambiguous schemas are errors. */
export function newAjv(): Ajv2020 {
  return new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
}

const validate = newAjv().compile(descriptionSchema());

export function schemaAccepts(raw: unknown): boolean {
  return validate(raw);
}

/** Whether the writers' parsers accept `raw`; any other failure is rethrown. */
export function parserAccepts(raw: unknown): boolean {
  try {
    parseDescription(raw, writers);
    return true;
  } catch (error) {
    if (error instanceof ValidationError) return false;
    throw error;
  }
}

/** Both verdicts, for one `deepEqual` per description. */
export function agreement(raw: unknown): { schema: boolean; parser: boolean } {
  return { schema: schemaAccepts(raw), parser: parserAccepts(raw) };
}
