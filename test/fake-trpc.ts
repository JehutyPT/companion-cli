/**
 * An in-process fake of Companion's tRPC WebSocket (`/trpc`), for
 * `schema --connection` (#22) and surface config fields (#32). It is a minimal RFC 6455 server (handshake,
 * unfragmented text frames, close frames; no extensions), so the tests need no
 * WebSocket dependency and never reach a real Companion.
 *
 * It records the upgrade request headers, every message the client sends and
 * whether the client closed the socket, and answers subscriptions the way
 * Companion 5.1 does: `started`, then one `data` reply holding the `init`
 * payload of the subscribed path.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface FakeTrpcState {
  /** `instances.connections.watch`'s `info` map, by connection id. */
  connections: Record<string, unknown>;
  /** `instances.definitions.actions`' `definitions` map. */
  actions: Record<string, unknown>;
  /** `instances.definitions.feedbacks`' `definitions` map. */
  feedbacks: Record<string, unknown>;
  /** `surfaces.watchSurfaces`' `info` map, by group id. */
  surfaces: Record<string, unknown>;
  /** Paths answered with `started` and then nothing. */
  silent: Set<string>;
  /** Paths answered with a tRPC error reply. */
  failing: Set<string>;
  /** Paths after whose `data` reply the server closes the socket. */
  closeAfter: Set<string>;
}

export interface FakeTrpc {
  url: string;
  state: FakeTrpcState;
  /** One entry per upgrade request: its headers. */
  upgrades: IncomingHttpHeaders[];
  /** Every message the client sent, parsed. */
  messages: Record<string, unknown>[];
  /**
   * Upgrades since the last `reset` whose client sent a close frame. Late
   * frames from a socket opened before the reset count neither here nor in
   * `messages`, so one test cannot leak into the next (seen on Windows).
   */
  closes: number;
  reset(): void;
  stop(): Promise<void>;
}

export async function startFakeTrpc(): Promise<FakeTrpc> {
  const sockets = new Set<Socket>();
  /** Bumped on every reset; each socket remembers the one it was opened in. */
  let generation = 0;
  const fake: FakeTrpc = {
    url: "",
    state: emptyState(),
    upgrades: [],
    messages: [],
    closes: 0,
    reset() {
      fake.state = emptyState();
      fake.upgrades = [];
      fake.messages = [];
      fake.closes = 0;
      generation++;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };

  const server: Server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const opened = generation;
    fake.upgrades.push(req.headers);
    const key = String(req.headers["sec-websocket-key"]);
    const accept = createHash("sha1")
      .update(key + GUID)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = readFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.length);
        if (frame.opcode === 0x8) {
          if (opened === generation) fake.closes++;
          socket.end(encodeFrame(0x8, frame.payload.subarray(0, 2)));
          return;
        }
        if (frame.opcode !== 0x1) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(frame.payload.toString("utf8")) as Record<
            string,
            unknown
          >;
        } catch {
          if (opened === generation) {
            fake.messages.push({ unparsable: frame.payload.toString("utf8") });
          }
          continue;
        }
        if (opened === generation) fake.messages.push(message);
        respond(fake.state, message, (reply) =>
          socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(reply)))),
        );
        const path = (message["params"] as { path?: string } | undefined)?.path;
        if (path !== undefined && fake.state.closeAfter.has(path)) {
          socket.end(encodeFrame(0x8, Buffer.from([0x03, 0xe8])));
          return;
        }
      }
    });
    socket.on("error", () => undefined);
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

function emptyState(): FakeTrpcState {
  return {
    connections: {},
    actions: {},
    feedbacks: {},
    surfaces: {},
    silent: new Set(),
    failing: new Set(),
    closeAfter: new Set(),
  };
}

function respond(
  state: FakeTrpcState,
  message: Record<string, unknown>,
  send: (reply: unknown) => void,
): void {
  const { id, method } = message;
  if (method === "subscription.stop") {
    send({ id, result: { type: "stopped" } });
    return;
  }
  if (method !== "subscription") return;
  const path = (message["params"] as { path?: string } | undefined)?.path;
  const payload =
    path === "instances.connections.watch"
      ? [{ type: "init", info: state.connections }]
      : path === "instances.definitions.actions"
        ? { type: "init", definitions: state.actions }
        : path === "instances.definitions.feedbacks"
          ? { type: "init", definitions: state.feedbacks }
          : path === "surfaces.watchSurfaces"
            ? [{ type: "init", info: state.surfaces }]
            : undefined;
  if (
    payload === undefined ||
    (path !== undefined && state.failing.has(path))
  ) {
    send({ id, error: { message: `No procedure ${path}`, code: -32004 } });
    return;
  }
  send({ id, result: { type: "started" } });
  if (path !== undefined && state.silent.has(path)) return;
  send({ id, result: { type: "data", data: payload } });
}

interface Frame {
  opcode: number;
  payload: Buffer;
  /** Bytes the frame took in the buffer. */
  length: number;
}

/** A client frame (always masked), or undefined until it is complete. */
function readFrame(buffer: Buffer): Frame | undefined {
  if (buffer.length < 2) return undefined;
  const opcode = (buffer[0] as number) & 0x0f;
  const masked = ((buffer[1] as number) & 0x80) !== 0;
  let length = (buffer[1] as number) & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    for (let index = 0; index < payload.length; index++) {
      payload[index] =
        (payload[index] as number) ^
        (buffer[maskOffset + (index % 4)] as number);
    }
  }
  return { opcode, payload, length: offset + length };
}

/** A server frame: final, unmasked. */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const head =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : payload.length < 65536
        ? Buffer.from([0x80 | opcode, 126, 0, 0])
        : Buffer.from([0x80 | opcode, 127, 0, 0, 0, 0, 0, 0, 0, 0]);
  if (payload.length >= 126 && payload.length < 65536)
    head.writeUInt16BE(payload.length, 2);
  else if (payload.length >= 65536)
    head.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([head, payload]);
}
