import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join, resolve, win32 } from "node:path";
import type { Env } from "../rest/endpoint.ts";
import { CliError } from "./errors.ts";
import type { CompanionServer } from "./process.ts";

/** What the resolver reads of a running Companion server: its command line. */
export type ServerCommandLine = Pick<CompanionServer, "pid" | "commandLine">;

/**
 * What locates the Companion install's database: the home directory, the
 * platform, the environment (`APPDATA` on Windows, `COMPANION_CONFIG_BASEDIR`)
 * and the running Companion servers.
 */
export interface InstallContext {
  homedir: string;
  platform: NodeJS.Platform;
  env: Env;
  /**
   * The running Companion servers, listed up front through the process
   * control (the resolver is synchronous); empty when none runs. Needed to
   * resolve the install's database without `--db`: when it is left out the
   * resolver throws, rather than fall back to the environment or the default
   * while a server may run on another folder.
   */
  servers?: readonly ServerCommandLine[] | undefined;
}

/** The install context from command options, defaulting to this process's. */
export function installContext(options: {
  homedir?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  env?: Env | undefined;
  servers?: readonly ServerCommandLine[] | undefined;
}): InstallContext {
  return {
    homedir: options.homedir ?? osHomedir(),
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    servers: options.servers,
  };
}

/** The environment variable Companion's launcher reads for the root. */
export const CONFIG_BASEDIR_VARIABLE = "COMPANION_CONFIG_BASEDIR";

/** Which rule chose the install's configuration root. */
export type RootSource = "server" | "environment" | "default";

/** The install's configuration root and the rule that chose it. */
export interface ConfigRoot {
  root: string;
  source: RootSource;
}

/** How messages name each rule. */
export function describeRootSource(source: RootSource): string {
  switch (source) {
    case "server":
      return "the running Companion's --config-dir";
    case "environment":
      return CONFIG_BASEDIR_VARIABLE;
    case "default":
      return "the default configuration folder";
  }
}

/**
 * The Companion 5.1 install's database on macOS, relative to the home
 * directory (host path rules).
 */
export const DEFAULT_DATABASE_RELATIVE_PATH = join(
  "Library",
  "Application Support",
  "companion",
  "v5.1",
  "db.sqlite",
);

/**
 * The platform's default configuration root, the folder Companion's launcher
 * passes to the server as `--config-dir` when nothing overrides it:
 *
 * - macOS: `~/Library/Application Support/companion`, with host path rules;
 * - Windows: `<APPDATA>\companion`, with `APPDATA` falling back to
 *   `<home>\AppData\Roaming` when unset or empty (Electron's `appData`),
 *   with Windows path rules on any host.
 *
 * Any other platform is refused. This is the last rule of
 * `resolveConfigRoot`: the running server's `--config-dir` and
 * `COMPANION_CONFIG_BASEDIR` come before it.
 */
export function defaultConfigRoot(install: InstallContext): string {
  switch (install.platform) {
    case "darwin":
      return join(
        install.homedir,
        "Library",
        "Application Support",
        "companion",
      );
    case "win32": {
      const appData =
        install.env["APPDATA"] ||
        win32.join(install.homedir, "AppData", "Roaming");
      return win32.join(appData, "companion");
    }
    default:
      throw new CliError(
        `unsupported platform "${install.platform}": the local install is found on macOS and Windows only; pass --db with a database path`,
        { code: "unsupported_platform", hint: "pass --db <path>" },
      );
  }
}

/**
 * A configuration root without its trailing separators (`/`, and `\` on
 * Windows), keeping a bare root such as `/` or `C:\`.
 */
export function normaliseRoot(root: string, platform: NodeJS.Platform): string {
  const trimmed = root.replace(platform === "win32" ? /[\\/]+$/ : /\/+$/, "");
  if (trimmed === "") return root.slice(0, 1);
  if (platform === "win32" && /^[A-Za-z]:$/.test(trimmed))
    return `${trimmed}\\`;
  return trimmed;
}

/**
 * The `--config-dir` of a server's command line, normalised, or null when it
 * has none. The value may be:
 *
 * - unquoted, with spaces (macOS `ps` never quotes): it runs up to the next
 *   ` --` argument or the end of the line;
 * - quoted on Windows, either the whole argument as libuv quotes one with
 *   spaces (`"--config-dir=C:\a b\\"`, a trailing backslash doubled before
 *   the closing quote) or the value alone;
 * - ended by a separator, which is dropped.
 */
