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

/** Where the REST commands look for `ENV_FILE`. */
export interface ConfigDirs {
  /** The working directory. */
  cwd: string;
  /** The user's home directory, for the default user config file. */
  homedir: string;
}

/**
 * The user config file: `$XDG_CONFIG_HOME/companion-cli/.env.local` when
 * `XDG_CONFIG_HOME` is set and non-empty in `env`, otherwise
 * `~/.config/companion-cli/.env.local`.
 */
export function userEnvFile(env: Env, homedir: string): string {
  const configHome = env["XDG_CONFIG_HOME"] || join(homedir, ".config");
  return join(configHome, "companion-cli", ENV_FILE);
}

/**
 * Reads `COMPANION_URL` and `COMPANION_API_KEY`, each from `env` first, then
 * from the first env file that exists: `.env.local` in `cwd`, else the user
 * config file (see `userEnvFile`). Files are not merged. Both are required,
 * and the URL must be an http(s) URL on the local machine.
 */
export function loadEndpoint(env: Env, dirs: ConfigDirs): CompanionEndpoint {
  const file = readEnvFiles(env, dirs);
  const value = (name: string): string => {
    const text = env[name] ?? file[name];
    if (!text) {
      throw new CliError(
        `${name} is not set: set it in ${ENV_FILE}, ${userEnvFile(env, dirs.homedir)} or the environment`,
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
export function configuredApiKey(
  env: Env,
  dirs: ConfigDirs,
): string | undefined {
  if (env["COMPANION_API_KEY"] !== undefined) return env["COMPANION_API_KEY"];
  try {
    return readEnvFiles(env, dirs)["COMPANION_API_KEY"];
  } catch {
    return undefined;
  }
}

/** The first of the working directory's and the user's env file that exists. */
function readEnvFiles(
  env: Env,
  dirs: ConfigDirs,
): Record<string, string | undefined> {
  return (
    readEnvFile(join(dirs.cwd, ENV_FILE)) ??
    readEnvFile(userEnvFile(env, dirs.homedir)) ??
    {}
  );
}

/** The file's variables, or `undefined` if it does not exist. */
function readEnvFile(
  path: string,
): Record<string, string | undefined> | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new CliError(`cannot read ${path}: ${errorCode(error)}`);
  }
  return parseEnv(text);
}
