import type { Operation, Task } from 'std:effect'
import { attempt, ensure, fork, race, scoped, sleep, withResolvers } from 'std:effect'
import { IO } from 'std:io'
import { fail, isFailure } from 'std:result'

import { CANCEL_PREFIX, DEFAULT_TIMEOUT_MS, HEADERS, INBOX_PREFIX, KINDS } from '../const'
import { TransportErrors } from '../errors'
import type { Helpers } from '../types/helpers'
import type { TransportDef } from '../types/transport'

import { decodeFailure, decodeValue, empty, encodeFailure, encodeValue, toMessage } from './codec'

/**
 * The package plane: request/reply carrying a Result. A backend with native request/reply
 * (NATS) answers through the driver; everywhere else core emulates it with a per-request inbox
 * topic (`$inbox.<cid>`) named in the `oz-reply` header. Replies carry `oz-result: ok | fail`;
 * a `fail` reply re-raises on the caller with the responder's tag/message/causes.
 */

/** Parse a reply message into the caller's outcome. */
function* parseReply<T>(raw: TransportDef.Raw): Operation<T> {
  if (raw.headers[HEADERS.result] === 'fail') {
    return yield* yield* decodeFailure(raw)
  }

  return yield* decodeValue<T>(raw)
}

/**
 * One request. Runs in its own scope so that a caller abandoning it (halting the task that
 * awaits it) publishes `$cancel.<cid>` on the way out — the serving side halts the handler.
 */
export function* requestPackage<TResult, TArgs>(
  runtime: Helpers.Runtime,
  call: Helpers.Request<TArgs>,
): Operation<TResult> {
  const { driver } = runtime
  const { topic, args, options: given } = call
  const timeoutMs = given?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const cid = yield* IO.actions.uuid()
  const encoded = yield* encodeValue(args, { ...given?.headers, [HEADERS.cid]: cid })

  return yield* scoped(function* () {
    let settled = false
    yield* ensure(function* () {
      if (!settled) {
        // best effort: the backend may already be gone with the scope
        yield* attempt(() =>
          driver.publish({
            topic: CANCEL_PREFIX + cid,
            data: empty(),
            headers: { [HEADERS.kind]: KINDS.cancel, [HEADERS.cid]: cid },
            transient: true,
          }),
        )
      }
    })

    const outcome = yield* attempt(function* () {
      if (driver.request) {
        const raw = yield* driver.request({
          topic,
          data: encoded.data,
          headers: encoded.headers,
          timeoutMs,
        })
        return yield* parseReply<TResult>(raw)
      }

      const inbox = INBOX_PREFIX + cid
      const replies = yield* driver.subscribe(inbox, { transient: true })
      const receipts = yield* driver.publish({
        topic,
        data: encoded.data,
        headers: { ...encoded.headers, [HEADERS.reply]: inbox },
        transient: true,
      })

      if (receipts === 0) {
        return yield* fail(TransportErrors.NoResponders, `no responders on "${topic}"`)
      }

      const winner = yield* race([
        (function* () {
          const step = yield* replies.next()
          return { step }
        })(),
        (function* () {
          yield* sleep(timeoutMs)
          return { timeout: true as const }
        })(),
      ])

      if ('timeout' in winner) {
        return yield* fail(
          TransportErrors.Timeout,
          `request to "${topic}" timed out after ${timeoutMs}ms`,
        )
      }

      if (winner.step.done) {
        return yield* fail(TransportErrors.Closed, `request to "${topic}": inbox closed`)
      }

      return yield* parseReply<TResult>(winner.step.value)
    })
    // settled either way (a timeout is an outcome too — the handler keeps running on purpose:
    // the caller stopped waiting, it did not cancel); only a HALT leaves `settled` false
    settled = true

    if (isFailure(outcome)) {
      return yield* outcome
    }

    return outcome.value
  })
}

export function* servePackage<TArgs, TResult>(
  runtime: Helpers.Runtime,
  service: Helpers.Service<TArgs, TResult>,
): Operation<TransportDef.Stop> {
  const { driver } = runtime
  const { topic, handler, group } = service
  /** handlers in flight by correlation id — a `$cancel.<cid>` halts the matching one. */
  const inflight = new Map<string, Task<void>>()

  const answer = function* (raw: TransportDef.Raw) {
    const replyTo = raw.headers[HEADERS.reply]
    if (!replyTo) {
      return
    }

    const outcome = yield* attempt(function* () {
      const message = yield* toMessage<TArgs>(raw)
      return yield* handler(message.value, message)
    })
    if (isFailure(outcome)) {
      yield* driver.publish({
        topic: replyTo,
        data: yield* encodeFailure(outcome),
        headers: { [HEADERS.kind]: KINDS.value, [HEADERS.result]: 'fail' },
        transient: true,
        reply: true,
      })
      return
    }

    const encoded = yield* encodeValue(outcome.value)
    yield* driver.publish({
      topic: replyTo,
      data: encoded.data,
      headers: { ...encoded.headers, [HEADERS.result]: 'ok' },
      transient: true,
      reply: true,
    })
  }

  // the subscriptions live INSIDE the serving task: `stop()` (= halting it) unsubscribes, so no
  // request is routed to a server that no longer answers. Wait for them before returning — a
  // request sent right after `serve` resolves must find the subscription in place.
  const ready = withResolvers<void>('serve ready')
  const task = yield* fork(function* () {
    const requests = yield* driver.subscribe(topic, { group, transient: true })
    const cancels = yield* driver.subscribe(`${CANCEL_PREFIX}>`, { transient: true })
    ready.resolve(undefined)

    yield* fork(function* () {
      for (;;) {
        const step = yield* cancels.next()
        if (step.done) {
          return
        }
        const cid = step.value.headers[HEADERS.cid] ?? step.value.topic.slice(CANCEL_PREFIX.length)
        const running = inflight.get(cid)
        if (running) {
          inflight.delete(cid)
          yield* running.halt()
        }
      }
    })

    for (;;) {
      const step = yield* requests.next()
      if (step.done) {
        return
      }

      // each request answers on its own task so a slow handler never blocks the next one
      const cid = step.value.headers[HEADERS.cid]

      const running = yield* fork(function* () {
        yield* answer(step.value)
        if (cid !== undefined) {
          inflight.delete(cid)
        }
      })

      if (cid !== undefined) {
        inflight.set(cid, running)
      }
    }
  })
  yield* ready.operation

  return function* () {
    yield* task.halt()
  }
}
