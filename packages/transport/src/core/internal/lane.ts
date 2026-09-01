// oxlint-disable import/exports-last
import type { Flow, Operation, Subscription } from 'std:effect'
import { attempt, createQueue, ensure, fork, race, sleep } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isFailure } from 'std:result'

import {
  CHUNK_HEADER_ALLOWANCE,
  CREDIT_ANNOUNCE_MS,
  CREDIT_PREFIX,
  DEFAULT_CREDIT,
  DEFAULT_FRAME_BYTES,
  DEFAULT_TIMEOUT_MS,
  HEADERS,
  KINDS,
} from '../const'
import { TransportErrors } from '../errors'
import type { Helpers } from '../types/helpers'
import type { TransportDef } from '../types/transport'

import { decodeFailure, decodeValue, empty, encodeFailure, encodeValue } from './codec'

/**
 * Lanes: an ordered, credit-paced, one-shot sequence of frames over one topic. The producer
 * publishes `data`/`chunk` frames (codec values / raw bytes) with a sequence number, ends with
 * an `end` frame (carrying the close value) or a `fail` frame; the consumer grants credit on
 * `$credit.<topic>`. Both `flow`/`pipe` (values) and `readable`/`writable` (bytes) ride this.
 *
 * Attach order: the consumer subscribes first and keeps announcing its initial credit until the
 * first frame arrives; the producer waits for that credit (bounded by `timeoutMs`) before it
 * sends anything — plain pub/sub keeps nothing for late subscribers.
 */

/** Wait for the next credit frame, or time out with the given tag. */
function* awaitCredit(
  credits: TransportDef.RawSubscription,
  timeoutMs: number,
  onTimeout: () => Result.Failure<unknown>,
): Operation<Helpers.CreditFrame> {
  const winner = yield* race([
    (function* () {
      const step = yield* credits.next()
      return { step }
    })(),
    (function* () {
      yield* sleep(timeoutMs)
      return { timeout: true as const }
    })(),
  ])

  if ('timeout' in winner || winner.step.done) {
    return yield* onTimeout()
  }

  return yield* decodeValue<Helpers.CreditFrame>(winner.step.value)
}

/** Open the producing side of a lane: subscribe to credit, wait for the consumer, then hand out
 * the frame publishers. Credit accounting lives in the closure. */
function* openProducer(
  runtime: Helpers.Runtime,
  topic: string,
  given?: TransportDef.LaneOptions,
): Operation<Helpers.Producer> {
  const { driver } = runtime
  const timeoutMs = given?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const credits = yield* driver.subscribe(`${CREDIT_PREFIX}${topic}`, {})

  const first = yield* awaitCredit(credits, timeoutMs, () =>
    fail(TransportErrors.Timeout, `no consumer attached to lane "${topic}" within ${timeoutMs}ms`),
  )

  let available = first.n
  let seq = 0

  const publish = function* (kind: KINDS, data: Uint8Array, extra: TransportDef.Headers = {}) {
    yield* driver.publish({
      topic,
      data,
      headers: { ...extra, [HEADERS.kind]: kind, [HEADERS.seq]: String(seq) },
    })
    seq += 1
  }

  const reserve = function* () {
    while (available <= 0) {
      const grant = yield* awaitCredit(credits, timeoutMs, () =>
        fail(
          TransportErrors.LaneFull,
          `lane "${topic}" consumer granted no credit for ${timeoutMs}ms`,
        ),
      )

      // late copies of the attach announcement are not new credit
      if (!grant.initial) {
        available += grant.n
      }
    }
    available -= 1
  }

  let terminal = false
  const producer: Helpers.Producer = {
    *send(value) {
      yield* reserve()

      if (value instanceof Uint8Array) {
        yield* publish(KINDS.chunk, value)
        return
      }

      const encoded = yield* encodeValue(value)
      yield* publish(KINDS.data, encoded.data)
    },
    *end(close) {
      terminal = true
      const data = close === undefined ? empty() : (yield* encodeValue(close)).data

      yield* publish(KINDS.end, data)
    },
    *abort(failure) {
      terminal = true

      yield* publish(KINDS.fail, yield* encodeFailure(failure))
    },
    *leave() {
      if (!terminal) {
        yield* attempt(() =>
          producer.abort(
            fail(TransportErrors.Closed, `the producer left lane "${topic}" mid-flight`),
          ),
        )
      }
    },
  }

  // a halted pipe/writable never reaches `end`/`abort`: the scope's teardown closes the lane
  yield* ensure(() => producer.leave())
  return producer
}

