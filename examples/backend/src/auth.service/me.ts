import { RestTransformer, defineAction } from 'server:core'
import { AccessRefreshAuth, useAuth } from 'server:plugin/auth'

export const me = defineAction(
  {
    title: 'Me',
    description: 'returns the current session',

    settings: [RestTransformer.actions.settings({ method: 'GET', path: '/me' })],
  },
  function* (ctx) {
    return yield* useAuth(AccessRefreshAuth, ctx.req)
  },
)
