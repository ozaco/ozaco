import { AccessRefreshAuth } from 'server:auth'
import { Rest } from 'server:core'
import { defineAction } from 'server:service'
// oxlint-disable-next-line import/no-named-as-default
import z from 'zod'

export const signOut = defineAction(
  {
    title: 'Sign Out',
    description: 'revoke the given refresh token',

    input: z.object({ refreshToken: z.string() }),

    settings: [Rest.actions.settings({ method: 'POST', path: '/sign-out' })],
  },
  function* (ctx) {
    yield* AccessRefreshAuth.actions.signOut(ctx.body.refreshToken)
    return { ok: true }
  },
)
