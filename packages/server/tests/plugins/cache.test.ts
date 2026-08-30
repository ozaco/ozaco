import { Kv, useDb } from 'db:core'
import { action, createServer, Observe, service } from 'server:core'
import { Cache, ObservePlugin } from 'server:plugins'
import { run, sleep } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { storage, testSchema } from '../helpers'

describe('cache', () => {
  it('caches query results by input/vary, invalidates by tags, mutations and db changes', async () => {
    let computed = 0
    const svc = service('c', {
      get: action.query(
        {
          input: z.object({ id: z.string() }),
          output: z.object({ id: z.string(), n: z.number() }),
          cache: { ttlMs: 10_000, tags: ['todos'] },
        },
        function* ({ input }) {
          computed += 1
          return { id: input.id, n: computed }
        },
      ),
      mine: action.query(
        { output: z.number(), cache: { ttlMs: 10_000, vary: ['auth.id'] } },
        function* () {
          computed += 1
          return computed
        },
      ),
      bump: action.mutation({ invalidate: ['todos'] }, function* () {}),
      write: action.mutation({ input: z.object({ title: z.string() }) }, function* ({ input }) {
        const db = yield* useDb(testSchema)
        yield* db.insert('todos', { title: input.title, done: false })
      }),
    })
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [svc],
          plugins: [ObservePlugin.use({ batch: { ms: 5 } }), Cache],
        })
        yield* server.start()
        expect(yield* server.call(svc, 'get', { id: 'a' })).toEqual({ id: 'a', n: 1 })
        expect(yield* server.call(svc, 'get', { id: 'a' })).toEqual({ id: 'a', n: 1 })
        expect(yield* server.call(svc, 'get', { id: 'b' })).toEqual({ id: 'b', n: 2 })
        expect(computed).toBe(2)
        // the store holds the entries under the cache prefix
        expect((yield* Kv.actions.keys('cache:')).keys.length).toBe(2)

        // a mutation with `invalidate` drops the tag
        yield* server.call(svc, 'bump')
        expect(yield* server.call(svc, 'get', { id: 'a' })).toEqual({ id: 'a', n: 3 })

        // a db write to the tagged table invalidates too (via the change feed)
        yield* server.call(svc, 'write', { title: 'x' })
        yield* sleep(30)
        expect(yield* server.call(svc, 'get', { id: 'a' })).toEqual({ id: 'a', n: 4 })

        // vary on auth only: the same user shares one entry
        expect(yield* server.call(svc, 'mine')).toBe(5)
        expect(yield* server.call(svc, 'mine')).toBe(5)

        // cache spans say hit/miss
        yield* sleep(30)
        const page = yield* Observe.actions.query({ action: 'get' })
        const views: AnyType[] = []
        for (const row of page.requests) {
          views.push(yield* Observe.actions.request(row.request_id))
        }
        const names = views.flatMap(view =>
          view!.spans
            .filter((span: AnyType) => span.kind === 'cache')
            .map((span: AnyType) => span.name),
        )
        expect(names).toContain('hit')
        expect(names).toContain('miss')
        yield* server.stop()
      }),
    )
  })
})
