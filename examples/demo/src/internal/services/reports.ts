/**
 * Reports: the resilience + cache options in one place — cached query with tags, tag
 * invalidation from a mutation, retry with a flaky dependency, a circuit breaker, a bulkhead,
 * singleflight, a rate limit, a per-action timeout with a fallback, and a nested `ctx.call`.
 */
import { useDb } from 'db:core'
import { action, refs, service } from 'server:core'
import type { Operation } from 'std:effect'
import { sleep } from 'std:effect'
import { fail } from 'std:result'

import { z } from 'zod'

import { schema } from '../../utils/tables'

// TYPE-only: `reports` calls these services without importing them at runtime, so the module
// graph stays a tree (no cycle waiting to happen)
import type { media } from './media'
import type { todos } from './todos'

const api = {
  todos: refs<typeof todos>('todos'),
  media: refs<typeof media>('media'),
}

let flakyCalls = 0
let computed = 0

export const reports = service(
  'reports',
  {
    summary: action.query(
      {
        input: z.object({ done: z.boolean().optional() }),
        output: z.object({
          total: z.number(),
          done: z.number(),
          computedAt: z.number(),
          computations: z.number(),
        }),
        cache: { ttlMs: 5000, tags: ['todos'] },
        description: 'Cached 5s and tagged `todos`: any todos write invalidates it cluster-wide',
      },
      function* ({ input }) {
        computed += 1
        let query = (yield* useDb(schema)).query('todos')
        if (input.done !== undefined) {
          query = query.filter({ op: 'eq', field: 'done', value: input.done })
        }
        const rows = yield* query.collect()
        return {
          total: rows.length,
          done: rows.filter(row => row.done === true).length,
          computedAt: Date.now(),
          computations: computed,
        }
      },
    ),
    reset: action.mutation(
      {
        output: z.object({ ok: z.boolean() }),
        invalidate: ['todos'],
        description: 'Drops every cache entry tagged `todos`',
      },
      function* () {
        return { ok: true }
      },
    ),
    flaky: action.query(
      {
        input: z.object({ failTimes: z.number().int().min(0).max(5).default(2) }),
        output: z.object({ attempts: z.number() }),
        retry: { times: 3, when: ['reports.flaky'], delayMs: 10 },
        description: 'Fails `failTimes` times then succeeds — the retry option hides it',
      },
      function* ({ input }) {
        flakyCalls += 1
        if (flakyCalls <= input.failTimes) {
          return yield* fail('reports.flaky', `attempt ${flakyCalls} failed`)
        }
        const attempts = flakyCalls
        flakyCalls = 0
        return { attempts }
      },
    ),
    guarded: action.query(
      {
        input: z.object({ boom: z.boolean().default(false) }),
        output: z.object({ ok: z.boolean() }),
        breaker: { failures: 3, halfOpenMs: 2000 },
        bulkhead: { max: 2, queue: 4 },
        description:
          'Circuit breaker (3 failures open it for 2s) + bulkhead (2 concurrent, 4 queued)',
      },
      function* ({ input }) {
        yield* sleep(20)
        if (input.boom) {
          return yield* fail('reports.boom', 'asked to fail')
        }
        return { ok: true }
      },
    ),
    expensive: action.query(
      {
        input: z.object({ key: z.string().default('x') }),
        output: z.object({ key: z.string(), at: z.number() }),
        singleflight: true,
        description: 'Identical concurrent calls share one computation',
      },
      function* ({ input }) {
        yield* sleep(100)
        return { key: input.key, at: Date.now() }
      },
    ),
    limited: action.query(
      {
        output: z.object({ ok: z.boolean() }),
        rateLimit: { limit: 3, windowMs: 1000, key: 'ip' },
        description: '3 calls per second per ip, then `server.rate-limited` (429)',
      },
      function* () {
        return { ok: true }
      },
    ),
    eventually: action.query(
      {
        input: z.object({ ms: z.number().default(500) }),
        output: z.object({ value: z.string() }),
        timeoutMs: 100,
        *fallback() {
          return { value: 'fallback' }
        },
        description: 'A 100ms action timeout; the fallback answers instead of a timeout failure',
      },
      function* ({ input }) {
        yield* sleep(input.ms)
        return { value: 'real' }
      },
    ),
    overview: action.query(
      {
        output: z.object({ todos: z.number(), uploads: z.number() }),
        description: 'Composes other actions through ctx.call (local or over the carrier)',
      },
      // typed end to end from the definitions. `inherit: true` carries THIS caller's bearer
      // into the guarded todos.list — without it the nested call would be anonymous and 401
      function* ({ ctx }): Operation<{ todos: number; uploads: number }> {
        const page = yield* ctx.call(api.todos.list, {}, { inherit: true })
        const uploads = yield* ctx.call(api.media.list)
        return { todos: page.data.length, uploads: uploads.length }
      },
    ),
  },
  { version: '1.0.0', description: 'Cache + resilience options' },
)
