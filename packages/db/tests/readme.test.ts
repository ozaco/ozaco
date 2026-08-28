/**
 * The README's "smallest use", verbatim except for the `main` frame: if this stops compiling or
 * answering, the first thing anyone reads about this package is wrong.
 */
import { column, DbClient, table, useDb, where } from 'db:core'
import { run } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { MemoryAdapter } from 'db:impl/memory'
import { BunIO } from 'std:io/impl/bun'

const todos = table('todos', {
  title: column.text(),
  done: column.boolean().default(() => false),
  priority: column.enumOf('low', 'normal', 'high').default(() => 'normal'),
})

describe('README — the smallest use', () => {
  it('declares, writes and reads back with typed rows', async () => {
    unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* MemoryAdapter.use()
        yield* DbClient.use({ tables: [todos] })

        const db = yield* useDb(todos)

        yield* db.insert('todos', { title: 'write the README' })

        const open = yield* db
          .query('todos')
          .filter(where.eq('done', false))
          .order('priority')
          .collect()

        // typed end to end: no cast, no `String(row.title)`
        const title: string = open[0]!.title
        const priority: 'low' | 'normal' | 'high' = open[0]!.priority

        expect(title).toBe('write the README')
        expect(priority).toBe('normal')
        expect(open[0]!.done).toBe(false)
      }),
    )
  })
})
