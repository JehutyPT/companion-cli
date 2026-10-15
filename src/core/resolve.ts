import type { DatabaseSync } from "node:sqlite";
import type { Env } from "../rest/endpoint.ts";
import type { ConfigFieldsOutcome, Writer } from "./writer.ts";

/**
 * What `apply`, the dry run and `validate` pass to a writer's `resolve`
 * beyond the description: the runtime around the tool.
 */
export interface WriterRuntime {
  /** The environment a description's `{env: NAME}` values come from. Defaults to `process.env`. */
  env?: Env;
  /**
   * Asks the running Companion for a connection's config fields. Called only
   * in live-install mode. Omitted: REST is not configured.
   */
  configFields?: (connectionId: string) => Promise<ConfigFieldsOutcome>;
  /**
   * Asks the running Companion for a surface's config fields. Called only in
   * live-install mode. Omitted: the Companion URL is not configured.
   */
  surfaceConfigFields?: (surfaceId: string) => Promise<ConfigFieldsOutcome>;
}

export interface ResolveInput {
  live: boolean;
  unchecked: boolean;
  runtime: WriterRuntime;
  /** Runs a reader on a read-only snapshot, after the version guard. */
  read: <T>(reader: (db: DatabaseSync) => T) => T;
}

/** Why there are no definitions with `--db`. */
export const NOT_LIVE_REASON =
  "--db names a database the running Companion does not use";

/** The plan after the writer's `resolve` (when it has one), and its warnings. */
export async function resolvePlan(
  writer: Writer,
  plan: unknown,
  { live, unchecked, runtime, read }: ResolveInput,
): Promise<{ plan: unknown; warnings: string[] }> {
  const warnings: string[] = [];
  if (!writer.resolve) return { plan, warnings };
  const resolved = await writer.resolve(plan, {
    live,
    unchecked,
    env: runtime.env ?? process.env,
    read,
    configFields: async (connectionId) => {
      if (!live)
        return {
          available: false,
          reason: NOT_LIVE_REASON,
        };
      if (!runtime.configFields)
        return { available: false, reason: "REST is not configured" };
      return runtime.configFields(connectionId);
    },
    surfaceConfigFields: async (surfaceId) => {
      if (!live) return { available: false, reason: NOT_LIVE_REASON };
      if (!runtime.surfaceConfigFields)
        return {
          available: false,
          reason: "the Companion URL is not configured",
        };
      return runtime.surfaceConfigFields(surfaceId);
    },
    warn: (line) => warnings.push(`warning: ${line}`),
  });
  return { plan: resolved, warnings };
}
