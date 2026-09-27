import type { CodecDef } from 'std:codec'
import { Codec } from 'std:codec'
import type { Flow, Operation, Subscription } from 'std:effect'
import { attempt, ensure, flow, until } from 'std:effect'
import { asFailure, fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'

import { FetchErrors } from '../errors'
import type { FetchDef } from '../types/fetch'

/** Lift one platform body reader into an Operation; a thrown read error is reified as-is. */
const reader = <T>(read: () => Promise<T>) =>
  function* (): Operation<T> {
    try {
      return yield* until(read())
    } catch (error) {
      return yield* asFailure(error)
    }
  }

/**
 * A whole-body read that ends the request's CLIENT span: after the read, with its failure (a
 * parse / read failure is recorded on the span), or cancelled when the read is halted.
 */
function* observed<T>(span: TraceDef.LiveSpan | null, read: () => Operation<T>): Operation<T> {
  if (!span) {
    return yield* read()
  }

  let settled = false

  try {
    const outcome = yield* attempt(read)
    settled = true

    if (isFailure(outcome)) {
      yield* span.end({ failure: outcome })
      return yield* outcome
    }

    yield* span.end()
    return outcome.value
  } finally {
    if (!settled) {
      yield* span.end({ cancelled: true })
    }
  }
}

/**
 * `source` ending the CLIENT span with the stream: at its end (with the failure it closes with,
 * if any), on a failed read, or cancelled when the consuming scope closes before the end.
 */
const watched = <T, TClose>(span: TraceDef.LiveSpan, source: Flow<T, TClose>): Flow<T, TClose> => ({
  *[Symbol.iterator]() {
    let finished = false

    function* finish(options?: TraceDef.EndOptions): Operation<void> {
      finished = true
      yield* span.end(options)
    }

    yield* ensure(() => (finished ? undefined : span.end({ cancelled: true })))

    const opened = yield* attempt(source)
    if (isFailure(opened)) {
      yield* finish({ failure: opened })
      return yield* opened
    }

    const subscription = opened.value

    return {
      *next() {
        const step = yield* attempt(() => subscription.next())
        if (isFailure(step)) {
          yield* finish({ failure: step })
          return yield* step
        }

        if (step.value.done) {
          const close: unknown = step.value.value
          yield* finish(isFailure(close) ? { failure: close } : {})
        }

        return step.value
      },
    } satisfies Subscription<T, TClose>
  },
})

/** A body-stream accessor (`flow` / `raw`) whose Flow ends the CLIENT span with the stream. */
function* streamed<T, TClose>(
  span: TraceDef.LiveSpan | null,
  open: () => Operation<Flow<T, TClose>>,
): Operation<Flow<T, TClose>> {
  if (!span) {
    return yield* open()
  }

  const opened = yield* attempt(open)
  if (isFailure(opened)) {
    yield* span.end({ failure: opened })
    return yield* opened
  }

  return watched(span, opened.value)
}

/**
 * Wrap a platform `Response`. A `preferred` codec impl pins `body()`/`flow()` decoding to that
 * implementation instead of the routed `Codec` protocol (it must still be installed in scope). A
 * traced request's CLIENT `span` ends with the body: after a whole-body read (`json`, `text`,
 * `bytes`, `body`, …), when a `flow()` / `raw()` stream ends, with a read's failure, or cancelled
 * when a read / stream is abandoned.
 */
export const buildResponse = (
  raw: Response,
  preferred: CodecDef | undefined,
  span: TraceDef.LiveSpan | null,
): FetchDef.Response => {
  const readBytes = reader(() => raw.arrayBuffer().then(buffer => new Uint8Array(buffer)))

  function* readRaw() {
    if (!raw.body) {
      return yield* fail(FetchErrors.Parse, 'response has no body')
    }

    return flow(raw.body as AnyType) as Flow<Uint8Array, void>
  }

  function* readBody() {
    const bytes = yield* readBytes()
    if (bytes.length === 0) {
      return undefined
    }

    return yield* (preferred ?? Codec).actions.decode(bytes)
  }

  function* readFlow(): Operation<Flow<unknown, FetchDef.FlowClose>> {
    if (!raw.body) {
      return yield* fail(FetchErrors.Parse, 'response has no body')
    }

    return yield* (preferred ?? Codec).actions.decodeFlow(flow(raw.body as AnyType), true)
  }

  const self: FetchDef.Response = {
    native: raw,

    get ok() {
      return raw.ok
    },
    get status() {
      return raw.status
    },
    get statusText() {
      return raw.statusText
    },
    get headers() {
      return raw.headers
    },
    get url() {
      return raw.url
    },
    get redirected() {
      return raw.redirected
    },
    get bodyUsed() {
      return raw.bodyUsed
    },
    get type() {
      return raw.type
    },

    json: <T = unknown>() =>
      observed(
        span,
        reader(() => raw.json() as Promise<T>),
      ),
    text: () =>
      observed(
        span,
        reader(() => raw.text()),
      ),
    arrayBuffer: () =>
      observed(
        span,
        reader(() => raw.arrayBuffer()),
      ),
    blob: () =>
      observed(
        span,
        reader(() => raw.blob()),
      ),
    formData: () =>
      observed(
        span,
        reader(() => raw.formData()),
      ),
    bytes: () => observed(span, readBytes),
    body: (() => observed(span, readBody)) as AnyType,
    flow: (() => streamed(span, readFlow)) as AnyType,
    raw: () => streamed(span, readRaw),

    *expect() {
      if (!raw.ok) {
        return yield* fail(FetchErrors.HttpStatus, `${raw.url}: ${raw.status} ${raw.statusText}`)
      }

      return self
    },
  }

  return self
}
