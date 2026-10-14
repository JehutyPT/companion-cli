/**
 * An expected failure with a one-line reason for the user. The CLI prints the
 * message on stderr and exits non-zero; anything else is an unexpected error.
 */
export class CliError extends Error {
  override name = "CliError";
}

/** A description file failed validation. `field` is a path such as `variables[2].name`. */
export class ValidationError extends CliError {
  override name = "ValidationError";
  readonly field: string;

  constructor(field: string, reason: string) {
    super(field ? `${field}: ${reason}` : reason);
    this.field = field;
  }
}

/** The database's `page_config_version` is not the supported one. */
export class UnsupportedVersionError extends CliError {
  override name = "UnsupportedVersionError";
}

/** The first line of an error's message, for one-line reasons on stderr. */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0] ?? text;
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
