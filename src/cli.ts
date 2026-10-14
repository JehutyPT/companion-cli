import { parseArgs } from "node:util";
import { apply, type ApplyOptions } from "./core/apply.ts";
import { CliError, errorMessage } from "./core/errors.ts";
import {
  getSurface,
  getVariable,
  listSurfaces,
  LOCATION_ACTIONS,
  type LocationAction,
  locationAction,
  setVariable,
} from "./rest/commands.ts";
import {
  type CompanionEndpoint,
  configuredApiKey,
  type Env,
  loadEndpoint,
} from "./rest/endpoint.ts";
import { writers } from "./writers/index.ts";

/**
 * The REST commands. `USAGE`, `HELP` and dispatch all come from this table.
 * `names` are alternatives for the first word; `sub` is an optional second
 * word; `params` are the positional parameters in order.
 */
interface RestCommandSpec {
  names: readonly string[];
  sub?: string;
  flags?: readonly string[];
  params: readonly string[];
  /** `name` is the first word as typed. Throws `UsageError` on bad params. */
  build: (
    params: string[],
    flags: ReadonlySet<string>,
    name: string,
  ) => RestCall;
}

/** A REST command line, checked; `run` sends it once the endpoint has loaded. */
type RestCall = (endpoint: CompanionEndpoint, io: CliIo) => Promise<void>;

const REST_TABLE: readonly RestCommandSpec[] = [
  {
    names: LOCATION_ACTIONS,
    params: ["<page>", "<row>", "<column>"],
    build: (params, _flags, name) => {
      const action = name as LocationAction;
      const [page, row, column] = params.map((text, index) =>
        integer(["page", "row", "column"][index] as string, text),
      ) as [number, number, number];
      return (endpoint) =>
        locationAction(endpoint, action, { page, row, column });
    },
  },
  {
    names: ["variable"],
    sub: "get",
    params: ["<name>"],
    build: ([name]) => {
      const checked = segment("variable name", name as string);
      return async (endpoint, io) =>
        io.stdout(await getVariable(endpoint, checked));
    },
  },
  {
    names: ["variable"],
    sub: "set",
    flags: ["--string"],
    params: ["<name>", "<value>"],
    build: ([name, value], flags) => {
      const checked = segment("variable name", name as string);
      const forceString = flags.has("--string");
      return (endpoint) =>
        setVariable(endpoint, checked, value as string, forceString);
    },
  },
  {
    names: ["surface"],
    sub: "list",
    params: [],
    build: () => async (endpoint, io) => {
      for (const line of await listSurfaces(endpoint)) io.stdout(line);
    },
  },
  {
    names: ["surface"],
    sub: "get",
    params: ["<id>"],
    build: ([id]) => {
      const checked = segment("surface id", id as string);
      return async (endpoint, io) =>
        io.stdout(await getSurface(endpoint, checked));
    },
  },
];

function synopsis(spec: RestCommandSpec): string {
  return [
    spec.names.join("|"),
    spec.sub,
    ...(spec.flags ?? []).map((flag) => `[${flag}]`),
    ...spec.params,
  ]
    .filter((word) => word !== undefined)
    .join(" ");
}

const APPLY_SYNOPSIS = "apply <description-file> [--db <path-to-db.sqlite>]";
const SYNOPSES = [APPLY_SYNOPSIS, ...REST_TABLE.map(synopsis)];

/** One line: every exit-2 message ends with it. */
export const USAGE = `usage: companion-cli ${SYNOPSES.join(" | ")}`;

export const HELP = [
  "usage:",
  ...SYNOPSES.map((line) => `  companion-cli ${line}`),
  "",
  "apply writes a description file into Companion's database. Without --db it",
  "targets the local install (macOS): it quits Companion if it is running,",
  "backs up and writes the database, then starts Companion again. With --db it",
  "writes that database and never stops or starts Companion; it refuses the",
  "install's database while Companion is running.",
  "The other commands talk to a running local Companion. They read",
  "COMPANION_URL and COMPANION_API_KEY from .env.local in the working",
  "directory; environment variables take precedence.",
  "variable set sends a number, true or false as that JSON value and anything",
  "else as a string; --string always sends a string.",
].join("\n");

export const EXIT_OK = 0;
/** Validation, version, write, integrity or REST failure. */
export const EXIT_FAILURE = 1;
/** Bad command line. */
export const EXIT_USAGE = 2;

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface CliOptions extends ApplyOptions {
  /** Environment for the REST commands. Defaults to `process.env`. */
  env?: Env;
  /** Directory holding `.env.local`. Defaults to `process.cwd()`. */
  cwd?: string;
}

/**
 * Runs the CLI and resolves to its exit code. Failures print one line on
 * stderr. `options` is the test seam into the apply pipeline and the REST
 * endpoint.
 */
export async function run(
  argv: readonly string[],
  io: CliIo,
  options: CliOptions = {},
): Promise<number> {
  const command = argv[0];
  if (command !== undefined && isRestCommand(command)) {
    return runRest(command, argv.slice(1), io, options);
  }
  return runApply(argv, io, options);
}

