import { parseArgs } from "node:util";
import { apply, type ApplyOptions } from "./core/apply.ts";
import { CliError, errorMessage } from "./core/errors.ts";
import { writers } from "./writers/index.ts";

export const USAGE =
  "usage: companion-cli apply <description-file> --db <path-to-db.sqlite>";

export const EXIT_OK = 0;
/** Validation, version, write or integrity failure. */
export const EXIT_FAILURE = 1;
/** Bad command line. */
export const EXIT_USAGE = 2;

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/**
 * Runs the CLI and returns its exit code. Failures print one line on stderr.
 * `options` is the test seam into the apply pipeline.
 */
export function run(
  argv: readonly string[],
  io: CliIo,
  options: ApplyOptions = {},
): number {
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
    io.stderr(`error: ${errorMessage(error)}. ${USAGE}`);
    return EXIT_USAGE;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(USAGE);
    return EXIT_OK;
  }
  const [command, file, ...extra] = positionals;
  if (command !== "apply") {
    io.stderr(
      `error: ${command === undefined ? "missing command" : `unknown command "${command}"`}. ${USAGE}`,
    );
    return EXIT_USAGE;
  }
  if (file === undefined || extra.length > 0) {
    io.stderr(`error: apply takes exactly one description file. ${USAGE}`);
    return EXIT_USAGE;
  }
  if (!values.db) {
    io.stderr(`error: --db is required. ${USAGE}`);
    return EXIT_USAGE;
  }

  try {
    const result = apply(
      { descriptionPath: file, dbPath: values.db, writers },
      { ...options, log: options.log ?? io.stdout },
    );
    io.stdout(result.summary);
    return EXIT_OK;
  } catch (error) {
    const prefix = error instanceof CliError ? "" : "unexpected error: ";
    io.stderr(`error: ${prefix}${errorMessage(error)}`);
    return EXIT_FAILURE;
  }
}
