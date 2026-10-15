/**
 * A surface's config field definitions (#32), which exist only in the
 * running Companion, and only while the surface is connected. They are read
 * over the tRPC socket (`surfaces.watchSurfaces`) after the version gate on
 * the installed Companion's `BUILD` file, as `schema --connection` reads its
 * definitions. See docs/companion-internals.md, "Surfaces".
 *
 * Only `id`, `type` and the keys the check needs are kept from a field;
 * nothing from a surface's stored config is read here.
 */
import {
  type BuildFile,
  buildFilePath,
  checkBuild,
  SOCKET_TIMEOUT_MS,
} from "./connection-schema.ts";
import { errorMessage } from "./core/errors.ts";
import { isJsonObject } from "./core/validate.ts";
import type { ConfigField, ConfigFieldsOutcome } from "./core/writer.ts";
import {
  type ConfigDirs,
  type Env,
  loadCompanionUrl,
} from "./rest/endpoint.ts";
import { TrpcSubscriber } from "./rest/trpc-socket.ts";

const SURFACES_PATH = "surfaces.watchSurfaces";

export interface SurfaceDefinitionsOptions {
  env: Env;
  dirs: ConfigDirs;
  /** A path, or a lookup run when the check is reached (the CLI's on Windows). Defaults to `DEFAULT_BUILD_FILE`. */
  buildFile?: BuildFile | undefined;
  /** Defaults to `SOCKET_TIMEOUT_MS`. */
  timeoutMs?: number | undefined;
}

/** The keys of a config field the definition check reads. */
const CHECKED_FIELD_KEYS = [
  "id",
  "type",
  "min",
  "max",
  "choices",
  "allowCustom",
  "regex",
  "minLength",
  "minSelection",
  "maxSelection",
];

/**
 * The config fields of the surface `surfaceId`. Never throws: an unset URL,
 * another build, an unreachable Companion, an unexpected payload, an unknown
 * or a disconnected surface are each an unavailable outcome with the reason.
 */
export async function surfaceConfigFields(
  surfaceId: string,
  options: SurfaceDefinitionsOptions,
): Promise<ConfigFieldsOutcome> {
  try {
    const url = loadCompanionUrl(options.env, options.dirs);
    checkBuild(await buildFilePath(options.buildFile), "kind: surface");
    const socketUrl = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/trpc`;
    const socket = await TrpcSubscriber.connect(
      socketUrl,
      options.timeoutMs ?? SOCKET_TIMEOUT_MS,
    );
    let payload: unknown;
    try {
      payload = await socket.first(SURFACES_PATH);
    } finally {
      await socket.close();
    }
    return fieldsOf(payload, surfaceId);
  } catch (error) {
    return { available: false, reason: errorMessage(error) };
  }
}

/** The surface's fields in a `surfaces.watchSurfaces` payload. */
export function fieldsOf(
  payload: unknown,
  surfaceId: string,
): ConfigFieldsOutcome {
  const unexpected = {
    available: false,
    reason: `Companion's ${SURFACES_PATH} payload is not the expected shape`,
  } as const;
  const init = Array.isArray(payload)
    ? payload.find(
        (change) => isJsonObject(change) && change["type"] === "init",
      )
    : undefined;
  const info = isJsonObject(init) ? init["info"] : undefined;
  if (!isJsonObject(info)) return unexpected;
  for (const group of Object.values(info)) {
    if (!isJsonObject(group) || !Array.isArray(group["surfaces"]))
      return unexpected;
    for (const surface of group["surfaces"]) {
      if (!isJsonObject(surface) || surface["id"] !== surfaceId) continue;
      if (surface["isConnected"] !== true)
        return {
          available: false,
          reason: `surface "${surfaceId}" is not connected`,
        };
      const fields = surface["configFields"];
      if (!Array.isArray(fields) || !fields.every(isConfigField))
        return unexpected;
      return {
        available: true,
        fields: fields.map(
          (item) =>
            Object.fromEntries(
              CHECKED_FIELD_KEYS.filter((key) => Object.hasOwn(item, key)).map(
                (key) => [key, item[key]],
              ),
            ) as ConfigField,
        ),
      };
    }
  }
  return {
    available: false,
    reason: `the running Companion does not know surface "${surfaceId}"`,
  };
}

function isConfigField(value: unknown): value is ConfigField {
  return (
    isJsonObject(value) &&
    typeof value["id"] === "string" &&
    typeof value["type"] === "string"
  );
}
