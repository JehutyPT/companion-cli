/**
 * `schema --connection <label>` (#22): one connection's module action and
 * feedback definitions, which exist only in the running Companion. They are
 * read over the tRPC socket after a version gate on the installed app's
 * `Resources/BUILD`. See docs/companion-internals.md, "Module definitions".
 *
 * Nothing from a connection's `config` or `secrets` is printed: Companion's
 * connections payload does not carry them, and every output field is
 * allow-listed here regardless.
 */
import { readFileSync } from "node:fs";
import { CheckError, CliError, errorCode } from "./core/errors.ts";
import { isJsonObject } from "./core/validate.ts";
import { INTERNAL_CONNECTION } from "./readers/connections-use.ts";
import {
  type ConfigDirs,
  type Env,
  loadCompanionUrl,
} from "./rest/endpoint.ts";
import { OTHER_COMPANION_HINT, TrpcSubscriber } from "./rest/trpc-socket.ts";

/** The one Companion build whose private socket API this command knows. */
export const SUPPORTED_BUILD = "5.1.0+9981-stable-257b325d09";

/** Where the installed Companion app keeps its build string. */
export const DEFAULT_BUILD_FILE =
  "/Applications/Companion.app/Contents/Resources/BUILD";

/** Each wait on the socket, in ms. */
export const SOCKET_TIMEOUT_MS = 5000;

const CONNECTIONS_PATH = "instances.connections.watch";
const ACTIONS_PATH = "instances.definitions.actions";
const FEEDBACKS_PATH = "instances.definitions.feedbacks";

export interface DefinitionOption {
  id: string;
  type: string;
  label: string;
  default?: unknown;
  choices?: { id: unknown; label: string }[];
  min?: number;
  max?: number;
}

export interface Definition {
  id: string;
  label: string;
  description?: string;
  /** Feedbacks only: `boolean`, `advanced`, …, or null. */
  feedbackType?: string | null;
  options: DefinitionOption[];
}

export interface ConnectionSchema {
  connection: {
    id: string;
    label: string;
    moduleId: string | null;
    moduleVersionId: string | null;
  };
  build: string;
  actions: Definition[];
  feedbacks: Definition[];
}

export interface ConnectionSchemaOptions {
  env: Env;
  dirs: ConfigDirs;
  /** Defaults to `DEFAULT_BUILD_FILE`. */
  buildFile?: string | undefined;
  /** Defaults to `SOCKET_TIMEOUT_MS`. */
  timeoutMs?: number | undefined;
}

/**
 * Reads the definitions of the connection labelled `label` (`internal` for
 * Companion's built-in entities). It checks `COMPANION_URL` and the installed
 * build before any network call.
 */
export async function connectionSchema(
  label: string,
  options: ConnectionSchemaOptions,
): Promise<ConnectionSchema> {
  const url = loadCompanionUrl(options.env, options.dirs);
  const build = checkBuild(options.buildFile ?? DEFAULT_BUILD_FILE);
  const socketUrl = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/trpc`;
  const socket = await TrpcSubscriber.connect(
    socketUrl,
    options.timeoutMs ?? SOCKET_TIMEOUT_MS,
  );
  try {
    const connection = resolveLabel(
      label,
      connectionsInfo(await socket.first(CONNECTIONS_PATH)),
    );
    const [actions, feedbacks] = await Promise.all([
      socket.first(ACTIONS_PATH),
      socket.first(FEEDBACKS_PATH),
    ]);
    return {
      connection,
      build,
      actions: definitionsOf(actions, connection.id, false),
      feedbacks: definitionsOf(feedbacks, connection.id, true),
    };
  } finally {
    await socket.close();
  }
}

/**
 * The trimmed build string, which must be `SUPPORTED_BUILD`. `reader` names
 * what reads the private API, for the refusal.
 */
export function checkBuild(
  path: string,
  reader = "schema --connection",
): string {
  let build: string;
  try {
    build = readFileSync(path, "utf8").trim();
  } catch (error) {
    throw new CliError(
      `cannot read Companion's build from ${path}: ${errorCode(error)}`,
      {
        code: "companion_build_unknown",
        hint: "this command needs Companion 5.1 installed in /Applications",
      },
    );
  }
  if (build !== SUPPORTED_BUILD) {
    throw new CliError(
      `Companion build ${JSON.stringify(build)} is not supported: ${reader} reads a private API and needs ${SUPPORTED_BUILD}`,
      {
        code: "unsupported_companion_build",
        hint: `this command supports Companion ${SUPPORTED_BUILD} only`,
      },
    );
  }
  return build;
}

/** The `info` map of `instances.connections.watch`'s `init` payload. */
function connectionsInfo(payload: unknown): Record<string, unknown> {
  const init = Array.isArray(payload)
    ? payload.find(
        (change) => isJsonObject(change) && change["type"] === "init",
      )
    : undefined;
  if (!isJsonObject(init) || !isJsonObject(init["info"])) {
    throw unexpectedPayload(CONNECTIONS_PATH);
  }
  return init["info"];
}

