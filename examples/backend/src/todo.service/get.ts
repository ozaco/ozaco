import { DB } from 'db:core'
import { Rest, defineAction } from 'server:core'
import { useContext } from 'std:effect'
import { fail } from 'std:result'

import { AccessRefreshAuth, useAuth } from 'server:plugin/auth'
// oxlint-disable-next-line import/no-named-as-default
import z from 'zod'

import { todos } from '../db.schema'

export const get = defineAction(
  {
    title: 'Get Todo',
    description: 'fetches a todo owned by the authenticated user',

    input: z.object({
      id: z.string(),
    }),

    settings: [Rest.actions.settings({ method: 'POST', path: '/get' })],
  },
  function* (body) {
    const session = yield* useAuth(AccessRefreshAuth)
    const db = yield* useContext(DB)
    const row = yield* db.from(todos).where({ id: body.id }).first()

    if (!row) {
      return yield* fail('not-found', `todo ${body.id} not found`)
    }
    if (row.userId !== session.user.id && !session.roles.includes('admin')) {
      return yield* fail('forbidden', 'not your todo')
    }
    return row
  },
)
