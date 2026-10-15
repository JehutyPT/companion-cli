import type { ListCommand } from "../readers/list.ts";
import { exportCommand, type Exporter } from "./export.ts";
import { triggerExporter, triggersExporter } from "./triggers.ts";
import { variablesExporter } from "./variables.ts";

interface ExportEntry {
  kind: string;
  synopsis: string;
  command: ListCommand;
}

function entry<Item>(exporter: Exporter<Item>): ExportEntry {
  return {
    kind: exporter.kind,
    synopsis: `export ${exporter.kind} ${exporter.arguments} [--db <path-to-db.sqlite>] [--json]`,
    command: exportCommand(exporter),
  };
}

/**
 * Every export, in the order usage and help name them. Adding an export
 * means adding an `Exporter` (src/export/export.ts) here; its command and
 * usage line follow from it.
 */
const EXPORTS: readonly ExportEntry[] = [
  entry(variablesExporter),
  entry(triggerExporter),
  entry(triggersExporter),
];

/** `export` commands by kind. */
export const exportCommands: Readonly<Record<string, ListCommand>> =
  Object.fromEntries(EXPORTS.map(({ kind, command }) => [kind, command]));

/** One usage line per export kind. */
export const EXPORT_SYNOPSES: readonly string[] = EXPORTS.map(
  ({ synopsis }) => synopsis,
);
