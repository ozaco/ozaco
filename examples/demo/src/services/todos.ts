/**
 * Todos: a crud RESOURCE (list / get / create / update / replace / remove under `/todos`, with
 * `If-Match` optimistic concurrency) plus its realtime socket (`/todos/_realtime`, delta
 * watches) — all from `crud(table)`; and a `stats` action beside it.
 */
import { action, service } from '@ozaco/server'
import { crud } from '@ozaco/server/plugins'
import { z } from 'zod'

import { todosTable } from '../tables'

export const todos = crud(todosTable, {
  maxLimit: 100,
  auth: { read: 'any', write: 'user' },
})

export const todoStats = service(
  'todo-stats',
  {
    byPriority: action.query(
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
  { version: '1.0.0', description: 'Aggregates over the todos resource' },
)
