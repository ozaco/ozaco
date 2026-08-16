import type { Flow } from 'std:effect'
import { attempt, run } from 'std:effect'
import { Fetch, FetchClient, fetchImpl } from 'std:fetch'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'

import { afterAll, describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Streams each string as its own chunk, pausing between writes to keep boundaries apart. */
const chunked = (...chunks: string[]) => {
  let index = 0

  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index >= chunks.length) {
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(chunks[index]!))
        index += 1
        await Bun.sleep(2)
      },
    }),
  )
}

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const { pathname } = new URL(req.url)

    if (pathname === '/ndjson') {
      return chunked('{"id":1}', '{"id":2}', '"tail"')
    }

    if (pathname === '/broken') {
      return chunked('{"broken":', 'not-json}}}')
    }

    if (pathname === '/text') {
      return chunked('first-', 'second-', 'third')
    }

    if (pathname === '/empty') {
      return new Response('')
    }

    return new Response('fallthrough')
  },
})

const base = `http://127.0.0.1:${server.port}`

afterAll(() => {
  server.stop(true)
})

/** Drains a flow, returning every emitted value plus the close value the subscription ends with. */
function* drain<T, R>(source: Flow<T, R>) {
  const subscription = yield* source
  const values: T[] = []

  while (true) {
    const next = yield* subscription.next()
    if (next.done) {
      return { values, close: next.value }
    }
    values.push(next.value)
  }
}

describe('flow() codec streaming', () => {
  it('decodes a chunked response one value per top-level JSON entity', async () => {
    const outcome = await run(function* () {
      yield* install(FetchClient)
      yield* install(JsonCodec)

      const response = yield* Fetch.actions.get(`${base}/ndjson`)
      const decoded = yield* response.flow<unknown>()

      return yield* drain(decoded)
    })

    expect(unwrap(outcome)).toEqual({
      values: [{ id: 1 }, { id: 2 }, 'tail'],
      close: true,
    })
  })

  it('a malformed JSON stream closes the flow with a Failure', async () => {
    const outcome = await run(function* () {
      yield* install(FetchClient)
      yield* install(JsonCodec)

      const response = yield* Fetch.actions.get(`${base}/broken`)
      const decoded = yield* response.flow()
      const { values, close } = yield* drain(decoded)

      return { values, closedWithFailure: isFailure(close) }
    })

    expect(unwrap(outcome)).toEqual({ values: [], closedWithFailure: true })
  })

  it('an empty body closes cleanly with no values', async () => {
    const outcome = await run(function* () {
      yield* install(FetchClient)
      yield* install(JsonCodec)

      const response = yield* Fetch.actions.get(`${base}/empty`)
      const decoded = yield* response.flow()

      return yield* drain(decoded)
    })

    expect(unwrap(outcome)).toEqual({ values: [], close: true })
  })
})

describe('raw() byte flow', () => {
  it('streams the undecoded bytes and closes with void', async () => {
    const outcome = await run(function* () {
      yield* install(FetchClient)

      const response = yield* Fetch.actions.get(`${base}/text`)
      const bytes = yield* response.raw()
      const { values, close } = yield* drain(bytes)

      const total = values.reduce((sum, chunk) => sum + chunk.byteLength, 0)
      const joined = new Uint8Array(total)
      let offset = 0
      for (const chunk of values) {
        joined.set(chunk, offset)
        offset += chunk.byteLength
      }

      return {
        text: decoder.decode(joined),
        everyChunkIsBytes: values.every(chunk => chunk instanceof Uint8Array),
        close,
      }
    })

    expect(unwrap(outcome)).toEqual({
      text: 'first-second-third',
      everyChunkIsBytes: true,
      close: undefined,
    })
  })
})

describe('bodyless responses', () => {
  it('raw() and flow() fail with parse when the response has no body at all', async () => {
    // a fetched response always carries a (possibly empty) body stream under Bun, so a bodyless
    // response is injected through the fetchImpl context instead of a server route
    const outcome = await run(function* () {
      yield* install(FetchClient)
      yield* install(JsonCodec)

      return yield* fetchImpl.with(
        () => Promise.resolve(new Response(null, { status: 204 })),
        function* () {
          const response = yield* Fetch.actions.get(`${base}/ignored`)
          const rawAttempt = yield* attempt(() => response.raw())
          const flowAttempt = yield* attempt(() => response.flow())

          return {
            raw: isFailure(rawAttempt) ? rawAttempt.error : 'no-failure',
            flow: isFailure(flowAttempt) ? flowAttempt.error : 'no-failure',
          }
        },
      )
    })

    expect(unwrap(outcome)).toEqual({ raw: 'parse', flow: 'parse' })
  })
})
