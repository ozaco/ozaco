import type { AccessGuard } from 'server:wizard'
import { useDatabase } from 'server:wizard'
import { operation } from 'std:effect'

import { tasks } from './schema'

/**
 * The operation-based half of access (`defineCrud`'s `{ access }`): one guard per namespace, branching
 * on `ctx.op` (the function name — `list` / `get` / `create` / `update` / `remove`). A guard returns a
 * boolean OR, since it runs in the action's effect scope, an `Operation<boolean>` that can `yield*`
 * `useDatabase(...)` lookups or `useAuth(...)`. Returning (or resolving to) `false` rejects with 403.
 */
export const access: Record<string, AccessGuard> = {
  // reads + writes ok; projects are never deleted through the API
  projects: ctx => {
    if (ctx.op === 'remove') {
      return false
    }
    return true
  },

  tasks: ctx => ctx.op !== 'remove',

  // effect-native guard: a comment may only be created against a task that actually exists.
  // `useDatabase([tasks])` types the handle to just the tasks table.
  comments: operation(function* (ctx) {
    if (ctx.op === 'remove') {
      return false
    }
    if (ctx.op === 'create') {
      const db = yield* useDatabase([tasks])
      const task = yield* db.get('tasks', String(ctx.args.taskId ?? ''))
      return task !== null
    }
    return true
  }),
}
