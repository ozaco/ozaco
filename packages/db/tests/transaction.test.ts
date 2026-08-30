import type { Adapter } from 'db:core'
import { DbAdapter, DbClient, DbErrors, useDb } from 'db:core'
import { adapterDefaults } from 'db:internal'
import { attempt, operation, run } from 'std:effect'
import { install } from 'std:plugin'
import { fail, isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { MemoryAdapter } from 'db:impl/memory'
import { BunIO } from 'std:io/impl/bun'

import { schema, users } from './helpers'

const bootstrap = function* () {
  yield* install(MemoryAdapter)
  yield* install(BunIO)
  yield* install(DbClient, { schema })
  return yield* useDb(schema)
}

describe('transactions — memory adapter', () => {
  it('commits atomically and emits buffered events only after commit', async () => {
    unwrap(
      await run(function* () {
        const db = yield* bootstrap()
        const feed = yield* db.changes('users')

        const created = yield* db.transaction(function* (tx) {
          const ada = yield* tx.insert('users', { name: 'ada' })
          yield* tx.insert('users', { name: 'grace' })
          return ada
        })
        expect(created.name).toBe('ada')
        expect(yield* db.query('users').count()).toBe(2)

        const first = yield* feed.next()
        const second = yield* feed.next()
        expect((first.value as AnyType).id).toBe(created._id)
        expect((second.value as AnyType).op).toBe('insert')
        expect((second.value as AnyType).token > (first.value as AnyType).token).toBe(true)
      }),
    )
  })

  it('rolls back every write and emits nothing when the body fails', async () => {
    unwrap(
      await run(function* () {
        const db = yield* bootstrap()
        const feed = yield* db.changes('users')

        const outcome = yield* attempt(
          db.transaction(function* (tx) {
            yield* tx.insert('users', { name: 'doomed' })
            return yield* fail(DbErrors.Query, 'boom')
          }),
        )
        expect(isFailure(outcome)).toBe(true)
        expect((outcome as AnyType).error).toBe(DbErrors.Query)
        expect(yield* db.query('users').count()).toBe(0)

        // the next event on the feed is the marker write, not anything from the rolled-back tx
        const marker = yield* db.insert('users', { name: 'marker' })
        const step = yield* feed.next()
        expect((step.value as AnyType).id).toBe(marker._id)
      }),
    )
  })

  it('supports nested transactions with inner rollback', async () => {
    unwrap(
      await run(function* () {
        const db = yield* bootstrap()
        yield* db.transaction(function* (tx) {
          yield* tx.insert('users', { name: 'outer' })
          const inner = yield* attempt(
            tx.transaction(function* (nested) {
              yield* nested.insert('users', { name: 'inner' })
              return yield* fail(DbErrors.Query, 'inner boom')
            }),
          )
          expect(isFailure(inner)).toBe(true)
        })
        const names = yield* db.query('users').collect()
        expect(names.map((row: AnyType) => row.name)).toEqual(['outer'])
      }),
    )
  })

  it('commits a nested transaction — the OUTER one owns the single change-log write', async () => {
    unwrap(
      await run(function* () {
        const db = yield* bootstrap()
        const feed = yield* db.changes('users')

        yield* db.transaction(function* (tx) {
          yield* tx.insert('users', { name: 'outer' })
          yield* tx.transaction(function* (nested) {
            yield* nested.insert('users', { name: 'inner' })
          })
        })

        const rows = yield* db.query('users').collect()
        expect(rows.map((row: AnyType) => row.name).toSorted()).toEqual(['inner', 'outer'])

        // one event per write — a nested transaction that logged its own buffer too would have
        // inserted the same tokens twice (`db.unique` on `__changes_users`)
        const first = yield* feed.next()
        const second = yield* feed.next()
        expect((first.value as AnyType).op).toBe('insert')
        expect((second.value as AnyType).op).toBe('insert')
        expect((first.value as AnyType).token).not.toBe((second.value as AnyType).token)
      }),
    )
  })

  it('upserts inside a transaction — both branches', async () => {
    unwrap(
      await run(function* () {
        const db = yield* bootstrap()

        const created = yield* db.transaction(function* (tx) {
          return yield* tx.upsert('users', { name: 'ada' }, { age: 30 })
        })
        expect(created.age).toBe(30)

        const updated = yield* db.transaction(function* (tx) {
          return yield* tx.upsert('users', { name: 'ada' }, { age: 31 })
        })
        expect(updated._id).toBe(created._id)
        expect(updated.age).toBe(31)
        expect(yield* db.query('users').count()).toBe(1)
      }),
    )
  })
})

describe('transactions — capability gating and retry', () => {
  const minimalActions = {
    *find() {
      return []
    },
    *count() {
      return 0
    },
    *aggregate() {
      return []
    },
    *insert(_table: AnyType, rows: AnyType) {
      return rows
    },
    *update() {
      return []
    },
    *remove() {
      return []
    },
    *introspect() {
      return { columns: [] }
    },
    *tables() {
      return []
    },
    *migrate() {},
  }

  it('fails db.unsupported when the adapter lacks transactions', async () => {
    const NoTxAdapter = DbAdapter.implement<Adapter.Options, []>({
      name: 'no-tx',
      version: '0.0.0',
      *setup() {
        return {
          adapter: 'no-tx',
          capabilities: { transactions: false, raw: false, alterColumn: false },
        }
      },
    }).build({ ...adapterDefaults('no-tx'), ...minimalActions })

    unwrap(
      await run(function* () {
        yield* install(NoTxAdapter)
        yield* install(BunIO)
        const db = yield* install(DbClient, { tables: [users] })
        const outcome = yield* attempt(
          db.transaction(function* () {
            return 1
          }),
        )
        expect((outcome as AnyType).error).toBe(DbErrors.Unsupported)
      }),
    )
  })

  it('retries the whole body on db.conflict', async () => {
    let calls = 0
    let bodyRuns = 0
    const FlakyAdapter = DbAdapter.implement<Adapter.Options, []>({
      name: 'flaky',
      version: '0.0.0',
      *setup() {
        return {
          adapter: 'flaky',
          capabilities: { transactions: true, raw: false, alterColumn: false },
        }
      },
    }).build({
      ...adapterDefaults('flaky'),
      ...minimalActions,
      transaction: operation(function* (body: () => AnyType) {
        calls += 1
        if (calls === 1) {
          return yield* fail(DbErrors.Conflict, 'serialization failure')
        }
        return yield* body()
      }),
    })

    unwrap(
      await run(function* () {
        yield* install(FlakyAdapter)
        yield* install(BunIO)
        const db = yield* install(DbClient, { tables: [users] })
        const value = yield* db.transaction(function* () {
          bodyRuns += 1
          return 'done'
        })
        expect(value).toBe('done')
        expect(calls).toBe(2)
        expect(bodyRuns).toBe(1)

        // retries: 0 → the conflict surfaces
        calls = 0
        const strict = yield* attempt(
          db.transaction(
            function* () {
              return 1
            },
            { retries: 0 },
          ),
        )
        expect((strict as AnyType).error).toBe(DbErrors.Conflict)
      }),
    )
  })
})
