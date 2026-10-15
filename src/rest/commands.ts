import { CliError, errorMessage } from "../core/errors.ts";
import type { ConfigField, ConfigFieldsOutcome } from "../core/writer.ts";
import type { CompanionEndpoint } from "./endpoint.ts";

/**
 * Runtime commands against a running local Companion. Two Companion APIs are
 * involved (see docs/companion-internals.md, "REST API"):
 *
 *  - the HTTP API (`/api/location/...`, `/api/custom-variable/...`): plain-text
 *    responses, no auth check, `403` with an empty body when disabled;
 *  - REST API v2 (`/api/v2/surfaces/v1...`): Bearer auth, JSON responses and
 *    `{"error": {"code", "message"}}` errors.
 *
 * Every request carries the Bearer key. Every failure is a `CliError`.
 */

export const LOCATION_ACTIONS = [
  "press",
  "down",
  "up",
  "rotate-left",
  "rotate-right",
] as const;
export type LocationAction = (typeof LOCATION_ACTIONS)[number];

export interface Location {
  page: number;
  row: number;
  column: number;
}

interface Reply {
  status: number;
  body: string;
}

const HTTP_API_DISABLED =
  "Companion's HTTP API is disabled (enable it in Companion's settings)";

export async function locationAction(
  endpoint: CompanionEndpoint,
  action: LocationAction,
  { page, row, column }: Location,
): Promise<void> {
  const reply = await send(
    endpoint,
    "POST",
    `/api/location/${page}/${row}/${column}/${action}`,
  );
  if (reply.status === 200) return;
  if (reply.status === 204) {
    throw new CliError(
      `no control at page ${page}, row ${row}, column ${column}`,
    );
  }
  throw httpApiError(reply);
}

export async function getVariable(
  endpoint: CompanionEndpoint,
  name: string,
): Promise<string> {
  const reply = await send(endpoint, "GET", variablePath(name));
  if (reply.status === 200) return reply.body;
  throw variableError(reply, name);
}

/** What `readVariableValue` found. */
export type VariableRead =
  | { outcome: "value"; value: string }
  /** Companion answered 404: it has no such custom variable. */
  | { outcome: "missing" }
  /** Companion refused the request: 401, or 403 (its HTTP API is disabled). */
  | { outcome: "unauthorised"; message: string }
  /** No usable answer: refused, timed out, redirected or another status. */
  | { outcome: "not_reachable"; message: string };

/**
 * `getVariable`'s request with a timeout, returning the outcome instead of
 * throwing, for callers that must not fail when Companion does not answer.
 */
export async function readVariableValue(
  endpoint: CompanionEndpoint,
  name: string,
  timeoutMs: number,
): Promise<VariableRead> {
  // `.` and `..` cannot be requested (see `encodeSegment`); Companion refuses
  // them as names, so there is no such variable to read.
  if (name === "." || name === "..") return { outcome: "missing" };
  let reply: Reply;
  try {
    reply = await send(
      endpoint,
      "GET",
      variablePath(name),
      undefined,
      timeoutMs,
    );
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    return { outcome: "not_reachable", message: error.message };
  }
  if (reply.status === 200) return { outcome: "value", value: reply.body };
  if (reply.status === 404) return { outcome: "missing" };
  const { message } = variableError(reply, name);
  return reply.status === 401 || reply.status === 403
    ? { outcome: "unauthorised", message }
    : { outcome: "not_reachable", message };
}

export async function setVariable(
  endpoint: CompanionEndpoint,
  name: string,
  value: string,
  forceString: boolean,
): Promise<void> {
  const reply = await send(
    endpoint,
    "POST",
    variablePath(name),
    variableBody(value, forceString),
  );
  if (reply.status >= 200 && reply.status < 300) return;
  throw variableError(reply, name);
}

/**
 * The JSON body for `variable set`. A finite number, `true` or `false` is sent
 * as that JSON value; anything else (or anything with `--string`) as a JSON
 * string of the argument text.
 */
export function variableBody(value: string, forceString: boolean): string {
  if (!forceString) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = undefined;
    }
    if (
      typeof parsed === "boolean" ||
      (typeof parsed === "number" && Number.isFinite(parsed))
    ) {
      return JSON.stringify(parsed);
    }
  }
  return JSON.stringify(value);
}

/**
 * Whether Companion's web server answers: `GET /api/v2/openapi.json`, served
 * before auth. A 2xx, 401 or 403 (REST API v2 disabled, its default) shows the
 * server is up. Any other status or any request failure is `false`; this
 * never throws.
 */