/** `pipe`: drive a source Flow through a lane; resolves the source's close value. A source
 * that raises is reported to the consumer as a `fail` frame and re-raised here. */
export function* pipeLane<T, TClose>(
  runtime: Helpers.Runtime,
  pipe: Helpers.Pipe<T, TClose>,
): Operation<TClose> {
  const { topic, source, options: given } = pipe
  const producer = yield* openProducer(runtime, topic, given)
  const subscription = yield* source

  for (;;) {
    const step = yield* attempt(subscription.next())

    if (isFailure(step)) {
      yield* producer.abort(step)
      return yield* step
    }

    if (step.value.done) {
      yield* producer.end(step.value.value)
      return step.value.value as TClose
    }

    yield* producer.send(step.value.value)
  }
}

/** Decode one raw lane message into a frame. */
const frameOf = (raw: TransportDef.Raw): Helpers.Frame | null => {
  const kind = raw.headers[HEADERS.kind]
  const seq = Number(raw.headers[HEADERS.seq])

  if (!Number.isInteger(seq)) {
    return null
  }

  switch (kind) {
    case KINDS.data:
    case KINDS.chunk:
    case KINDS.end:
    case KINDS.fail: {
      return { kind, seq, raw }
    }
    default: {
      return null
    }
  }
}

/** `flow`: the consuming side of a lane as a std Flow. Subscribes on attach, announces credit
 * until the first frame, then tops credit up every half window. Closes with the producer's
 * close value, its failure, or a `transport.encoding` failure on a lost/garbled frame. */
export const flowLane = <T, TClose>(
  runtime: Helpers.Runtime,
  topic: string,
  given?: TransportDef.LaneOptions,
): Flow<T, TransportDef.LaneClose<TClose>> => ({
  *[Symbol.iterator]() {
    const { driver } = runtime
    const credit = Math.max(1, given?.credit ?? DEFAULT_CREDIT)
    const subscription = yield* driver.subscribe(topic, {})
    const creditTopic = `${CREDIT_PREFIX}${topic}`

    const grant = function* (n: number, initial: boolean) {
      const encoded = yield* encodeValue({ n, initial } satisfies Helpers.CreditFrame)
      yield* driver.publish({
        topic: creditTopic,
        data: encoded.data,
        headers: { ...encoded.headers, [HEADERS.kind]: KINDS.credit },
      })
    }

    const attach = { started: false }

    // keep announcing until the producer's first frame proves it heard us
    yield* fork(function* () {
      while (!attach.started) {
        yield* grant(credit, true)
        yield* sleep(CREDIT_ANNOUNCE_MS)
      }
    })

    const half = Math.max(1, Math.floor(credit / 2))
    let expected = 0
    let consumed = 0
    let closed: TransportDef.LaneClose<TClose> | undefined
    let done = false

    const finish = (close: TransportDef.LaneClose<TClose>) => {
      done = true
      closed = close

      return { done: true as const, value: close }
    }

    const next = function* (): Operation<IteratorResult<T, TransportDef.LaneClose<TClose>>> {
      if (done) {
        return { done: true as const, value: closed as TransportDef.LaneClose<TClose> }
      }

      for (;;) {
        const step = yield* subscription.next()

        if (step.done) {
          return finish(fail(TransportErrors.Closed, `lane "${topic}" subscription closed`))
        }

        const frame = frameOf(step.value)
        if (!frame) {
          continue
        }

        attach.started = true
        if (frame.seq !== expected) {
          return finish(
            fail(
              TransportErrors.Encoding,
              `lane "${topic}" lost frames: expected #${expected}, got #${frame.seq}`,
            ),
          )
        }

        expected += 1
        switch (frame.kind) {
          case 'end': {
            const close =
              frame.raw.data.length === 0 ? undefined : yield* decodeValue<TClose>(frame.raw)
            return finish(close as TransportDef.LaneClose<TClose>)
          }
          case 'fail': {
            return finish(yield* decodeFailure(frame.raw))
          }
          default: {
            consumed += 1
            if (consumed % half === 0) {
              yield* grant(half, false)
            }
            const value =
              frame.kind === 'chunk' ? (frame.raw.data as T) : yield* decodeValue<T>(frame.raw)
            return { done: false as const, value }
          }
        }
      }
    }

    return { next } satisfies Subscription<T, TransportDef.LaneClose<TClose>>
  },
})

