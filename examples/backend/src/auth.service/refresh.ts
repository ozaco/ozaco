import { Rest, defineAction } from 'server:core'

import { AccessRefreshAuth } from 'server:plugin/auth'
// oxlint-disable-next-line import/no-named-as-default
import z from 'zod'

export const refresh = defineAction(
  {
    title: 'Refresh',
    description: 'exchange refresh token for a new token pair',

    input: z.object({ refreshToken: z.string() }),

    settings: [Rest.actions.settings({ method: 'POST', path: '/refresh' })],
  },
  function* (ctx) {
    return yield* AccessRefreshAuth.actions.refresh(ctx.body.refreshToken)
  },
)
