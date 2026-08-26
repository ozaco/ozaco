import { column, DbClient, table } from 'db:core'
import { action, service, stream } from 'server:core'
import type { Operation } from 'std:effect'
import { sleep } from 'std:effect'
import { fail } from 'std:result'

import { MemoryKv } from 'db:impl/kv/memory'
import { MemoryAdapter } from 'db:impl/memory'
import { BunIO } from 'std:io/impl/bun'
import { z } from 'zod'

export const Todo = z.object({ id: z.string(), title: z.string(), done: z.boolean() })
export type Todo = z.infer<typeof Todo>

export const todosTable = table('todos', { title: column.text(), done: column.boolean() })

/** A service exercising every action shape: query, mutation, failing, slow, streaming. */
export const todos = service('todos', {
  list: action.query(
    { input: z.object({ done: z.boolean().optional() }), output: z.array(Todo) },
    function* ({ input, ctx }) {
      const rows = yield* ctx.db.query('todos').collect()
      return rows
        .filter(row => input.done === undefined || row.done === input.done)
        .map(row => ({ id: String(row._id), title: String(row.title), done: Boolean(row.done) }))
    },
  ),
  create: action.mutation(
    { input: z.object({ title: z.string().min(1) }), output: Todo },
    function* ({ input, ctx }) {
      yield* ctx.log.info('creating', { title: input.title })
      const row = yield* ctx.db.insert('todos', { title: input.title, done: false })
      return { id: String(row._id), title: input.title, done: false }
    },
  ),
  explode: action.query({ input: z.object({ code: z.string() }) }, function* ({ input }) {
    return yield* fail(input.code, `boom ${input.code}`)
  }),
  slow: action.query(
    { input: z.object({ ms: z.number() }), output: z.string(), onDisconnect: 'detach' },
    function* ({ input }) {
      yield* sleep(input.ms)
      return 'late'
    },
  ),
  slowCancel: action.query(
    { input: z.object({ ms: z.number() }), output: z.string() },
    function* ({ input, ctx }) {
      yield* sleep(input.ms)
      return ctx.signal.aborted ? 'aborted' : 'late'
    },
  ),
  count: action.stream(
    { input: z.object({ n: z.number() }), output: stream.ndjson(z.number()) },
    function* ({ input }) {
      return {
        *[Symbol.iterator]() {
          let at = 0
          return {
            *next() {
              if (at >= input.n) {
                return { done: true as const, value: undefined }
              }
              return { done: false as const, value: at++ }
            },
          }
        },
      }
    },
  ),
  nested: action.query(
    { input: z.object({ title: z.string() }), output: Todo },
    // a SELF-call: the service definition is its own typed reference. The return annotation
    // breaks the inference cycle (the body is then checked AFTER `todos` has its type).
    function* ({ input, ctx }): Operation<Todo> {
      const created = yield* ctx.call(todos, 'create', { title: input.title })
      yield* ctx.emit('todo.created', created)
      return created
    },
  ),
})

/** The storage every kernel test needs: memory db (with the todos table), memory kv, bun io. */
export function* storage(db?: { replayWindowMs?: number }): Operation<void> {
  yield* MemoryAdapter.use()
  yield* BunIO.use()
  yield* DbClient.use({ tables: [todosTable], ...db })
  yield* MemoryKv.use()
}