export function configDirOf(
  commandLine: string,
  platform: NodeJS.Platform,
): string | null {
  const flag = /(?:^|\s)("?)--config-dir=/.exec(commandLine);
  if (flag === null) return null;
  const rest = commandLine.slice(flag.index + flag[0].length);
  let value: string;
  if (flag[1] === '"' || rest.startsWith('"')) {
    const body = flag[1] === '"' ? rest : rest.slice(1);
    const end = body.indexOf('"');
    value = end < 0 ? body : body.slice(0, end);
  } else {
    const end = rest.search(/\s--/);
    value = (end < 0 ? rest : rest.slice(0, end)).trim();
  }
  return value === "" ? null : normaliseRoot(value, platform);
}

/** A root folded for comparison: on Windows without case and with `/` as `\`. */
function foldRoot(root: string, platform: NodeJS.Platform): string {
  const normalised = normaliseRoot(root, platform);
  return platform === "win32"
    ? normalised.replace(/\//g, "\\").toLowerCase()
    : normalised;
}

/** True when two configuration roots name the same folder. */
export function sameRoot(
  a: string,
  b: string,
  platform: NodeJS.Platform,
): boolean {
  return foldRoot(a, platform) === foldRoot(b, platform);
}

function listedServers(install: InstallContext): readonly ServerCommandLine[] {
  if (install.servers === undefined) {
    throw new Error(
      "the running Companion servers were not listed, so the install's configuration root cannot be resolved",
    );
  }
  return install.servers;
}

/** The running servers' roots, one per folder; a server without one gives none. */
function serverRoots(install: InstallContext): string[] {
  const roots = new Map<string, string>();
  for (const server of listedServers(install)) {
    const root = configDirOf(server.commandLine, install.platform);
    if (root !== null) roots.set(foldRoot(root, install.platform), root);
  }
  return [...roots.values()];
}

/**
 * The root from `COMPANION_CONFIG_BASEDIR` when it is set and non-empty
 * (used as given, as the launcher does, apart from the trailing separator),
 * else the platform default.
 */
function configuredRoot(install: InstallContext): ConfigRoot {
  const fallback = defaultConfigRoot(install);
  const variable = install.env[CONFIG_BASEDIR_VARIABLE];
  return variable
    ? {
        root: normaliseRoot(variable, install.platform),
        source: "environment",
      }
    : { root: fallback, source: "default" };
}

/**
 * The install's configuration root (macOS and Windows; any other platform is
 * refused):
 *
 *  1. the running Companion server's `--config-dir`. Servers that disagree
 *     are refused rather than guessed between; a server whose command line
 *     has none (a headless install, not supported) gives no root;
 *  2. `COMPANION_CONFIG_BASEDIR`, when defined and non-empty;
 *  3. the platform default.
 */
export function resolveConfigRoot(install: InstallContext): ConfigRoot {
  const configured = configuredRoot(install);
  const roots = serverRoots(install);
  if (roots.length > 1) {
    throw new CliError(
      `Companion servers are running with different configuration folders (${roots.join(", ")}); cannot tell which install's database to use`,
      {
        code: "companion_running",
        hint: "quit the other Companion servers, or pass --db <path>",
      },
    );
  }
  const [root] = roots;
  return root === undefined ? configured : { root, source: "server" };
}

/**
 * The Companion 5.1 database inside a configuration root: the server appends
 * `v5.1`. Windows roots use Windows path rules on any host.
 */
export function databaseInRoot(
  root: string,
  platform: NodeJS.Platform,
): string {
  return (platform === "win32" ? win32.join : join)(root, "v5.1", "db.sqlite");
}

/** The install's database at the platform's default configuration root. */
export function defaultDatabasePath(install: InstallContext): string {
  return databaseInRoot(defaultConfigRoot(install), install.platform);
}

/**
 * Expands a leading `~` (the shell does this for unquoted arguments only):
 * `~/` everywhere, and `~\` on Windows.
 */
export function expandHome(
  path: string,
  homedir: string,
  platform: NodeJS.Platform,
): string {
  if (path === "~") return homedir;
  if (platform === "win32" && /^~[\\/]/.test(path))
    return win32.join(homedir, path.slice(2));
  if (path.startsWith("~/")) return join(homedir, path.slice(2));
  return path;
}

/**
 * Resolves symlinks where the path exists; falls back to a plain absolute
 * path, with Windows path rules for a Windows install.
 */
function canonical(path: string, platform: NodeJS.Platform): string {
  try {
    return realpathSync(path);
  } catch {
    return platform === "win32" ? win32.resolve(path) : resolve(path);
  }
}

/**
 * True when `dbPath` is, or links to, `installPath`. When both exist,
 * comparing device and inode also catches hard links and the different
 * spellings a case-insensitive file system accepts. On Windows the path
 * comparison ignores case, as NTFS does.
 */
function sameDatabase(
  dbPath: string,
  installPath: string,
  platform: NodeJS.Platform,
): boolean {
  const fold = (path: string) => {
    const full = canonical(path, platform);
    return platform === "win32" ? full.toLowerCase() : full;
  };
  if (fold(dbPath) === fold(installPath)) return true;
  try {
    const a = statSync(dbPath, { bigint: true });
    const b = statSync(installPath, { bigint: true });
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/**
 * True when `dbPath` is the database of the install, as the running servers
 * use it: the database in each running server's `--config-dir`, plus the
 * root `COMPANION_CONFIG_BASEDIR` or the default gives when no server runs
 * or a server's command line names no root. A server on a custom root
 * therefore leaves the default database free for `--db`.
 */
export function isInstallDatabase(
  dbPath: string,
  install: InstallContext,
): boolean {
  const servers = listedServers(install);
  const roots = serverRoots(install);
  const unparsed = servers.some(
    (server) => configDirOf(server.commandLine, install.platform) === null,
  );
  if (roots.length === 0 || unparsed) roots.push(configuredRoot(install).root);
  return roots.some((root) =>
    sameDatabase(
      dbPath,
      databaseInRoot(root, install.platform),
      install.platform,
    ),
  );
}

/** The database a command targets. */
export interface DatabaseTarget {
  dbPath: string;
  /** Live-install mode: no `--db`, so the install's database. */
  live: boolean;
  /** The install's configuration root and its rule; null with `--db`. */
  root: ConfigRoot | null;
}

/**
 * Resolves the target database:
 *
 *  1. `--db`, with `~` expanded;
 *  2. otherwise the install's database, `<root>/v5.1/db.sqlite`, with the
 *     root from `resolveConfigRoot`: the running server's `--config-dir`,
 *     `COMPANION_CONFIG_BASEDIR`, or the platform default (macOS and
 *     Windows; any other platform is refused).
 */
export function resolveDatabaseTarget(
  requested: string | undefined,
  install: InstallContext,
): DatabaseTarget {
  if (requested === undefined) {
    const root = resolveConfigRoot(install);
    return {
      dbPath: databaseInRoot(root.root, install.platform),
      live: true,
      root,
    };
  }
  return {
    dbPath: resolve(expandHome(requested, install.homedir, install.platform)),
    live: false,
    root: null,
  };
}

/**
 * The target database for messages: in live-install mode with the rule that
 * chose it, `<path> (from COMPANION_CONFIG_BASEDIR)`; with `--db`, the path.
 */
export function describeDatabase(target: {
  dbPath: string;
  root: ConfigRoot | null;
}): string {
  return target.root === null
    ? target.dbPath
    : `${target.dbPath} (from ${describeRootSource(target.root.source)})`;
}

/**
 * The environment to start Companion's launcher with so it runs on `root`
 * again: the install context's environment with `COMPANION_CONFIG_BASEDIR`
 * set to `root`, or removed when `root` is the platform's default folder.
 * Removed, not emptied: the launcher would use an empty value as the root.
 * Removing it matters on macOS too, where `open -a` passes the environment
 * on, so a variable exported in the shell would otherwise move a Companion
 * that ran on the default folder. On Windows, where variable names ignore
 * case, every spelling is removed.
 */
export function launchEnvironment(
  install: InstallContext,
  root: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...install.env };
  for (const name of Object.keys(env)) {
    const same =
      install.platform === "win32"
        ? name.toUpperCase() === CONFIG_BASEDIR_VARIABLE
        : name === CONFIG_BASEDIR_VARIABLE;
    if (same) delete env[name];
  }
  if (!sameRoot(root, defaultConfigRoot(install), install.platform)) {
    env[CONFIG_BASEDIR_VARIABLE] = root;
  }
  return env;
}

/**
 * Refuses a database path that is not an existing file. `described` names it
 * in the message (see `describeDatabase`); it defaults to the path.
 */
export function assertDatabaseExists(
  dbPath: string,
  described: string = dbPath,
): void {
  if (!existsSync(dbPath) || !statSync(dbPath).isFile()) {
    throw new CliError(`database not found: ${described}`, {
      code: "database_not_found",
      hint: "pass --db <path>, or check that Companion 5.1 has been run once",
    });
  }
}
