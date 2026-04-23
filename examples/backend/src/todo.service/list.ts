import { useContext } from 'std:effect'

import { DB } from '@ozaco/db'
import { Rest } from 'server:core'
import { AccessRefreshAuth, authorizeBearer } from 'server:plugin/auth'
import { defineAction } from 'server:service'

import { todos } from '../db.schema'

export const list = defineAction(
  {
    title: 'List Todos',
    description: 'lists todos for the authenticated user',

    settings: [Rest.actions.settings({ method: 'GET', path: '/list' })],
  },
  function* (ctx) {
    const session = yield* authorizeBearer(AccessRefreshAuth)(ctx.req)
    const db = yield* useContext(DB)
    return yield* db.from(todos).where({ userId: session.user.id }).all()
  },
)
