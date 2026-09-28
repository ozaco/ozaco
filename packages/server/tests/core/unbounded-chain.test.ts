/**
 * The chain rendering has no limit, so a handler failing with an enormous cause chain must still
 * answer and be observed without a failure anywhere: the edge replies 500 with its envelope, every
 * sink receives the span and the exception record under the generic limits, and the OTLP encoder
 * (both encodings) takes them.
 */
import type { ObserveDef, ServerDef } from 'server:core'
import { action, createServer, Edge, service } from 'server:core'
import type { Operation } from 'std:effect'
import { run, sleep, until } from 'std:effect'
import { definePlugin } from 'std:plugin'
import type { Result } from 'std:result'
import { fail, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'
import { encodeLogs, encodeSpans } from 'server:plugins/observe/otlp'
import { z } from 'zod'

import { storage } from '../helpers'

const LEVELS = 20_000

/** A chain `LEVELS` deep around a 100 KB root message, each level with a string cause. */
const deepChain = (): Result.Failure<unknown> => {
  let failure: Result.Failure<unknown> = fail('root.cause', 'x'.repeat(100_000))

  for (let index = 0; index < LEVELS; index += 1) {
    failure = fail(`level.${index}`, `wrapping ${index}`, `cause ${index}`, failure)
  }

  return failure
}

const deep = service('deep', {
  fail: action.query({ input: z.object({}), output: z.object({}) }, function* () {
    return yield* deepChain()
  }),
})

describe('an unbounded failure chain through a server', () => {
  it('answers 500, reaches every sink and encodes as OTLP — no failure anywhere', async () => {
    const events: ObserveDef.Event[] = []
    const spy = definePlugin<ServerDef.PluginContext, []>({
      name: 'spy',
      version: '0',
      description: 'captures observe events',
      *setup() {
        return {
          hooks: {
            name: 'spy',
            *observe(event) {
              events.push(event)
            },
          } satisfies ServerDef.Hooks,
        }
      },
    }).build()

    const answer = unwrap(
      await run(function* (): Operation<{ status: number; body: unknown }> {
        yield* storage()

        const server = yield* createServer({
          services: [deep],
          edge: BunEdge,
          plugins: [spy.use()],
        })

        yield* server.start()

        const response = yield* Edge.actions.handle(new Request('http://edge/deep/fail'))
        const body = JSON.parse(yield* until(response.text())) as unknown

        yield* sleep(5)
        yield* server.stop()

        return { status: response.status, body }
      }),
    )

    expect(answer.status).toBe(500)
    expect(answer.body).toMatchObject({ error: { error: `level.${LEVELS - 1}` } })

    const spans = events.flatMap(event => (event.t === 'span' ? [event] : []))
    const logs = events.flatMap(event => (event.t === 'log' ? [event] : []))
    const exception = logs.find(event => event.log.attributes['exception.type'] !== undefined)

    expect(spans.length).toBeGreaterThan(0)
    expect(exception?.log.attributes['ozaco.failure.chain']).toHaveLength(128)

    const size = (encoded: { body: string | Uint8Array }): number =>
      typeof encoded.body === 'string' ? encoded.body.length : encoded.body.byteLength

    for (const encoding of ['json', 'protobuf'] as const) {
      expect(size(encodeSpans(spans, { encoding }))).toBeLessThan(1024 * 1024)
      expect(size(encodeLogs(logs, { encoding }))).toBeLessThan(1024 * 1024)
    }
  })
})