export async function probeRest(
  endpoint: CompanionEndpoint,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const { status } = await send(
      endpoint,
      "GET",
      "/api/v2/openapi.json",
      undefined,
      timeoutMs,
    );
    return (status >= 200 && status < 300) || status === 401 || status === 403;
  } catch {
    return false;
  }
}

/**
 * A connection's config field definitions: `GET
 * /api/v2/connections/v1/:id/config-fields` (`{"data": [field]}`; 409 when
 * the connection is not running). This is the only connections endpoint the
 * tool requests: the connection itself (`GET`/`PATCH .../:id`) carries
 * secrets. Never throws; any failure is an unavailable outcome with a reason.
 */
export async function readConfigFields(
  endpoint: CompanionEndpoint,
  connectionId: string,
  timeoutMs: number,
): Promise<ConfigFieldsOutcome> {
  let reply: Reply;
  try {
    reply = await send(
      endpoint,
      "GET",
      `/api/v2/connections/v1/${encodeSegment(connectionId)}/config-fields`,
      undefined,
      timeoutMs,
    );
  } catch (error) {
    return { available: false, reason: errorMessage(error) };
  }
  let data: unknown;
  try {
    data = v2Data(reply);
  } catch (error) {
    const reason = errorMessage(error);
    return {
      available: false,
      reason:
        reply.status === 409
          ? `the connection is not running (${reason})`
          : reason,
    };
  }
  if (!Array.isArray(data) || !data.every(isConfigField))
    return { available: false, reason: errorMessage(unexpected(reply)) };
  return { available: true, fields: data };
}

function isConfigField(value: unknown): value is ConfigField {
  return (
    isObject(value) &&
    typeof value["id"] === "string" &&
    typeof value["type"] === "string"
  );
}

export async function listSurfaces(
  endpoint: CompanionEndpoint,
): Promise<string[]> {
  const reply = await send(endpoint, "GET", "/api/v2/surfaces/v1");
  const data = v2Data(reply);
  if (!Array.isArray(data) || !data.every(isSurface)) throw unexpected(reply);
  return data.map(surfaceLine);
}

export async function getSurface(
  endpoint: CompanionEndpoint,
  id: string,
): Promise<string> {
  const reply = await send(
    endpoint,
    "GET",
    `/api/v2/surfaces/v1/${encodeSegment(id)}`,
  );
  const data = v2Data(reply);
  if (!isSurface(data)) throw unexpected(reply);
  return surfaceLine(data);
}

interface Surface {
  id: string;
  isConnected: boolean;
  size: { rows: number; columns: number } | null;
  page: { number: number | null; name: string | null } | null;
}

/** `<id> connected|disconnected <rows>x<columns> page <number> "<name>"`, `-` for nulls. */
function surfaceLine(surface: Surface): string {
  const size = surface.size
    ? `${surface.size.rows}x${surface.size.columns}`
    : "-";
  const page = surface.page
    ? `page ${surface.page.number ?? "-"} ${surface.page.name === null ? "-" : JSON.stringify(surface.page.name)}`
    : "-";
  const state = surface.isConnected ? "connected" : "disconnected";
  return `${surface.id} ${state} ${size} ${page}`;
}

