import { action, createServer, ServerErrors, service } from 'server:core'
import { Resilience } from 'server:plugins'
import { all, attempt, run, sleep } from 'std:effect'
import { fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { storage } from '../helpers'

const make = () => {
  const counters = { slow: 0, flaky: 0, fragile: 0, dedup: 0 }
  const svc = service('r', {
    slow: action.query(
      { input: z.object({ ms: z.number() }), output: z.string(), timeoutMs: 80 },
      function* ({ input }) {
        counters.slow += 1
        yield* sleep(input.ms)
        return 'done'
      },
    ),
    flaky: action.query(
      { output: z.number(), retry: { times: 2, when: ['r.down'], delayMs: 1 } },
      function* () {
        counters.flaky += 1
        if (counters.flaky < 3) {
          return yield* fail('r.down', 'not yet')
        }
        return counters.flaky
      },
    ),
    fragile: action.query(
      { output: z.string(), breaker: { failures: 2, halfOpenMs: 100 } },
      function* () {
        counters.fragile += 1
        return yield* fail('r.broken', 'always')
      },
    ),
    narrow: action.query(
      { input: z.object({ ms: z.number() }), output: z.string(), bulkhead: { max: 1, queue: 1 } },
      function* ({ input }) {
        yield* sleep(input.ms)
        return 'ok'
      },
    ),
    dedup: action.query(
      { input: z.object({ k: z.string() }), output: z.number(), singleflight: true },
      function* () {
        counters.dedup += 1
        yield* sleep(30)
        return counters.dedup
      },
    ),
    limited: action.query(
      { output: z.string(), rateLimit: { limit: 2, windowMs: 60_000 } },
      function* () {
        return 'ok'
      },
    ),
    soft: action.query(
      {
        output: z.string(),
        *fallback(failure: AnyType) {
          return `fallback:${failure.error}`
        },
      },
      function* () {
        return yield* fail('r.nope', 'primary failed')
      },
    ),
  })
  return { svc, counters }
}

describe('resilience', () => {
  it('timeout, retry, breaker, bulkhead, singleflight, rate limit and fallback as action options', async () => {
    const { svc, counters } = make()
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [svc], plugins: [Resilience] })
        expect(yield* server.call(svc, 'slow', { ms: 10 })).toBe('done')
        const timedOut = yield* attempt(server.call(svc, 'slow', { ms: 500 }))
        expect((timedOut as AnyType).error).toBe(ServerErrors.TimeoutPending)
        expect((timedOut as AnyType).causes).toContain('resilience:timeout')

        expect(yield* server.call(svc, 'flaky')).toBe(3)

        for (let n = 0; n < 2; n += 1) {
          expect(((yield* attempt(server.call(svc, 'fragile'))) as AnyType).error).toBe('r.broken')
        }
        const open = yield* attempt(server.call(svc, 'fragile'))
        expect((open as AnyType).error).toBe(ServerErrors.Unavailable)
        expect(counters.fragile).toBe(2)
        yield* sleep(120)
        // half-open: one trial reaches the handler again
        yield* attempt(server.call(svc, 'fragile'))
        expect(counters.fragile).toBe(3)

        const results = yield* all([
          attempt(server.call(svc, 'narrow', { ms: 60 })),
          attempt(server.call(svc, 'narrow', { ms: 60 })),
          attempt(server.call(svc, 'narrow', { ms: 60 })),
        ])
        const tags = results.map(result => ((result as AnyType).error ?? 'ok') as string)
        expect(tags.filter(tag => tag === 'ok')).toHaveLength(2)
        expect(tags).toContain(ServerErrors.Unavailable)

        const deduped = yield* all([
          server.call(svc, 'dedup', { k: 'a' }),
          server.call(svc, 'dedup', { k: 'a' }),
          server.call(svc, 'dedup', { k: 'b' }),
        ])
        expect(counters.dedup).toBe(2)
        expect(deduped[0]).toBe(deduped[1])

        expect(yield* server.call(svc, 'limited')).toBe('ok')
        expect(yield* server.call(svc, 'limited')).toBe('ok')
        const limited = yield* attempt(server.call(svc, 'limited'))
        expect((limited as AnyType).error).toBe(ServerErrors.RateLimited)

        expect(yield* server.call(svc, 'soft')).toBe('fallback:r.nope')
      }),
    )
  })
})
