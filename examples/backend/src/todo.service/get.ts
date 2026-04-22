import { useContext } from 'std:effect'
import { fail } from 'std:result'

import { DB } from '@ozaco/db'
import { AccessRefreshAuth, authorizeBearer } from 'server:auth'
import { Rest } from 'server:core'
import { defineAction } from 'server:service'
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
  function* (ctx) {
    const session = yield* authorizeBearer(AccessRefreshAuth)(ctx.req)
    const db = yield* useContext(DB)
    const row = yield* db.from(todos).where({ id: ctx.body.id }).first()

    if (!row) {
      return yield* fail('not-found', `todo ${ctx.body.id} not found`)
    }
    if (row.userId !== session.user.id && !session.roles.includes('admin')) {
      return yield* fail('forbidden', 'not your todo')
    }
    return row
  },
)
