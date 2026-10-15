import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { apply, type ApplyOptions } from "./core/apply.ts";
import { dryRun, dryRunJson, renderDryRun } from "./core/dry-run.ts";
import {
  CliError,
  errorJson,
  errorMessage,
  failureMessage,
} from "./core/errors.ts";
import {
  renderValidation,
  validate,
  validationJson,
} from "./core/validate-command.ts";
import { listCommands } from "./readers/index.ts";
import type { ListCommand } from "./readers/list.ts";
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

const APPLY_SYNOPSIS =
  "apply <description-file> [--db <path-to-db.sqlite>] [--dry-run [--json]]";
const LIST_KINDS = Object.keys(listCommands);
const LIST_SYNOPSIS = `list ${LIST_KINDS.join("|")} [<pattern>...] [--db <path-to-db.sqlite>] [--json]`;
const VALIDATE_SYNOPSIS =
  "validate <description-file> [--db <path-to-db.sqlite> | --no-db] [--json]";
const SYNOPSES = [
  APPLY_SYNOPSIS,
  VALIDATE_SYNOPSIS,
  LIST_SYNOPSIS,
  ...REST_TABLE.map(synopsis),
];

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
  "apply --dry-run runs the same checks on a temporary copy of the database and",
  "reports the rows an apply would add, replace and remove. It writes nothing,",
  "takes no backup and never stops or starts Companion. --json prints that",
  "report as one JSON document.",
  "validate checks a description file as apply would before writing, and",
  "refuses with the same message. With a database (the install's, or --db)",
  "it also runs apply's checks against a read-only copy of it; --no-db checks",
  "the file only. It writes nothing and never stops or starts Companion.",
  "list prints the custom variables, triggers, connections (with the buttons",
  "and triggers using each) or pages stored in the database, one line each.",
  "Connection configuration and secrets are never printed. A pattern is a",
  "case-sensitive glob over the whole name or label (* any",
  "run of characters, ? one character); several patterns list their union.",
  "Read commands read a temporary copy of the database: they write nothing,",
  "never stop or start Companion and work while it runs. --json prints one",
  "JSON document, and any failure as one JSON error document on stdout.",
  "The other commands talk to a running local Companion. They read",
  "COMPANION_URL and COMPANION_API_KEY from .env.local in the working",
  "directory or, if there is none, from ~/.config/companion-cli/.env.local",
  "($XDG_CONFIG_HOME/companion-cli/.env.local when XDG_CONFIG_HOME is set);",
  "environment variables take precedence.",
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

/**
 * `homedir` (from `ApplyOptions`) also locates the REST commands' user config
 * file, `~/.config/companion-cli/.env.local`.
 */
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
  if (READ_COMMANDS.has(commandWord(argv) ?? "")) {
    return runRead(argv, io, options);
  }
  return runApply(argv, io, options);
}

/** Commands that only read the database, with JSON errors under `--json`. */
const READ_COMMANDS: ReadonlySet<string> = new Set(["list", "validate"]);