async function runApply(
  argv: readonly string[],
  io: CliIo,
  options: CliOptions,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        db: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return usageError(io, errorMessage(error));
  }

  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(HELP);
    return EXIT_OK;
  }
  const [command, file, ...extra] = positionals;
  if (command !== "apply") {
    return usageError(
      io,
      command === undefined
        ? "missing command"
        : `unknown command "${command}"`,
    );
  }
  if (file === undefined || extra.length > 0) {
    return usageError(io, "apply takes exactly one description file");
  }
  if (values.db === "") {
    return usageError(io, "--db needs a path");
  }

  const { env: _env, cwd: _cwd, ...applyOptions } = options;
  try {
    const result = await apply(
      { descriptionPath: file, dbPath: values.db, writers },
      { ...applyOptions, log: applyOptions.log ?? io.stdout },
    );
    io.stdout(result.summary);
    return EXIT_OK;
  } catch (error) {
    const prefix = error instanceof CliError ? "" : "unexpected error: ";
    io.stderr(`error: ${prefix}${errorMessage(error)}`);
    return EXIT_FAILURE;
  }
}

const REST_NAMES: ReadonlySet<string> = new Set(
  REST_TABLE.flatMap((spec) => spec.names),
);

function isRestCommand(command: string): boolean {
  return REST_NAMES.has(command);
}

class UsageError extends Error {}

async function runRest(
  command: string,
  args: readonly string[],
  io: CliIo,
  options: CliOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  try {
    const call = parseRest(command, args);
    if (call === "help") {
      io.stdout(HELP);
      return EXIT_OK;
    }
    await call(loadEndpoint(env, cwd), io);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof UsageError) {
      return usageError(io, redact(error.message, configuredApiKey(env, cwd)));
    }
    const prefix = error instanceof CliError ? "" : "unexpected error: ";
    const text = error instanceof Error ? error.message : String(error);
    const line = errorMessage(redact(text, configuredApiKey(env, cwd)));
    io.stderr(`error: ${prefix}${line}`);
    return EXIT_FAILURE;
  }
}

/**
 * Splits a REST command's arguments and finds its table entry. `parseArgs` is
 * not used because rows, columns and values may be negative numbers, which it
 * reads as options.
 */
function parseRest(
  command: string,
  args: readonly string[],
): RestCall | "help" {
  const positionals: string[] = [];
  const flags = new Set<string>();
  let rest = false;
  for (const arg of args) {
    if (rest || !arg.startsWith("-") || arg === "-" || /^-\.?\d/.test(arg)) {
      positionals.push(arg);
    } else if (arg === "--") {
      rest = true;
    } else if (arg === "--help" || arg === "-h") {
      return "help";
    } else {
      flags.add(arg);
    }
  }

  const candidates = REST_TABLE.filter((spec) => spec.names.includes(command));
  let spec = candidates.find((candidate) => candidate.sub === undefined);
  let params = positionals;
  if (!spec) {
    const [sub, ...subParams] = positionals;
    spec = candidates.find((candidate) => candidate.sub === sub);
    params = subParams;
    if (!spec) {
      const expected = candidates.map((c) => c.sub).join(" or ");
      throw new UsageError(
        sub === undefined
          ? `${command} needs a subcommand (${expected})`
          : `unknown ${command} subcommand "${sub}" (expected ${expected})`,
      );
    }
  }
  for (const flag of flags) {
    if (!spec.flags?.includes(flag)) {
      throw new UsageError(`unknown option "${flag}"`);
    }
  }
  const label = [command, spec.sub].filter(Boolean).join(" ");
  if (params.length !== spec.params.length) {
    throw new UsageError(
      `${label} takes ${spec.params.length ? spec.params.join(" ") : "no arguments"}`,
    );
  }
  return spec.build(params, flags, command);
}

/** A location part: a safe integer, possibly negative. */
function integer(field: string, text: string): number {
  const value = Number(text);
  if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(value)) {
    throw new UsageError(`${field} must be a safe integer, got "${text}"`);
  }
  return value;
}

/**
 * A path segment for a name or id. `.` and `..` are refused: URL parsing
 * resolves them (even as `%2E`), so they would climb out of the request path.
 */
function segment(field: string, text: string): string {
  if (text === "." || text === "..") {
    throw new UsageError(`${field} must not be "${text}"`);
  }
  return text;
}

function usageError(io: CliIo, reason: string): number {
  io.stderr(`error: ${reason}. ${USAGE}`);
  return EXIT_USAGE;
}

/** Removes the API key, and each line of a multi-line key, from `text`. */
function redact(text: string, key: string | undefined): string {
  if (!key) return text;
  let out = text.replaceAll(key, "[redacted]");
  for (const part of key.split(/[\r\n]+/)) {
    if (part.length >= 4) out = out.replaceAll(part, "[redacted]");
  }
  return out;
}
