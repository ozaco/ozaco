import { column, Db, DbClient, defineSchema, table, useDb } from 'db:core'
import { run } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SqliteAdapter } from 'db:impl/sqlite'
import { BunIO } from 'std:io/impl/bun'

// `backfill: true`: a column added after the rows were written gets its default applied to
// every row holding `null` — required columns only, optional ones keep their `null`s.

const v1 = table('items', { a: column.text() })
const v2 = table('items', {
  a: column.text(),
  kind: column.text().default(() => 'plain'),
  note: column
    .text()
    .optional()
    .default(() => 'never'),
  count: column.int().default(() => 0),
})

const schemaV1 = defineSchema({ items: v1 })
const schemaV2 = defineSchema({ items: v2 })

describe('migrations — default backfill', () => {
  it('fills the required default columns of old rows at install, and again on a manual migrate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ozaco-db-backfill-'))
    const path = join(dir, 'items.sqlite')

    try {
      const ids = unwrap(
        await run(function* () {
          yield* SqliteAdapter.use({ path })
          yield* BunIO.use()

          yield* DbClient.use({ schema: schemaV1 })

          const db = yield* useDb(schemaV1)
          const one = yield* db.insert('items', { a: 'one' })
          const two = yield* db.insert('items', { a: 'two' })

          return [one._id, two._id]
        }),
      )

      // auto migration + backfill: the new required columns are filled, the optional one is not
      const after = unwrap(
        await run(function* () {
          yield* SqliteAdapter.use({ path })
          yield* BunIO.use()

          yield* DbClient.use({ schema: schemaV2, backfill: true })

          const db = yield* useDb(schemaV2)
          const rows = yield* db.query('items').collect()

          return rows.map(row => ({ a: row.a, kind: row.kind, note: row.note, count: row.count }))
        }),
      )

      expect(after.toSorted((left, right) => left.a.localeCompare(right.a))).toEqual([
        { a: 'one', kind: 'plain', note: null, count: 0 },
        { a: 'two', kind: 'plain', note: null, count: 0 },
      ])

      // a manual migrate backfills too; an already filled row is left alone (its version stays)
      unwrap(
        await run(function* () {
          yield* SqliteAdapter.use({ path })
          yield* BunIO.use()

          yield* DbClient.use({ schema: schemaV2, backfill: true, migrations: 'manual' })

          const db = yield* useDb(schemaV2)
          const before = yield* db.get('items', ids[0]!)

          yield* Db.actions.migrate()

          const same = yield* db.get('items', ids[0]!)

          expect(same?._version).toBe(before?._version)
          expect(same?.kind).toBe('plain')
        }),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
