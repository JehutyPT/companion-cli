import { listCommand, type ListCommand } from "./list.ts";
import { triggersLister } from "./triggers.ts";
import { variablesLister } from "./variables.ts";

/** `list` commands by kind, in the order usage and help name them. */
export const listCommands: Readonly<Record<string, ListCommand>> = {
  variables: listCommand(variablesLister),
  triggers: listCommand(triggersLister),
};
