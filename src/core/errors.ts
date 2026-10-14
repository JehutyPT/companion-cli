/**
 * The stable error codes of the JSON error envelope. Later commands add codes;
 * none is ever renamed or removed. The README lists every code.
 */
export const ERROR_CODES = [
  "usage",
  "invalid_description",
  "database_not_found",
  "unsupported_platform",
  "unsupported_version",
  "snapshot_inconsistent",
  "database_unreadable",
  "check_failed",
  "not_found",
  "unexpected",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** One refused item, when a command refuses several at once. */
export interface ErrorItem {
  message: string;
  path?: string;
}

/** What the JSON error envelope carries beyond the message. */
export interface ErrorDetails {
  code?: ErrorCode;
  /** A field path such as `variables[2].name`. */
  path?: string;
  /** The next step, for example the command to run. */
  hint?: string;
  /** One entry per refused item; `path` then holds the first item's path. */
  items?: readonly ErrorItem[];
  /** A write committed and then failed: an agent must not retry blindly. */
  committed?: boolean;
  /** The backup directory of that committed write. */
  backup?: string;
}

export interface CliErrorOptions extends ErrorOptions, ErrorDetails {}

/**
 * An expected failure with a one-line reason for the user. The CLI prints the
 * message on stderr and exits non-zero; anything else is an unexpected error.
 * `code`, `path`, `hint` and the other details fill the JSON error envelope
 * (`errorJson`).
 */
export class CliError extends Error {
  override name = "CliError";
  readonly code: ErrorCode | undefined;
  readonly path: string | undefined;
  readonly hint: string | undefined;
  readonly items: readonly ErrorItem[] | undefined;
  readonly committed: boolean | undefined;
  readonly backup: string | undefined;

  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.code = options.code;
    this.path = options.path;
    this.hint = options.hint;
    this.items = options.items;
    this.committed = options.committed;
    this.backup = options.backup;
  }
}

/** A description file failed validation. `field` is a path such as `variables[2].name`. */
export class ValidationError extends CliError {
  override name = "ValidationError";
  readonly field: string;

  constructor(field: string, reason: string) {
    super(field ? `${field}: ${reason}` : reason, {
      code: "invalid_description",
      ...(field ? { path: field } : {}),
    });
    this.field = field;
  }
}

export const UNSUPPORTED_VERSION_HINT =
  "this tool supports Companion 5.1 (DB version 17) only";

/** The database's `page_config_version` is not the supported one. */
export class UnsupportedVersionError extends CliError {
  override name = "UnsupportedVersionError";

  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, {
      code: "unsupported_version",
      hint: UNSUPPORTED_VERSION_HINT,
      ...options,
    });
  }
}

/** The first line of an error's message, for one-line reasons on stderr. */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0] ?? text;
}

/** The one-line reason the CLI prints after `error: `. */
export function failureMessage(error: unknown): string {
  const prefix = error instanceof CliError ? "" : "unexpected error: ";
  return `${prefix}${errorMessage(error)}`;
}

/**
 * The JSON error envelope: one document whose `message` is the stderr line
 * without `error: `. Details that do not apply are omitted. An error that is
 * not a `CliError` is a bug and gets the code `unexpected`.
 */
export function errorJson(error: unknown): string {
  const { code, path, hint, items, committed, backup } =
    error instanceof CliError ? error : ({} as Partial<CliError>);
  return JSON.stringify({
    error: {
      code: code ?? "unexpected",
      message: failureMessage(error),
      path,
      hint,
      items,
      committed,
      backup,
    },
  });
}

/** A Node system error code such as `ENOENT`, else the error's message. */
export function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return errorMessage(error);
}
