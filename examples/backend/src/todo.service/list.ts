import { RestTransformer, defineAction } from 'server:core'
import { useContext } from 'std:effect'

import { DB } from '@ozaco/db'
import { AccessRefreshAuth, useAuth } from 'server:plugin/auth'

import { todos } from '../db.schema'

export const list = defineAction(
  {
    title: 'List Todos',
    description: 'lists todos for the authenticated user',

    settings: [RestTransformer.actions.settings({ method: 'GET', path: '/list' })],
  },
  function* (ctx) {
    const session = yield* useAuth(AccessRefreshAuth, ctx.req)
    const db = yield* useContext(DB)
    return yield* db.from(todos).where({ userId: session.user.id }).all()
  },
)
