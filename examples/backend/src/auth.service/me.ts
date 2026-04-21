import { AccessRefreshAuth, authorizeBearer } from 'server:auth'
import { Rest } from 'server:core'
import { defineAction } from 'server:service'

export const me = defineAction(
  {
    title: 'Me',
    description: 'returns the current session',

    settings: [Rest.actions.settings({ method: 'GET', path: '/me' })],
  },
  function* (ctx) {
    return yield* authorizeBearer(AccessRefreshAuth)(ctx.req)
  },
)
