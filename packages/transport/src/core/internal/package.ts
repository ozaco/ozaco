import type { Operation, Task } from 'std:effect'
import { attempt, ensure, fork, race, scoped, sleep, withResolvers } from 'std:effect'
import { IO } from 'std:io'
import { fail, isFailure } from 'std:result'

import {
  CANCEL_PREFIX,
  DEFAULT_TIMEOUT_MS,
  HEADERS,
  INBOX_PREFIX,
  KINDS,
  PARCEL_IDLE_MS,
} from '../const'
import { TransportErrors } from '../errors'
import type { Helpers } from '../types/helpers'
import type { TransportDef } from '../types/transport'

import { decodeFailure, decodeValue, empty, encodeFailure, encodeValue, toMessage } from './codec'
import { parcelThreshold, parcelTopic, readParcel, sendParcel, waitOf } from './parcel'

/**
 * The package plane: request/reply carrying a Result. A backend with native request/reply
 * (NATS) answers through the driver; everywhere else core emulates it with a per-request inbox
 * topic (`$inbox.<cid>`) named in the `oz-reply` header. Replies carry `oz-result: ok | fail`;
 * a `fail` reply re-raises on the caller with the responder's tag/message/causes.
 *
 * A payload of ANY size travels: what does not fit one backend message rides the parcel
 * sideband (`internal/parcel.ts`) — the message itself then carries only `oz-parcel: <bytes>`
 * and the bytes cross on a credit-paced lane addressed by the exchange's correlation id.
 */

/** Fold a parcelled payload back into the message that announced it. */
function* whole(
  runtime: Helpers.Runtime,
  sideband: Helpers.Sideband,
  raw: TransportDef.Raw,
): Operation<TransportDef.Raw> {
  const { cid, direction } = sideband
  const announced = raw.headers[HEADERS.parcel]

  if (announced === undefined) {
    return raw
  }

  const size = Number(announced)

  if (cid === undefined || !Number.isInteger(size) || size < 0) {
    return yield* fail(
      TransportErrors.Encoding,
      `malformed parcel announcement on "${raw.topic}": ${announced}`,
    )
  }

  const { [HEADERS.parcel]: _omit, ...headers } = raw.headers

  return { ...raw, data: yield* readParcel(runtime, parcelTopic(cid, direction), size), headers }
}

/** Parse a reply message into the caller's outcome. */
function* parseReply<T>(
  runtime: Helpers.Runtime,
  cid: string,
  raw: TransportDef.Raw,
): Operation<T> {
  const reply = yield* whole(runtime, { cid, direction: 'out' }, raw)

  if (reply.headers[HEADERS.result] === 'fail') {
    return yield* yield* decodeFailure(reply)
  }

  return yield* decodeValue<T>(reply)
}

/** Answer one request: the payload rides the reply when it fits one message, otherwise the
 * reply announces a parcel and the bytes follow on the sideband (the caller attaches the moment
 * it reads the announcement). */
function* respond(
  runtime: Helpers.Runtime,
  reply: Helpers.Reply,
  answer: Helpers.Answer,
): Operation<void> {
  const { driver } = runtime
  const { data, headers } = answer
  const { topic, cid, waitMs } = reply

  const publish = function* (body: Uint8Array, extra: TransportDef.Headers) {
    yield* driver.publish({
      topic,
      data: body,
      headers: { ...headers, ...extra },
      transient: true,
      reply: true,
    })
  }

  const threshold = yield* parcelThreshold(driver)

  if (cid === undefined || threshold === null || data.length <= threshold) {
    yield* publish(data, {})
    return
  }

  yield* sendParcel(runtime, {
    topic: parcelTopic(cid, 'out'),
    data,
    waitMs,
    *ready() {
      yield* publish(empty(), { [HEADERS.parcel]: String(data.length) })
    },
  })
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
  const encoded = yield* encodeValue(args, {
    ...given?.headers,
    [HEADERS.cid]: cid,
    // the owner holds an oversize reply open for this long and no longer
    [HEADERS.wait]: String(timeoutMs),
  })
  const threshold = yield* parcelThreshold(driver)
  const parcelled = threshold !== null && encoded.data.length > threshold
  // what the RPC message itself carries: the payload, or only the announcement of its parcel
  const body = parcelled
    ? {
        data: empty(),
        headers: { ...encoded.headers, [HEADERS.parcel]: String(encoded.data.length) },
      }
    : encoded

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
      if (parcelled) {
        // the sideband opens BEFORE the request announces it, so the owner's very first credit
        // announcement is heard; it then feeds frames for as long as this request lives
        const opened = withResolvers<void>('parcel opened')

        yield* fork(function* () {
          // attempt, not raise: a sideband that fails takes this request down with a timeout or
          // the owner's report of the missing payload, never the caller's whole scope
          yield* attempt(() =>
            sendParcel(runtime, {
              topic: parcelTopic(cid, 'in'),
              data: encoded.data,
              waitMs: PARCEL_IDLE_MS,
              *ready() {
                opened.resolve(undefined)
              },
            }),
          )
          // …and a lane that never opened must not park the caller here either
          opened.resolve(undefined)
        })

        yield* opened.operation
      }

      if (driver.request) {
        const raw = yield* driver.request({
          topic,
          data: body.data,
          headers: body.headers,
          timeoutMs,
        })
        return yield* parseReply<TResult>(runtime, cid, raw)
      }

      const inbox = INBOX_PREFIX + cid
      const replies = yield* driver.subscribe(inbox, { transient: true })
      const receipts = yield* driver.publish({
        topic,
        data: body.data,
        headers: { ...body.headers, [HEADERS.reply]: inbox },
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

      return yield* parseReply<TResult>(runtime, cid, winner.step.value)
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

    const cid = raw.headers[HEADERS.cid]
    const reply: Helpers.Reply = { topic: replyTo, cid, waitMs: waitOf(raw.headers[HEADERS.wait]) }

    const outcome = yield* attempt(function* () {
      // a parcelled request is collected here, inside the answer: a failure to receive it is
      // reported to the caller like any other, instead of leaving it waiting
      const message = yield* toMessage<TArgs>(yield* whole(runtime, { cid, direction: 'in' }, raw))
      return yield* handler(message.value, message)
    })

    if (isFailure(outcome)) {
      yield* respond(runtime, reply, {
        data: yield* encodeFailure(outcome),
        headers: { [HEADERS.kind]: KINDS.value, [HEADERS.result]: 'fail' },
      })
      return
    }

    const encoded = yield* encodeValue(outcome.value)
    yield* respond(runtime, reply, {
      data: encoded.data,
      headers: { ...encoded.headers, [HEADERS.result]: 'ok' },
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
        // the answer itself may fail to LEAVE (the caller went away while its oversize reply
        // was still crossing the sideband, the backend drained): that is this exchange's
        // problem, never the serving loop's
        yield* attempt(() => answer(step.value))
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