function resolveLabel(
  label: string,
  info: Record<string, unknown>,
): ConnectionSchema["connection"] {
  if (label === INTERNAL_CONNECTION) {
    return {
      id: INTERNAL_CONNECTION,
      label,
      moduleId: null,
      moduleVersionId: null,
    };
  }
  const matches = Object.entries(info)
    .filter(
      ([, value]) =>
        isJsonObject(value) &&
        value["moduleType"] === "connection" &&
        value["label"] === label,
    )
    .map(([id, value]) => {
      const { moduleId, moduleVersionId } = value as Record<string, unknown>;
      return {
        id,
        label,
        moduleId: typeof moduleId === "string" ? moduleId : null,
        moduleVersionId:
          typeof moduleVersionId === "string" ? moduleVersionId : null,
      };
    });
  if (matches.length === 0) {
    throw new CliError(
      `Companion has no connection labelled ${JSON.stringify(label)}`,
      {
        code: "not_found",
        hint: "run companion-cli list connections",
      },
    );
  }
  if (matches.length > 1) {
    throw new CheckError(
      "",
      `${matches.length} connections labelled ${JSON.stringify(label)} (${matches
        .map((match) => match.id)
        .sort()
        .join(", ")}); refusing to choose one`,
    );
  }
  return matches[0] as ConnectionSchema["connection"];
}

/** The connection's definitions from a definitions `init` payload, by id. */
function definitionsOf(
  payload: unknown,
  connectionId: string,
  feedback: boolean,
): Definition[] {
  const path = feedback ? FEEDBACKS_PATH : ACTIONS_PATH;
  if (
    !isJsonObject(payload) ||
    payload["type"] !== "init" ||
    !isJsonObject(payload["definitions"])
  ) {
    throw unexpectedPayload(path);
  }
  const entry = payload["definitions"][connectionId];
  if (!isJsonObject(entry)) return [];
  return Object.keys(entry)
    .sort()
    .map((id) => definition(id, entry[id], feedback));
}

/** The allow-listed fields of one `ClientEntityDefinition`. */
function definition(id: string, value: unknown, feedback: boolean): Definition {
  const source = isJsonObject(value) ? value : {};
  const result: Definition = {
    id,
    label: stringOr(source["label"], id),
    options: [],
  };
  if (typeof source["description"] === "string")
    result.description = source["description"];
  if (feedback) {
    result.feedbackType =
      typeof source["feedbackType"] === "string"
        ? source["feedbackType"]
        : null;
  }
  const options = Array.isArray(source["options"]) ? source["options"] : [];
  result.options = options.filter(isJsonObject).map(option);
  return result;
}

function option(source: Record<string, unknown>): DefinitionOption {
  const result: DefinitionOption = {
    id: stringOr(source["id"], ""),
    type: stringOr(source["type"], ""),
    label: stringOr(source["label"], ""),
  };
  if (Object.hasOwn(source, "default")) result.default = source["default"];
  if (Array.isArray(source["choices"])) {
    result.choices = source["choices"].filter(isJsonObject).map((choice) => ({
      id: choice["id"],
      label: stringOr(choice["label"], ""),
    }));
  }
  if (typeof source["min"] === "number") result.min = source["min"];
  if (typeof source["max"] === "number") result.max = source["max"];
  return result;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function unexpectedPayload(path: string): CliError {
  return new CliError(`Companion's ${path} payload has an unexpected shape`, {
    code: "unsupported_companion_build",
    hint: OTHER_COMPANION_HINT,
  });
}

/** Choice ids shown per option before `…`. */
const SHOWN_CHOICES = 5;

/** The text listing: a header, one line per definition, pass-through hints. */
export function renderConnectionSchema(schema: ConnectionSchema): string[] {
  const { connection } = schema;
  const module =
    connection.moduleId === null
      ? "built-in"
      : [connection.moduleId, connection.moduleVersionId]
          .filter((part) => part !== null)
          .join(" ");
  return [
    `connection ${JSON.stringify(connection.label)} (${module}, id ${connection.id})`,
    ...section("actions", schema.actions),
    ...section("feedbacks", schema.feedbacks),
    `use: {action: passthrough, connection: ${connection.id}, definition: <id>, options: {…}}`,
    `use: {feedback: passthrough, connection: ${connection.id}, definition: <id>, options: {…}}`,
  ];
}

function section(name: string, definitions: readonly Definition[]): string[] {
  const width = Math.max(0, ...definitions.map((item) => item.id.length));
  return [
    `${name} (${definitions.length}):`,
    ...definitions.map((item) => {
      const kind = item.feedbackType ? `${item.feedbackType} ` : "";
      const options = item.options.length
        ? item.options.map(renderOption).join(", ")
        : "-";
      return `  ${item.id.padEnd(width)}  ${kind}${JSON.stringify(item.label)}  options: ${options}`;
    }),
  ];
}

/** `<id> <type>=<default> [choice ids] (min..max)`. */
function renderOption(item: DefinitionOption): string {
  let text = `${item.id} ${item.type}`;
  if (item.default !== undefined) text += `=${renderValue(item.default)}`;
  if (item.choices?.length) {
    const ids = item.choices
      .slice(0, SHOWN_CHOICES)
      .map((choice) => renderValue(choice.id));
    if (item.choices.length > SHOWN_CHOICES) ids.push("…");
    text += ` [${ids.join(",")}]`;
  }
  if (item.min !== undefined || item.max !== undefined) {
    text += ` (${item.min ?? ""}..${item.max ?? ""})`;
  }
  return text;
}

/** A plain word as itself, anything else as JSON. */
function renderValue(value: unknown): string {
  return typeof value === "string" && /^[^\s,[\]()"=]+$/.test(value)
    ? value
    : JSON.stringify(value);
}

/** The `--json` document. */
export function connectionSchemaJson(schema: ConnectionSchema): string {
  return JSON.stringify(schema);
}
