/**
 * Todos: a crud RESOURCE (REST routes under `/todos`, `If-Match` optimistic concurrency, the
 * `/todos/_realtime` delta-watch socket) — all from `crud(table)`.
 *
 * `actions` picks which built-ins exist — the demo switches `replace` (PUT) off, everything
 * else (realtime included) stays. `extend` merges CUSTOM actions into the same service: `stats`
 * used to be a separate `todo-stats` service, now it is `GET /todos/stats` (static segments win
 * over `/:id`) and `client.todos.stats()`.
 *
 * The crud HOOKS are the resource's seams — each sees the full ctx (db, auth, headers, call)
 * and may transform what flows through:
 *   before  input rewrite    writes are normalized (titles trimmed) before the handler
 *   after   output rewrite   reads are projected (high-priority rows SHOUT) — list, get and
 *                            the realtime sync/delta frames alike
 *   around  full control     `[keep]` in a title makes a row un-removable (short-circuits
 *                            without calling `next`)
 *   error   failure shaping  every failure gains a `todos:<op>` cause before it leaves
 * Hooks wrap the BUILT-INS only — `extend` authors own their whole handler.
 */
import type { Schema } from 'db:core'
import { useDb, where } from 'db:core'
import { action, Server, serviceErrors } from 'server:core'
import { crud } from 'server:plugins'
import { appendCauses } from 'std:result'

import { z } from 'zod'

import { todosTable, schema } from '../tables'

type Todo = Schema.Infer<typeof todosTable>

/** the read projection: high-priority rows shout. */
const shout = (row: Todo): Todo =>
  row.priority === 'high' ? { ...row, title: row.title.toUpperCase() } : row

/** The resource's OWN failure taxonomy: declared once, wired per-op via `ops` below. */
const guard = serviceErrors('todos', { protected: 423 })

export const todos = crud(todosTable, {
  maxLimit: 100,
  auth: { read: 'authenticated', write: 'user' },
  actions: ['realtime', 'list', 'get', 'create', 'update', 'remove'],

  extend: {
    stats: action.query(
      {
        output: z.record(z.string(), z.number()),
        cache: { ttlMs: 10_000, tags: ['todos'] },
        description: 'Open todos per priority (cached, invalidated by todos writes)',
      },
      function* () {
        const rows = yield* (yield* useDb(schema))
          .query('todos')
          .filter({ op: 'eq', field: 'done', value: false })
          .collect()
        const out: Record<string, number> = { low: 0, normal: 0, high: 0 }
        for (const row of rows) {
          out[String(row.priority)] = (out[String(row.priority)] ?? 0) + 1
        }
        return out
      },
    ),

    // the RUNNABLE ops: the built-in list pipeline as one `yield*` inside a custom action —
    // the author owns the route, the envelope (`total` survives, it is THIS schema) and the
    // errors; `scope` AND-s a trusted filter under whatever the client sends
    open: action.query(
      {
        input: crud.schemas.listInput,
        output: crud.schemas.page(todosTable).extend({ total: z.number() }),
        errors: crud.errors,
        description: 'Open todos only, with the set total (`crud.list` in a custom action)',
      },
      function* ({ input }) {
        return yield* crud.list(todosTable, {
          input,
          scope: where.eq('done', false),
          total: true,
        })
      },
    ),
  },

  // per-op options: the tag the `around` guard raises answers 423 on REMOVE alone — no other
  // built-in advertises (or maps) it
  ops: { remove: { errors: guard.statuses } },

  // runs ONCE while `crud()` builds the service (definition time, never per request): the
  // create INPUT demands a real title beyond what the column kind gives it — and the reshape
  // lands in the TYPES, so the typed client demands it too
  schema: {
    create: s => s.extend({ title: z.string().min(3) }),
  },

  // `op` narrows the input: the write ops are the ones that carry a title
  *before(call) {
    if (call.op === 'create' || call.op === 'update' || call.op === 'replace') {
      const { title } = call.input

      if (typeof title === 'string') {
        return { ...call.input, title: title.trim() }
      }
    }
  },

  *after(call) {
    if (call.op === 'list') {
      return { ...call.output, data: call.output.data.map(shout) }
    }

    if (call.op === 'get') {
      return shout(call.output)
    }

    if (call.op === 'watch') {
      const frame = call.output

      if (frame.t === 'sync') {
        return { ...frame, rows: frame.rows.map(shout) }
      }

      if (frame.t === 'delta') {
        return { ...frame, added: frame.added.map(shout), changed: frame.changed.map(shout) }
      }
    }
  },

  *around(call, next) {
    const { ctx, input } = call

    if (call.op === 'remove') {
      const row = yield* (yield* useDb(schema)).get('todos', call.input.id)
      if (row && String(row.title).includes('[keep]')) {
        return yield* guard.protected('protected todo — remove [keep] from the title first')
      }
      const out = yield* next(input)
      // a DOMAIN record: free-form audit shipped by exporters (OpenObserve `streams.domain`),
      // never stored in the observe db — `ctx.auth` says who did it (socket or http alike)
      yield* Server.actions.report({
        t: 'domain',
        row: {
          stream: 'audit',
          verb: 'todo.removed',
          id: call.input.id,
          actor: ctx.auth?.sub ?? null,
        },
      })
      return out
    }
    return yield* next(input)
  },

  *error({ op, failure }) {
    return appendCauses(failure, `todos:${op}`)
  },
})
