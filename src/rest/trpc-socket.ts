/**
 * A subscribe-only client for Companion's tRPC WebSocket (`/trpc`), used by
 * `schema --connection` (#22). See docs/companion-internals.md, "Module
 * definitions".
 *
 * The same socket exposes Companion's mutations, and it needs no
 * authentication. So this client can only ever send two methods,
 * `subscription` and `subscription.stop`: `send` takes nothing else, and no
 * other code builds a message. It uses Node's global `WebSocket`, which sends
 * no `Origin` header and no cookies.
 */
import { CliError } from "../core/errors.ts";

/** The only methods this client sends. */
type Method = "subscription" | "subscription.stop";

const NOT_RUNNING_HINT = "start Companion, or check COMPANION_URL";

/** The hint of an answer Companion 5.1 would not give. */
export const OTHER_COMPANION_HINT =
  "the running Companion may not be the installed 5.1 build";

/** One awaited subscription: its first `data` payload settles it. */
interface Pending {
  path: string;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
}

export class TrpcSubscriber {
  readonly #socket: WebSocket;
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed: Promise<void>;
  #isClosed = false;

  private constructor(socket: WebSocket, url: string, timeoutMs: number) {
    this.#socket = socket;
    this.#url = url;
    this.#timeoutMs = timeoutMs;
    this.#closed = new Promise((resolve) =>
      socket.addEventListener("close", () => resolve()),
    );
    socket.addEventListener("message", (event) => this.#receive(event.data));
    socket.addEventListener("close", () => {
      this.#isClosed = true;
      for (const [id, pending] of this.#pending) {
        this.#pending.delete(id);
        pending.reject(this.#unanswered(pending.path, "closed the socket"));
      }
    });
  }

  /** Companion ended the exchange (`how`) before answering `path`. */
  #unanswered(path: string, how: string): CliError {
    return new CliError(
      `Companion ${how} at ${this.#url} before answering ${path}`,
      { code: "companion_not_running", hint: NOT_RUNNING_HINT },
    );
  }

  /**
   * Opens the socket at `url` (`ws:` or `wss:`). A refused or failed
   * connection is `companion_not_running`; no answer within `timeoutMs` is
   * `companion_timeout`.
   */
  static async connect(
    url: string,
    timeoutMs: number,
  ): Promise<TrpcSubscriber> {
    const socket = new WebSocket(url);
    const opened = new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () =>
          reject(
            new CliError(`cannot connect to Companion at ${url}`, {
              code: "companion_not_running",
              hint: NOT_RUNNING_HINT,
            }),
          ),
        { once: true },
      );
    });
    // A late error after a timeout must not become an unhandled rejection.
    opened.catch(() => undefined);
    try {
      await withTimeout(opened, timeoutMs, `connecting to ${url}`);
    } catch (error) {
      socket.close();
      throw error;
    }
    return new TrpcSubscriber(socket, url, timeoutMs);
  }

  /**
   * Subscribes to `path`, waits for its first `data` payload, then stops the
   * subscription (also on an error or a timeout) and returns the payload.
   */
  async first(path: string): Promise<unknown> {
    if (this.#isClosed) throw this.#unanswered(path, "closed the socket");
    const id = this.#nextId++;
    const data = new Promise<unknown>((resolve, reject) =>
      this.#pending.set(id, { path, resolve, reject }),
    );
    this.#send(id, "subscription", path);
    try {
      return await withTimeout(data, this.#timeoutMs, `waiting for ${path}`);
    } finally {
      this.#pending.delete(id);
      this.#send(id, "subscription.stop");
    }
  }

  /** Closes the socket and waits, at most the time limit, for it to close. */
  async close(): Promise<void> {
    this.#socket.close();
    await withTimeout(this.#closed, this.#timeoutMs, "closing").catch(
      () => undefined,
    );
  }

  /** The only place a message is built. */
  #send(id: number, method: Method, path?: string): void {
    if (this.#socket.readyState !== WebSocket.OPEN) return;
    this.#socket.send(
      JSON.stringify(
        method === "subscription"
          ? { id, method, params: { path } }
          : { id, method },
      ),
    );
  }

  #receive(raw: unknown): void {
    let message: unknown;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    const { id, result, error } = message as Record<string, unknown>;
    const pending = typeof id === "number" ? this.#pending.get(id) : undefined;
    if (!pending) return;
    if (error !== undefined) {
      this.#pending.delete(id as number);
      const reason =
        error && typeof error === "object" && "message" in error
          ? String(error.message)
          : JSON.stringify(error);
      pending.reject(
        new CliError(
          `Companion answered ${pending.path} with an error: ${reason}`,
          { code: "unsupported_companion_build", hint: OTHER_COMPANION_HINT },
        ),
      );
      return;
    }
    const reply = result as Record<string, unknown> | undefined;
    if (reply?.["type"] === "data") {
      this.#pending.delete(id as number);
      pending.resolve(reply["data"]);
    } else if (reply?.["type"] === "stopped") {
      this.#pending.delete(id as number);
      pending.reject(
        this.#unanswered(pending.path, "stopped the subscription"),
      );
    }
  }
}

/** `promise`, or a `companion_timeout` failure after `ms`. */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  doing: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new CliError(`Companion did not answer within ${ms} ms (${doing})`, {
            code: "companion_timeout",
            hint: NOT_RUNNING_HINT,
          }),
        ),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
