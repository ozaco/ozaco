import { DB } from 'db:core'
import { Rest, defineAction } from 'server:core'
import { useContext } from 'std:effect'
import { fail } from 'std:result'

import { AccessRefreshAuth, useAuth } from 'server:plugin/auth'
// oxlint-disable-next-line import/no-named-as-default
import z from 'zod'

import { todos } from '../db.schema'

export const create = defineAction(
  {
    title: 'Add Todo',
    description: 'adds new todo for the authenticated user',

    input: z.object({
      title: z.string().min(1),
    }),
    output: z.object({
      id: z.string(),
      title: z.string(),
      completed: z.boolean(),
    }),

    settings: [Rest.actions.settings({ method: 'POST', path: '/create' })],
  },
  function* (body) {
    const session = yield* useAuth(AccessRefreshAuth)
    if (!session.permissions.includes('todo:create')) {
      return yield* fail('forbidden', 'missing permission todo:create')
    }

    const db = yield* useContext(DB)
    const row = yield* db
      .insert(todos)
      .values({
        id: crypto.randomUUID(),
        userId: session.user.id,
        title: body.title,
        completed: false,
      })
      .returning()
      .firstOrFail()

    return { id: row.id, title: row.title, completed: row.completed }
  },
)
