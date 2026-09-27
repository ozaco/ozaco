// oxlint-disable import/exports-last
import { ServerErrors } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt, sleep, until } from 'std:effect'
import { fail, isFailure } from 'std:result'

import type { Helpers } from '../types/helpers'
import type { OtlpDef } from '../types/otlp'

import {
  REPLY_EXCERPT_BYTES,
  RETRY_AFTER_CAP_MS,
  RETRY_JITTER,
  RETRY_MULTIPLIER,
  RETRYABLE_STATUSES,
} from './const'
import { jsonPartial } from './json'
import { protobufPartial } from './protobuf'

/** gzip a request body with the platform's `CompressionStream` (Bun, Node ≥ 18, Deno,
 * browsers). */
function* gzipped(body: Uint8Array | string): Operation<Uint8Array> {
  const stream = new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))

  return new Uint8Array(yield* until(new Response(stream).arrayBuffer()))
}

/**
 * ONE POST, read whole, within `budget.deadline`: the fetch is aborted when the delivery's time
 * runs out or the calling scope halts (the `finally`), never left dangling.
 */
function* post(
  target: Helpers.Target,
  request: { readonly body: Uint8Array | string; readonly headers: Record<string, string> },
  budget: Helpers.DeliveryBudget,
): Operation<Helpers.Reply> {
  const { body, headers } = request
  const reason = `timed out: the delivery's ${target.timeoutMs}ms budget (timeoutMs) ran out`
  const left = budget.deadline - Date.now()

  // nothing left (the stop's deadline passed while this batch waited): no request at all
  if (left <= 0) {
    return yield* fail(ServerErrors.Unavailable, reason)
  }

  const controller = new AbortController()
  // the fetch rejects with the abort's reason: the failure itself, nested under the delivery's
  const timer = setTimeout(() => controller.abort(fail(ServerErrors.Unavailable, reason)), left)

  try {
    const response = yield* until(
      target.fetch(target.url, {
        method: 'POST',
        headers,
        body: body as RequestInit['body'],
        signal: controller.signal,
      }),
    )
    const content = new Uint8Array(yield* until(response.arrayBuffer()))

    return { status: response.status, headers: response.headers, body: content }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/** `Retry-After`: delay-seconds or an HTTP date, as milliseconds (capped); null when absent. */
const retryAfterOf = (headers: Headers): number | null => {
  const raw = headers.get('retry-after')

  if (!raw) {
    return null
  }

  const seconds = Number(raw)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now()

  return Number.isFinite(ms) ? Math.min(Math.max(0, ms), RETRY_AFTER_CAP_MS) : null
}

/** Exponential backoff with ± jitter for the `tries`-th retry (1-based). */
const backoffOf = (retry: Helpers.RetryPolicy, tries: number): number => {
  const base = Math.min(retry.maxMs, retry.initialMs * RETRY_MULTIPLIER ** (tries - 1))

  return Math.max(0, base * (1 - RETRY_JITTER + Math.random() * 2 * RETRY_JITTER))
}

/** The accepted request's `partialSuccess`, by the answer's content type. */
const partialOf = (reply: Helpers.Reply): Helpers.Delivery => {
  if (reply.body.length === 0) {
    return { rejected: 0, message: null }
  }

  const type = reply.headers.get('content-type') ?? ''

  if (type.includes('protobuf')) {
    return protobufPartial(reply.body)
  }

  return jsonPartial(new TextDecoder().decode(reply.body))
}

/** The start of a refusing backend's answer — it is usually the whole reason. */
const excerptOf = (body: Uint8Array): string => {
  const text = new TextDecoder()
    .decode(body.subarray(0, REPLY_EXCERPT_BYTES))
    .replaceAll(/\s+/gu, ' ')
    .trim()

  return text ? `: ${text}` : ''
}

/** Whether a retry that first waits `waitMs` still starts before the delivery's deadline. */
const inTime = (budget: Helpers.DeliveryBudget, waitMs: number): boolean =>
  Date.now() + waitMs < budget.deadline

/**
 * Deliver one encoded export request: gzip once, POST, and on 429 / 502 / 503 / 504 or a network
 * error (timeouts included) retry with backoff + jitter (a `Retry-After` answer wins) until the
 * `attempts` run out; any other status is final. The WHOLE delivery — every attempt and every
 * wait between them — ends by `budget.deadline` (`timeoutMs` after it began, like the OTel JS
 * exporters): each attempt gets what is left of it, and a retry whose wait would reach past it
 * is not made. Resolves the `partialSuccess` of the accepted request; a final failure fails
 * `server.unavailable` (the backend's answer in the message).
 */
export function* deliver(
  target: Helpers.Target,
  encoded: OtlpDef.Encoded,
  budget: Helpers.DeliveryBudget,
): Operation<Helpers.Delivery> {
  const { stats, attempts } = budget
  const headers: Record<string, string> = { ...target.headers, 'content-type': encoded.contentType }
  let body = encoded.body

  if (target.gzip) {
    body = yield* gzipped(body)
    headers['content-encoding'] = 'gzip'
  }

  for (let tries = 1; ; tries += 1) {
    const outcome = yield* attempt(() => post(target, { body, headers }, budget))
    const last = tries >= attempts

    if (isFailure(outcome)) {
      const waitMs = backoffOf(target.retry, tries)

      if (!last && inTime(budget, waitMs)) {
        stats.retried += 1
        yield* sleep(waitMs)
        continue
      }

      return yield* fail(
        ServerErrors.Unavailable,
        `otlp: ${target.signal} to ${target.url} failed after ${tries} attempt(s)`,
        outcome,
      )
    }

    const reply = outcome.value
    budget.onAnswer?.()

    if (reply.status >= 200 && reply.status < 300) {
      return partialOf(reply)
    }

    const waitMs = retryAfterOf(reply.headers) ?? backoffOf(target.retry, tries)

    if (!last && RETRYABLE_STATUSES.has(reply.status) && inTime(budget, waitMs)) {
      stats.retried += 1
      yield* sleep(waitMs)
      continue
    }

    return yield* fail(
      ServerErrors.Unavailable,
      `otlp: ${reply.status} from ${target.url}${excerptOf(reply.body)}`,
    )
  }
}
