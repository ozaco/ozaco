/**
 * The README's "smallest server", verbatim except for the port and the `main`/`suspend` frame:
 * if this stops compiling or answering, the first thing anyone reads about this package is wrong.
 */
import { column, DbClient, table, useDb } from 'db:core'
import { action, createServer, service } from 'server:core'
import { run, until } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { MemoryAdapter } from 'db:impl/memory'
import { BunEdge } from 'server:impl/edge/bun'
import { BunIO } from 'std:io/impl/bun'
import { z } from 'zod'

const todosTable = table('todos', {
  title: column.text(),
  done: column.boolean().default(() => false),
})

const Todo = z.object({ title: z.string(), done: z.boolean() })

const todos = service('todos', {
  list: action.query({ output: z.array(Todo) }, function* () {
    return yield* (yield* useDb(todosTable)).query('todos').collect()
  }),

  add: action.mutation(
    { input: z.object({ title: z.string().min(1) }), output: Todo },
    function* ({ input }) {
      return yield* (yield* useDb(todosTable)).insert('todos', { title: input.title })
    },
  ),
})

describe('README — the smallest server', () => {
  it('answers GET /todos/list and POST /todos/add', async () => {
    unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* MemoryAdapter.use()
        yield* DbClient.use({ tables: [todosTable] })

        const server = yield* createServer({ services: [todos], edge: BunEdge })
        const info = yield* server.start({ port: 0 })

        const added = yield* until(
          fetch(`${info.url}/todos/add`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'read me' }),
          }),
        )

        expect(added.status).toBe(200)
        expect(yield* until(added.json())).toEqual({ title: 'read me', done: false })

        const listed = yield* until(fetch(`${info.url}/todos/list`))
        expect(yield* until(listed.json())).toEqual([{ title: 'read me', done: false }])

        // the same actions, in process and typed from the definition
        expect(yield* server.call(todos, 'list')).toEqual([{ title: 'read me', done: false }])

        yield* server.stop()
      }),
    )
  })
})
