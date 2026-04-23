import { Rest } from 'server:core'
import { AccessRefreshAuth, useAuth } from 'server:plugin/auth'
import { defineAction } from 'server:service'

export const me = defineAction(
  {
    title: 'Me',
    description: 'returns the current session',

    settings: [Rest.actions.settings({ method: 'GET', path: '/me' })],
  },
  function* (ctx) {
    return yield* useAuth(AccessRefreshAuth, ctx.req)
  },
)
