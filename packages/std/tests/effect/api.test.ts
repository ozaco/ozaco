import type { Operation } from 'std:effect'
import { api, constant, createApi, createContext, run, scoped, useScope } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

interface DatabaseApi {
  query(sql: string): Operation<string[]>
  retries: number
}

describe('api (std:plugin/api)', () => {
  it('exposes members under .actions', async () => {
    const Database = createApi<DatabaseApi>('db.flat', {
      *query(sql) {
        return [`row:${sql}`]
      },
      retries: 3,
    })

    const outcome = await run(function* () {
      const rows = yield* Database.actions.query('users')
      const retries = yield* Database.actions.retries
      return { rows, retries }
    })

    expect(unwrap(outcome)).toEqual({ rows: ['row:users'], retries: 3 })
  })

  it('around decorates within the scope and reverts outside', async () => {
    const Database = createApi<DatabaseApi>('db.around', {
      *query(sql) {
        return [`row:${sql}`]
      },
      retries: 3,
    })

    const outcome = await run(function* () {
      const inside = yield* scoped(function* () {
        yield* Database.around({
          query: ([sql], next) =>
            (function* () {
              const rows = yield* next(sql)
              return rows.map(row => row.toUpperCase())
            })(),
          retries: (_args, next) => next() * 10,
        })

        return {
          rows: yield* Database.actions.query('users'),
          retries: yield* Database.actions.retries,
        }
      })

      const outside = {
        rows: yield* Database.actions.query('users'),
        retries: yield* Database.actions.retries,
      }

      return { inside, outside }
    })

    expect(unwrap(outcome)).toEqual({
      inside: { rows: ['ROW:USERS'], retries: 30 },
      outside: { rows: ['row:users'], retries: 3 },
    })
  })

  it('a middleware may skip next entirely (test fake)', async () => {
    const Database = createApi<DatabaseApi>('db.fake', {
      *query(sql) {
        return [`row:${sql}`]
      },
      retries: 3,
    })

    const outcome = await run(function* () {
      yield* Database.around({ query: () => constant(['FAKE']) })
      return yield* Database.actions.query('users')
    })

    expect(unwrap(outcome)).toEqual(['FAKE'])
  })

  it('the built-in scope api observes context writes', async () => {
    const Word = createContext<string>('api-test.word')
    const seen: string[] = []

    const outcome = await run(function* () {
      const scope = yield* useScope()
      scope.around(api.scope, {
        set: ([target, context, value], next) => {
          if (context.name === 'api-test.word') {
            seen.push(String(value))
          }
          return next(target, context, value)
        },
      })

      yield* Word.set('merhaba')
      return yield* Word.expect()
    })

    expect(unwrap(outcome)).toBe('merhaba')
    expect(seen).toEqual(['merhaba'])
  })
})
