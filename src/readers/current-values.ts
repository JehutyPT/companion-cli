/**
 * The REST part of `list variables`: after the database read, each listed
 * variable's current value from the running Companion, one request at a time.
 * It never fails the command. When the values cannot be read, every
 * `currentValue` is `null` and the listing says why (`values`, `note`,
 * `reason`); `--db` and `--no-current` skip it without a request.
 */
import { errorMessage } from "../core/errors.ts";
import { readVariableValue } from "../rest/commands.ts";
import {
  type CompanionEndpoint,
  configuredApiKey,
  loadEndpoint,
  redact,
} from "../rest/endpoint.ts";
import type { ListExtension, ListRequest, Listing } from "./list.ts";
import type { ListedVariable } from "./variables.ts";

export const NO_CURRENT_FLAG = "no-current";

/** Per-request timeout when `ListOptions.restTimeoutMs` is not given. */
export const REST_TIMEOUT_MS = 2000;

export const DB_NOTE =
  "current values are only read for the install's database";

export type UnavailableReason =
  "not_configured" | "not_reachable" | "unauthorised";

export const currentValues: ListExtension<ListedVariable> = {
  flags: [NO_CURRENT_FLAG],
  complete: async (listing, request) => {
    if (request.dbPath !== undefined) {
      return {
        ...listing,
        document: { ...listing.document, values: "skipped", note: DB_NOTE },
        notes: [`note: ${DB_NOTE}`],
      };
    }
    if (request.flags.has(NO_CURRENT_FLAG)) {
      return {
        ...listing,
        document: { ...listing.document, values: "skipped" },
      };
    }
    return readCurrentValues(listing, request);
  },
};

async function readCurrentValues(
  listing: Listing<ListedVariable>,
  request: ListRequest,
): Promise<Listing<ListedVariable>> {
  const { env, cwd, homedir, restTimeoutMs } = request.options;
  const dirs = { cwd, homedir };
  const unavailable = (
    reason: UnavailableReason,
    message: string,
  ): Listing<ListedVariable> => {
    const note = errorMessage(redact(message, configuredApiKey(env, dirs)));
    return {
      ...listing,
      document: { ...listing.document, values: "unavailable", note, reason },
      notes: [
        `note: current values unavailable (${note}); showing database values only`,
      ],
    };
  };

  let endpoint: CompanionEndpoint;
  try {
    endpoint = loadEndpoint(env, dirs);
  } catch (error) {
    return unavailable("not_configured", errorMessage(error));
  }

  const items: ListedVariable[] = [];
  for (const variable of listing.items) {
    const read = await readVariableValue(
      endpoint,
      variable.name,
      restTimeoutMs ?? REST_TIMEOUT_MS,
    );
    switch (read.outcome) {
      case "value":
        items.push({ ...variable, currentValue: read.value });
        break;
      case "missing":
        items.push(variable);
        break;
      default:
        // Values read so far are dropped with `listing`'s null ones.
        return unavailable(read.outcome, read.message);
    }
  }
  return {
    ...listing,
    items,
    document: { ...listing.document, values: "live" },
  };
}
