import { column, DbClient, DbErrors, defineSchema, table, useDb } from 'db:core'
import { attempt, run } from 'std:effect'
import { isFailure, unwrap } from 'std:result'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { MemoryAdapter } from 'db:impl/memory'
import { BunIO } from 'std:io/impl/bun'

// `column.json(schema)`: the value is validated AND parsed through the schema on every write.

/** A minimal Standard Schema: a list of non-empty strings, each trimmed on the way in. */
const tagsSchema: StandardSchemaV1<unknown, readonly string[]> = {
  '~standard': {
    version: 1,
    vendor: 'ozaco-tests',
    validate: value => {
      if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
        return { issues: [{ message: 'expected a list of strings' }] }
      }

      const tags = value.map(item => item.trim())

      return tags.some(tag => tag === '')
        ? { issues: [{ message: 'an empty tag' }] }
        : { value: tags }
    },
  },
}

const notes = table('notes', {
  title: column.text(),
  tags: column.json(tagsSchema).default(() => []),
  meta: column.json<{ readonly views: number }>().optional(),
})

const schema = defineSchema({ notes })

describe('column.json(schema)', () => {
  it('declares the schema on the table, validates and parses every write, rejects what it refuses', async () => {
    unwrap(
      await run(function* () {
        yield* MemoryAdapter.use()
        yield* BunIO.use()

        yield* DbClient.use({ schema })

        const db = yield* useDb(schema)

        expect(Object.keys(notes.schemas)).toEqual(['tags'])
        expect(notes.columns.find(entry => entry.name === 'tags')).toMatchObject({ kind: 'json' })

        // parsed: the schema's output is what gets stored
        const row = yield* db.insert('notes', { title: 'a', tags: [' x ', 'y'] })

        expect(row.tags).toEqual(['x', 'y'])

        // the default rides the schema too
        const bare = yield* db.insert('notes', { title: 'b' })

        expect(bare.tags).toEqual([])

        // a json column without a schema is stored as is
        const metad = yield* db.insert('notes', { title: 'c', meta: { views: 3 } })

        expect(metad.meta).toEqual({ views: 3 })

        const wrong = yield* attempt(db.insert('notes', { title: 'd', tags: 'nope' as AnyType }))

        expect(isFailure(wrong) && wrong.error).toBe(DbErrors.Validation)
        expect(isFailure(wrong) && wrong.causes[0]).toBe('"tags": expected a list of strings')

        const patched = yield* attempt(db.patch('notes', row._id, { tags: ['ok', ''] }))

        expect(isFailure(patched) && patched.causes[0]).toBe('"tags": an empty tag')

        const trimmed = yield* db.patch('notes', row._id, { tags: ['  z'] })

        expect(trimmed?.tags).toEqual(['z'])
      }),
    )
  })
})