function isSurface(value: unknown): value is Surface {
  if (!isObject(value)) return false;
  const { id, isConnected, size, page } = value;
  return (
    typeof id === "string" &&
    typeof isConnected === "boolean" &&
    (size === null ||
      (isObject(size) &&
        typeof size["rows"] === "number" &&
        typeof size["columns"] === "number")) &&
    (page === null ||
      (isObject(page) &&
        (page["number"] === null || typeof page["number"] === "number") &&
        (page["name"] === null || typeof page["name"] === "string")))
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `data` of a 2xx v2 response, or a `CliError` describing the failure. */
function v2Data(reply: Reply): unknown {
  let json: unknown;
  try {
    json = JSON.parse(reply.body);
  } catch {
    throw unexpected(reply);
  }
  if (reply.status >= 200 && reply.status < 300) {
    if (!isObject(json) || !("data" in json)) throw unexpected(reply);
    return json["data"];
  }
  const error = isObject(json) ? json["error"] : undefined;
  if (
    !isObject(error) ||
    typeof error["code"] !== "string" ||
    typeof error["message"] !== "string"
  ) {
    throw unexpected(reply);
  }
  let text = `Companion REST API error ${reply.status} ${error["code"]}: ${error["message"]}`;
  if (reply.status === 403 && error["code"] === "API_DISABLED") {
    text += " (enable the REST API in Companion's settings)";
  } else if (reply.status === 401) {
    text += " (COMPANION_API_KEY was rejected)";
  }
  throw new CliError(text);
}

function unexpected(reply: Reply): CliError {
  return new CliError(
    `unexpected response from Companion: HTTP ${reply.status}`,
  );
}

function httpApiError(reply: Reply): CliError {
  if (reply.status === 403) return new CliError(HTTP_API_DISABLED);
  return new CliError(
    `Companion returned HTTP ${reply.status}${reason(reply.body)}`,
  );
}

function variableError(reply: Reply, name: string): CliError {
  if (reply.status === 404) {
    return new CliError(`custom variable "${name}" does not exist`);
  }
  if (reply.status === 400) {
    return new CliError(
      `Companion refused the request (HTTP 400)${reason(reply.body)}`,
    );
  }
  return httpApiError(reply);
}

/** `: <first line of body>` when the body has text, for one-line messages. */
function reason(body: string): string {
  const line = body.trim().split("\n")[0]?.trim() ?? "";
  return line ? `: ${line.slice(0, 200)}` : "";
}

function variablePath(name: string): string {
  return `/api/custom-variable/${encodeSegment(name)}/value`;
}

/**
 * Percent-encodes one path segment. Encoding cannot protect `.` and `..`:
 * URL parsing resolves them even as `%2E`, so they would climb out of the
 * request path. The CLI refuses them as names and ids; this is a backstop.
 */
function encodeSegment(text: string): string {
  if (text === "." || text === "..") {
    throw new CliError(`"${text}" cannot be used as a path segment`);
  }
  return encodeURIComponent(text);
}

async function send(
  endpoint: CompanionEndpoint,
  method: "GET" | "POST",
  path: string,
  /** Sent with `Content-Type` exactly `application/json`. */
  jsonBody?: string,
  /** Gives up after `timeoutMs`, reading the body included. None by default. */
  timeoutMs?: number,
): Promise<Reply> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${endpoint.apiKey}`,
  };
  if (jsonBody !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(endpoint.base + path, {
      method,
      headers,
      // A redirect could send the key off the local machine.
      redirect: "error",
      ...(timeoutMs !== undefined
        ? { signal: AbortSignal.timeout(timeoutMs) }
        : {}),
      ...(jsonBody !== undefined ? { body: jsonBody } : {}),
    });
  } catch (error) {
    throw requestError(endpoint, error, timeoutMs);
  }
  try {
    return { status: response.status, body: await response.text() };
  } catch (error) {
    if (timeoutMs !== undefined && isTimeout(error)) {
      throw timeoutError(endpoint, timeoutMs);
    }
    throw new CliError(
      `reading Companion's response failed: ${errorMessage(error)}`,
    );
  }
}

const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "ECONNRESET",
]);

function requestError(
  endpoint: CompanionEndpoint,
  error: unknown,
  timeoutMs: number | undefined,
): CliError {
  if (timeoutMs !== undefined && isTimeout(error)) {
    return timeoutError(endpoint, timeoutMs);
  }
  if (codes(error).some((code) => UNREACHABLE_CODES.has(code))) {
    return new CliError(`Companion is not reachable at ${endpoint.origin}`);
  }
  if (messages(error).some((text) => /redirect/i.test(text))) {
    return new CliError(
      `Companion at ${endpoint.origin} answered with a redirect, which is not followed`,
    );
  }
  return new CliError(
    `request to ${endpoint.origin} failed: ${errorMessage(error)}`,
  );
}

/** `AbortSignal.timeout` fired: fetch rejects with a `TimeoutError`. */
function isTimeout(error: unknown): boolean {
  return chain(error).some((record) => record["name"] === "TimeoutError");
}

function timeoutError(
  endpoint: CompanionEndpoint,
  timeoutMs: number,
): CliError {
  return new CliError(
    `Companion did not answer at ${endpoint.origin} within ${timeoutMs / 1000} s`,
  );
}

/** The `code`s on an error, its `cause` chain and any aggregated errors. */
function codes(error: unknown): string[] {
  return chain(error).flatMap((record) =>
    typeof record["code"] === "string" ? [record["code"]] : [],
  );
}

/** The `message`s on an error and its `cause` chain. */
function messages(error: unknown): string[] {
  return chain(error).flatMap((record) =>
    typeof record["message"] === "string" ? [record["message"]] : [],
  );
}

function chain(error: unknown): Array<Record<string, unknown>> {
  if (!isObject(error) && !(error instanceof Error)) return [];
  const record = error as Record<string, unknown>;
  const nested = [
    record["cause"],
    ...(Array.isArray(record["errors"]) ? record["errors"] : []),
  ];
  return [record, ...nested.flatMap(chain)];
}