/** `readable`: a pull-paced platform stream over a byte lane — the pump reads one frame per
 * `pull`, so stream backpressure becomes lane credit. */
export function* readableLane(
  runtime: Helpers.Runtime,
  topic: string,
  given?: TransportDef.LaneOptions,
): Operation<ReadableStream<Uint8Array>> {
  const subscription = yield* flowLane<Uint8Array, unknown>(runtime, topic, given)
  type Step = IteratorResult<Uint8Array, TransportDef.LaneClose<unknown>>
  const demand = createQueue<(step: Step) => void, void>()

  yield* fork(function* () {
    for (;;) {
      const want = yield* demand.next()
      if (want.done) {
        return
      }
      const step = yield* subscription.next()
      want.value(step)
      if (step.done) {
        demand.close(undefined)
        return
      }
    }
  })

  const take = () =>
    new Promise<Step>(resolve => {
      demand.add(resolve)
    })

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const step = await take()
      if (!step.done) {
        controller.enqueue(step.value)
        return
      }
      if (isFailure(step.value)) {
        controller.error(step.value)
        return
      }
      controller.close()
    },
  })
}

/**
 * How many bytes one byte-lane frame may carry: the caller's `frameBytes` (or 256 KiB),
 * clamped by what the backend accepts — a stream frame that fits the wire never needs the
 * driver's chunk/reassemble path, which would hold the whole write in memory on both sides.
 */
function* frameBytesOf(
  driver: TransportDef.Driver,
  given?: TransportDef.LaneOptions,
): Operation<number> {
  const limit = driver.payloadLimit
    ? yield* driver.payloadLimit()
    : driver.capabilities.maxPayloadBytes
  const ceiling = limit === null ? Infinity : Math.max(1, limit - CHUNK_HEADER_ALLOWANCE)

  return Math.max(1, Math.min(given?.frameBytes ?? DEFAULT_FRAME_BYTES, ceiling))
}

/** `writable`: a platform sink over a byte lane — each `write` resolves once its chunk is on
 * the wire (credit-paced), `close` sends the end frame, `abort` a fail frame. A write bigger
 * than one frame is sliced (views, no copy) and paced frame by frame, so a source of ANY size
 * streams through with `credit * frameBytes` in flight. */
export function* writableLane(
  runtime: Helpers.Runtime,
  topic: string,
  given?: TransportDef.LaneOptions,
): Operation<WritableStream<Uint8Array>> {
  const frameBytes = yield* frameBytesOf(runtime.driver, given)
  const producer = yield* openProducer(runtime, topic, given)
  const commands = createQueue<Helpers.WriteCommand, void>()

  /** One write on the wire: whole when it fits a frame, sliced when it does not. */
  const sendChunk = function* (chunk: Uint8Array): Operation<void> {
    if (chunk.length <= frameBytes) {
      yield* producer.send(chunk)
      return
    }

    for (let offset = 0; offset < chunk.length; offset += frameBytes) {
      yield* producer.send(chunk.subarray(offset, Math.min(offset + frameBytes, chunk.length)))
    }
  }

  yield* fork(function* () {
    for (;;) {
      const step = yield* commands.next()
      if (step.done) {
        return
      }
      const command = step.value
      const outcome = yield* attempt(function* () {
        if (command.failure) {
          yield* producer.abort(command.failure)
        } else if (command.chunk) {
          yield* sendChunk(command.chunk)
        } else {
          yield* producer.end(undefined)
        }
      })
      command.settle(isFailure(outcome) ? outcome : null)
      if (command.chunk === null) {
        commands.close(undefined)
        return
      }
    }
  })

  const submit = (chunk: Uint8Array | null, failure: Result.Failure<unknown> | null) =>
    new Promise<void>((resolve, reject) => {
      commands.add({
        chunk,
        failure,
        settle: outcome => {
          if (outcome) {
            reject(outcome)
            return
          }
          resolve()
        },
      })
    })

  return new WritableStream<Uint8Array>({
    write: chunk => submit(chunk, null),
    close: () => submit(null, null),
    abort: reason =>
      submit(null, isFailure(reason) ? reason : fail(TransportErrors.Closed, String(reason))),
  })
}
