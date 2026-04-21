import { AccessRefreshAuth } from 'server:auth'
import { Rest } from 'server:core'
import { defineAction } from 'server:service'
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
