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
import { action, ServerErrors } from '@ozaco/server'
import { crud } from '@ozaco/server/plugins'
import { appendCauses, fail } from '@ozaco/std/result'
import type { AnyType } from '@ozaco/std/shared'
import { z } from 'zod'

import { todosTable } from '../tables'

const WRITES = new Set(['create', 'update', 'replace'])

/** the read projection: high-priority rows shout. */
const shout = (row: AnyType): AnyType =>
  row.priority === 'high' ? { ...row, title: String(row.title).toUpperCase() } : row

export const todos = crud(todosTable, {
  maxLimit: 100,
  auth: { read: 'any', write: 'user' },
  actions: ['realtime', 'list', 'get', 'create', 'update', 'remove'],

  extend: {
    stats: action.query(
      {
        output: z.record(z.string(), z.number()),
        cache: { ttlMs: 10_000, tags: ['todos'] },
        description: 'Open todos per priority (cached, invalidated by todos writes)',
      },
      function* ({ ctx }) {
        const rows = yield* ctx.db
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
  },

  // runs ONCE while `crud()` derives the schemas (definition time, never per request):
  // the create input demands a real title beyond what the column kind gives it
  *schema(s, of) {
    if (of === 'create') {
      return s.extend({ title: z.string().min(3) })
    }
  },

  *before({ op, input }) {
    const value = input as AnyType
    if (WRITES.has(op) && typeof value.title === 'string') {
      return { ...value, title: value.title.trim() }
    }
  },

  *after({ op, output }) {
    if (op === 'list') {
      const page = output as AnyType
      return { ...page, data: page.data.map(shout) }
    }
    if (op === 'get') {
      return shout(output)
    }
    if (op === 'watch') {
      const frame = output as AnyType
      return frame.t === 'sync'
        ? { ...frame, rows: frame.rows.map(shout) }
        : { ...frame, added: frame.added.map(shout), changed: frame.changed.map(shout) }
    }
  },

  *around({ op, input, ctx }, next) {
    if (op === 'remove') {
      const row = yield* ctx.db.get('todos', (input as AnyType).id)
      if (row && String(row.title).includes('[keep]')) {
        return yield* fail(
          ServerErrors.Forbidden,
          'protected todo — remove [keep] from the title first',
        )
      }
    }
    return yield* next(input)
  },

  *error({ op, failure }) {
    return appendCauses(failure, `todos:${op}`)
  },
})
