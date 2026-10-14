import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { CliError, errorCode } from "../core/errors.ts";

/** Where the REST commands find Companion, and the key they send. */
export interface CompanionEndpoint {
  /** Origin plus any path prefix, without a trailing slash. */
  base: string;
  /** The URL's origin, for messages. */
  origin: string;
  apiKey: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

export const ENV_FILE = ".env.local";

/** Hostnames (in `URL.hostname` form) that count as the local machine. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Reads `COMPANION_URL` and `COMPANION_API_KEY` from `.env.local` in `cwd`,
 * with variables set in `env` taking precedence. Both are required, and the
 * URL must be an http(s) URL on the local machine.
 */
export function loadEndpoint(env: Env, cwd: string): CompanionEndpoint {
  const file = readEnvFile(join(cwd, ENV_FILE));
  const value = (name: string): string => {
    const text = env[name] ?? file[name];
    if (!text) {
      throw new CliError(
        `${name} is not set: set it in ${ENV_FILE} or the environment`,
      );
    }
    return text;
  };
  const rawUrl = value("COMPANION_URL");
  const apiKey = value("COMPANION_API_KEY");

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CliError(`COMPANION_URL "${rawUrl}" is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError(
      `COMPANION_URL must be an http: or https: URL, not ${url.protocol}`,
    );
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new CliError(
      `COMPANION_URL host "${url.hostname}" is not local: only a local Companion is allowed (localhost, 127.0.0.1 or [::1])`,
    );
  }
  return {
    base: url.origin + url.pathname.replace(/\/+$/, ""),
    origin: url.origin,
    apiKey,
  };
}

/**
 * The API key as configured, unvalidated, for redacting it from output.
 * Never throws.
 */
export function configuredApiKey(env: Env, cwd: string): string | undefined {
  if (env["COMPANION_API_KEY"] !== undefined) return env["COMPANION_API_KEY"];
  try {
    return readEnvFile(join(cwd, ENV_FILE))["COMPANION_API_KEY"];
  } catch {
    return undefined;
  }
}

function readEnvFile(path: string): Record<string, string | undefined> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    throw new CliError(`cannot read ${ENV_FILE}: ${errorCode(error)}`);
  }
  return parseEnv(text);
}
