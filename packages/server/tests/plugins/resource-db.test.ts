import { column, DbClient, defineSchema, table, useDb } from 'db:core'
import { action, Server, ServerErrors } from 'server:core'
import { crud } from 'server:plugins'
import type { Operation } from 'std:effect'
import { attempt, run } from 'std:effect'
import { isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { MemoryAdapter } from 'db:impl/memory'
import { MemoryKv } from 'db:impl/memory-kv'
import { BunEdge } from 'server:impl/edge/bun'
import { BunIO } from 'std:io/impl/bun'
import { z } from 'zod'

// `call.db` in every hook and `crud.db(resource)` in an extend action: the installed handle
// NARROWED to the caller's scope; `column.json(zod)` shows up in the derived shapes.

const tags = z.array(z.string().min(1))

const notesTable = table('notes', {
  org: column.text(),
  title: column.text(),
  tags: column.json(tags).default(() => []),
})

const schema = defineSchema({ notesTable })

const orgOf = (ctx: AnyType): string => String(ctx.headers['x-org'] ?? 'none')

describe('resource — scoped db', () => {
  it('hooks and extend actions read through the caller scope; the json column is typed in the shapes', async () => {
    const seen: string[] = []

    const notes = crud(notesTable, {
      *scope(ctx) {
        return { op: 'eq', field: 'org', value: orgOf(ctx) }
      },
      *before({ op, db }) {
        // a `before` sees only the caller's rows
        seen.push(`${op}:${(yield* db.query('notes').collect()).length}`)
      },
      extend: {
        // the return annotations break the inference cycle (`notes` is referenced inside)
        mine: action.query({ output: z.number() }, function* (): Operation<number> {
          const db = yield* crud.db(notes)

          return (yield* db.query('notes').collect()).length
        }),
        touch: action.mutation(
          { input: z.object({ id: z.string() }), output: z.boolean() },
          function* ({ input }): Operation<boolean> {
            const db = yield* crud.db(notes)
            // the write side: a row outside the scope is not there to touch
            const row = yield* db.get('notes', input.id)

            return row !== null
          },
        ),
        // `expect`: the scoped get that is a `server.not-found` instead of a null check
        must: action.query(
          { input: z.object({ id: z.string() }), output: z.string() },
          function* ({ input }): Operation<string> {
            const db = yield* crud.db(notes)

            return (yield* db.expect('notes', input.id)).title
          },
        ),
      },
    })

    // the derived create shape carries the zod schema of the json column
    expect(notes.shapes.create.safeParse({ org: 'a', title: 't', tags: [''] }).success).toBe(false)
    expect(notes.shapes.create.safeParse({ org: 'a', title: 't', tags: ['x'] }).success).toBe(true)

    unwrap(
      await run(function* () {
        yield* MemoryAdapter.use()
        yield* BunIO.use()
        yield* DbClient.use({ schema })
        yield* MemoryKv.use()

        const server = yield* Server.actions.create({
          services: [notes],
          edge: BunEdge,
        })
        const db = yield* useDb(schema)
        const a = yield* db.insert('notes', { org: 'a', title: 'a1' })

        yield* db.insert('notes', { org: 'a', title: 'a2' })
        yield* db.insert('notes', { org: 'b', title: 'b1' })

        const asA = { meta: { 'x-org': 'a' } }
        const asB = { meta: { 'x-org': 'b' } }

        expect(yield* server.call(notes as AnyType, 'mine', undefined, asA)).toBe(2)
        expect(yield* server.call(notes as AnyType, 'mine', undefined, asB)).toBe(1)
        expect(yield* server.call(notes as AnyType, 'touch', { id: a._id }, asA)).toBe(true)
        expect(yield* server.call(notes as AnyType, 'touch', { id: a._id }, asB)).toBe(false)
        expect(yield* server.call(notes as AnyType, 'must', { id: a._id }, asA)).toBe('a1')

        const hidden = yield* attempt(server.call(notes as AnyType, 'must', { id: a._id }, asB))

        expect(isFailure(hidden) && hidden.error).toBe(ServerErrors.NotFound)
        expect(isFailure(hidden) && hidden.causes).toContain('notes:missing')

        // the built-in's hook saw the scoped count
        yield* server.call(notes as AnyType, 'list', {}, asB)
        expect(seen).toContain('list:1')

        // an unscoped read of a row the caller cannot see is `server.not-found`
        const missing = yield* attempt(server.call(notes as AnyType, 'get', { id: a._id }, asB))

        expect(isFailure(missing) && missing.error).toBe(ServerErrors.NotFound)

        yield* server.stop()
      }),
    )
  })
})
