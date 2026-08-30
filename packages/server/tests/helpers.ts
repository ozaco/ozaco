import { column, DbClient, defineSchema, table, useDb } from 'db:core'
import { action, service, stream } from 'server:core'
import type { Operation } from 'std:effect'
import { flowOf, sleep } from 'std:effect'
import { fail } from 'std:result'

import { MemoryAdapter } from 'db:impl/memory'
import { MemoryKv } from 'db:impl/memory-kv'
import { BunIO } from 'std:io/impl/bun'
import { z } from 'zod'

export const Todo = z.object({ id: z.string(), title: z.string(), done: z.boolean() })
export type Todo = z.infer<typeof Todo>

export const todosTable = table('todos', {
  title: column.text(),
  done: column.boolean(),
  note: column.text().optional(),
})

/** The ONE schema declaration of the kernel tests. */
export const testSchema = defineSchema({ todosTable })

/** A service exercising every action shape: query, mutation, failing, slow, streaming. */
export const todos = service('todos', {
  list: action.query(
    { input: z.object({ done: z.boolean().optional() }), output: z.array(Todo) },
    function* ({ input }) {
      const db = yield* useDb(testSchema)
      const rows = yield* db.query('todos').collect()
      return rows
        .filter(row => input.done === undefined || row.done === input.done)
        .map(row => ({ id: row._id, title: row.title, done: row.done }))
    },
  ),
  create: action.mutation(
    { input: z.object({ title: z.string().min(1) }), output: Todo },
    function* ({ input, ctx }) {
      yield* ctx.log.info('creating', { title: input.title })
      const db = yield* useDb(testSchema)
      const row = yield* db.insert('todos', { title: input.title, done: false })
      return { id: row._id, title: input.title, done: false }
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
  // a stream answered as ONE generator (`flowOf`) — no hand-rolled subscription object
  count: action.stream(
    { input: z.object({ n: z.number() }), output: stream.ndjson(z.number()) },
    function* ({ input }) {
      return flowOf<number>(function* (emit) {
        for (let at = 0; at < input.n; at += 1) {
          yield* emit(at)
        }
      })
    },
  ),

  /** the plainest stream answer there is: an array. */
  letters: action.stream({ output: stream.ndjson(z.string()) }, function* () {
    return ['a', 'b', 'c']
  }),
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
  yield* DbClient.use({ schema: testSchema, ...db })
  yield* MemoryKv.use()
}