/** The first word that is neither an option nor the value of `--db`. */
function commandWord(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (arg === "--") return argv[index + 1];
    if (arg === "--db") index++;
    else if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

/**
 * A read command. With `--json` anywhere in argv, every failure, usage errors
 * included, is one JSON error document on stdout and nothing on stderr.
 */
async function runRead(
  argv: readonly string[],
  io: CliIo,
  options: CliOptions,
): Promise<number> {
  const end = argv.indexOf("--");
  const json = (end === -1 ? argv : argv.slice(0, end)).includes("--json");
  try {
    if (commandWord(argv) === "validate") {
      const parsed = parseValidate(argv);
      if (parsed === "help") {
        io.stdout(HELP);
        return EXIT_OK;
      }
      const result = validate({ ...parsed, writers }, options);
      io.stdout(json ? validationJson(result) : renderValidation(result));
      return EXIT_OK;
    }
    const parsed = parseRead(argv);
    if (parsed === "help") {
      io.stdout(HELP);
      return EXIT_OK;
    }
    const { command, patterns, db } = parsed;
    const result = command.run(db, patterns, options);
    if (json) io.stdout(result.json());
    else for (const line of result.text()) io.stdout(line);
    return EXIT_OK;
  } catch (error) {
    if (json) io.stdout(errorJson(error));
    else io.stderr(`error: ${failureMessage(error)}`);
    return error instanceof CliError && error.code === "usage"
      ? EXIT_USAGE
      : EXIT_FAILURE;
  }
}

interface ReadCommandLine {
  command: ListCommand;
  patterns: string[];
  db: string | undefined;
}

/** Parses a `list` command line. Throws a `usage` CliError on a bad one. */
function parseRead(argv: readonly string[]): ReadCommandLine | "help" {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        db: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw usageFailure(errorMessage(error));
  }
  const { values, positionals } = parsed;
  if (values.help) return "help";
  const [, kind, ...patterns] = positionals;
  const expected = LIST_KINDS.join(" or ");
  if (kind === undefined) {
    throw usageFailure(`list needs a kind (${expected})`);
  }
  const command = Object.hasOwn(listCommands, kind)
    ? listCommands[kind]
    : undefined;
  if (command === undefined) {
    throw usageFailure(`unknown list kind "${kind}" (expected ${expected})`);
  }
  if (patterns.includes("")) {
    throw usageFailure("a name pattern must not be empty");
  }
  if (values.db === "") throw usageFailure("--db needs a path");
  return { command, patterns, db: values.db };
}

interface ValidateCommandLine {
  descriptionPath: string;
  dbPath: string | undefined;
  noDb: boolean;
}

/** Parses a `validate` command line. Throws a `usage` CliError on a bad one. */
function parseValidate(argv: readonly string[]): ValidateCommandLine | "help" {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        db: { type: "string" },
        "no-db": { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw usageFailure(errorMessage(error));
  }
  const { values, positionals } = parsed;
  if (values.help) return "help";
  const [, file, ...extra] = positionals;
  if (file === undefined || extra.length > 0) {
    throw usageFailure("validate takes exactly one description file");
  }
  if (values.db !== undefined && values["no-db"]) {
    throw usageFailure("--db and --no-db cannot be combined");
  }
  if (values.db === "") throw usageFailure("--db needs a path");
  return {
    descriptionPath: file,
    dbPath: values.db,
    noDb: values["no-db"] ?? false,
  };
}

/** A usage error as a CliError, for commands that may print it as JSON. */
function usageFailure(reason: string): CliError {
  return new CliError(`${reason}. ${USAGE}`, { code: "usage", hint: USAGE });
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
        "dry-run": { type: "boolean" },
        json: { type: "boolean" },
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
  if (values.json && !values["dry-run"]) {
    return usageError(io, "--json is only valid with --dry-run");
  }

  const { env: _env, cwd: _cwd, ...applyOptions } = options;
  try {
    if (values["dry-run"]) {
      const result = dryRun(
        { descriptionPath: file, dbPath: values.db, writers },
        applyOptions,
      );
      if (values.json) io.stdout(dryRunJson(result));
      else for (const line of renderDryRun(result)) io.stdout(line);
      return EXIT_OK;
    }
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
  const dirs = {
    cwd: options.cwd ?? process.cwd(),
    homedir: options.homedir ?? homedir(),
  };
  try {
    const call = parseRest(command, args);
    if (call === "help") {
      io.stdout(HELP);
      return EXIT_OK;
    }
    await call(loadEndpoint(env, dirs), io);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof UsageError) {
      return usageError(io, redact(error.message, configuredApiKey(env, dirs)));
    }
    const prefix = error instanceof CliError ? "" : "unexpected error: ";
    const text = error instanceof Error ? error.message : String(error);
    const line = errorMessage(redact(text, configuredApiKey(env, dirs)));
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
