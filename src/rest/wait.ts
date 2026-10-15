import { setTimeout as sleep } from "node:timers/promises";
import { probeRest } from "./commands.ts";
import type { CompanionEndpoint } from "./endpoint.ts";

export const DEFAULT_REST_WAIT_MS = 30_000;
export const DEFAULT_REST_POLL_MS = 500;

export type RestWait =
  { status: "ready"; elapsedMs: number } | { status: "timeout" };

/**
 * Probes Companion's REST API every `intervalMs` until it answers or
 * `timeoutMs` has passed. Each probe is cut off at the time left, so the wait
 * ends close to `timeoutMs` even when a probe hangs. Leaves no timer or
 * request pending.
 */
export async function waitForRest(
  endpoint: CompanionEndpoint,
  timeoutMs: number,
  intervalMs = DEFAULT_REST_POLL_MS,
): Promise<RestWait> {
  const started = performance.now();
  const left = () => started + timeoutMs - performance.now();
  for (;;) {
    let remaining = left();
    if (remaining <= 0) return { status: "timeout" };
    if (await probeRest(endpoint, Math.max(1, Math.ceil(remaining)))) {
      return { status: "ready", elapsedMs: performance.now() - started };
    }
    remaining = left();
    if (remaining <= 0) return { status: "timeout" };
    await sleep(Math.min(intervalMs, remaining));
  }
}
