import { doc, query, resource, useDatabase, withAccess } from 'server:wizard'
import { operation } from 'std:effect'

import { z } from 'zod'

import { access } from './access'
import {
  comments as commentsTable,
  projects as projectsTable,
  tables,
  tasks as tasksTable,
} from './schema'

// A reusable custom-access wrapper (the "wrapper" half of access): reject unless the target task
// exists. `useDatabase([tasksTable])` types the handle to just the tasks table.
const requireTask = withAccess(
  operation(function* (ctx) {
    const db = yield* useDatabase([tasksTable])
    const task = yield* db.get('tasks', String(ctx.args.id ?? ''))
    return task !== null
  }),
)

// A custom MUTATION — first-class next to crud, not a separate hand-written service.
const complete = requireTask.mutation({
  args: z.object({ id: z.string() }),
  returns: doc(tasksTable),
  *handler(body) {
    const db = yield* useDatabase([tasksTable])
    return yield* db.patch('tasks', body.id, { status: 'done' })
  },
})

// A custom QUERY with a `returns` validator. `useDatabase(tables)` types the handle to all three
// tables. No target → re-runs on any write.
const summary = query({
  returns: z.object({ projects: z.number(), tasks: z.number(), comments: z.number() }),
  *handler() {
    const db = yield* useDatabase(tables)
    return {
      projects: yield* db.query('projects').count(),
      tasks: yield* db.query('tasks').count(),
      comments: yield* db.query('comments').count(),
    }
  },
})

// Each resource takes a standalone table directly (no `schema.tables.x`); `{ type: 'crud' }` gives
// the standard REST collection + live deltas in the same namespace. Custom fns go in `actions`.
// Installing a resource registers and mounts its native service and serves its own `/<ns>/_realtime`.
export const projects = resource(projectsTable, { type: 'crud', access: access.projects })

export const tasks = resource(tasksTable, {
  type: 'crud',
  access: access.tasks,
  actions: { complete },
})

export const comments = resource(commentsTable, { type: 'crud', access: access.comments })

export const stats = resource('stats', { summary })
