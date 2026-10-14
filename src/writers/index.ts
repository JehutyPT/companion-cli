import type { WriterRegistry } from "../core/description.ts";
import { buttonWriter } from "./button.ts";
import { variablesWriter } from "./variables.ts";

/** Writers by description kind. Kinds without an entry are reserved. */
export const writers: WriterRegistry = {
  variables: variablesWriter,
  button: buttonWriter,
};
