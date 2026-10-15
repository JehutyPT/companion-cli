import type { WriterRegistry } from "../core/description.ts";
import { buttonWriter } from "./button.ts";
import { connectionWriter } from "./connection.ts";
import { pageWriter } from "./page.ts";
import { surfaceWriter } from "./surface.ts";
import { triggersWriter, triggerWriter } from "./trigger.ts";
import { variablesWriter } from "./variables.ts";

/** Writers by description kind. Kinds without an entry are reserved. */
export const writers: WriterRegistry = {
  variables: variablesWriter,
  button: buttonWriter,
  page: pageWriter,
  trigger: triggerWriter,
  triggers: triggersWriter,
  connection: connectionWriter,
  surface: surfaceWriter,
};
