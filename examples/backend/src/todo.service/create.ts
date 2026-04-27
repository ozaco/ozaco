import { RestTransformer, defineAction } from 'server:core'
import { useContext } from 'std:effect'
import { fail } from 'std:result'

import { DB } from '@ozaco/db'
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

    settings: [RestTransformer.actions.settings({ method: 'POST', path: '/create' })],
  },
  function* (ctx) {
    const session = yield* useAuth(AccessRefreshAuth, ctx.req)
    if (!session.permissions.includes('todo:create')) {
      return yield* fail('forbidden', 'missing permission todo:create')
    }

    const db = yield* useContext(DB)
    const row = yield* db
      .insert(todos)
      .values({
        id: crypto.randomUUID(),
        userId: session.user.id,
        title: ctx.body.title,
        completed: false,
      })
      .returning()
      .firstOrFail()

    return { id: row.id, title: row.title, completed: row.completed }
  },
)
