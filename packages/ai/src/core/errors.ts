import { createTags } from 'std:shared'

/**
 * The AI error taxonomy — every failure surfaced by the `Ai` plugin or an `AiProvider` impl is a
 * Result failure carrying one of these tags (nothing throws). Providers classify their backend's
 * native errors (HTTP statuses, structured error bodies, stream error frames) into these tags so
 * the app never sees a wire shape.
 *
 * - `auth` — the provider rejected the credentials (401/403, key/permission error codes)
 * - `rate-limit` — throttled (429, quota codes); the provider's retry-after hint travels in the
 *   failure causes as `retry-after:<seconds>` and drives the client's optional retry
 * - `request` — the provider rejected the request, or a transport fault with no better tag
 * - `bad-response` — a 2xx body (or stream chunk) that could not be decoded; malformed provider
 *   output FAILS, it never degrades into empty results
 * - `unsupported` — the installed provider lacks the capability (`embed`, `tts`, …)
 * - `configuration` — bad install wiring (no provider before `AiClient`, missing model/voice/key)
 * - `timeout` — the request deadline elapsed before the provider responded
 */
export const AiErrors = createTags(
  'ai',
  'auth',
  'rate-limit',
  'request',
  'bad-response',
  'unsupported',
  'configuration',
  'timeout',
)
