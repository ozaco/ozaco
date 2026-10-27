import { column, DbClient, DbErrors, defineSchema, table, useDb } from 'db:core'
import { all, attempt, run } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { MemoryAdapter } from 'db:impl/memory'
import { BunIO } from 'std:io/impl/bun'

// `db.modify(table, id, change, { retries })`: read → change → write pinned to the version read;
// a conflict re-reads and tries again.

const counters = table('counters', { n: column.int(), org: column.text() })
const schema = defineSchema({ counters })

describe('db — modify', () => {
  it('writes under the version it read, retries a conflict, answers null for a missing row and the row when declined', async () => {
    unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* MemoryAdapter.use()
        yield* DbClient.use({ schema })

        const db = yield* useDb(schema)
        const row = yield* db.insert('counters', { n: 0, org: 'a' })
        let changes = 0

        // concurrent increments all land: a loser re-reads and re-applies
        yield* all(
          Array.from({ length: 8 }, () =>
            db.modify(
              'counters',
              row._id,
              current => {
                changes += 1

                return { n: current.n + 1 }
              },
              { retries: 20 },
            ),
          ),
        )

        expect((yield* db.get('counters', row._id))!.n).toBe(8)
        expect(changes).toBeGreaterThanOrEqual(8)

        // a missing row, a row outside the scope: null, `change` never asked
        expect(yield* db.modify('counters', 'missing', () => ({ n: 1 }))).toBeNull()
        expect(
          yield* db.modify('counters', row._id, () => ({ n: 1 }), {
            scope: { op: 'eq', field: 'org', value: 'b' },
          }),
        ).toBeNull()

        // declined: the row as it stands, untouched
        const same = yield* db.modify('counters', row._id, () => null)

        expect(same!.n).toBe(8)
        expect(same!._version).toBe((yield* db.get('counters', row._id))!._version)

        // a scoped handle modifies through its scope
        const scoped = db.scoped({ op: 'eq', field: 'org', value: 'a' })
        const bumped = yield* scoped.modify('counters', row._id, current => ({ n: current.n + 92 }))

        expect(bumped!.n).toBe(100)

        // what the retry answers with once it gives up: the conflict of the guarded write
        const conflict = yield* attempt(
          db.patch('counters', row._id, { n: 1 }, { ifVersion: 'stale-token' }),
        )

        expect((conflict as AnyType).error).toBe(DbErrors.Conflict)
      }),
    )
  })
})
