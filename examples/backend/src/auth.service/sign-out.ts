import { RestTransformer, defineAction } from 'server:core'
import { AccessRefreshAuth } from 'server:plugin/auth'
// oxlint-disable-next-line import/no-named-as-default
import z from 'zod'

export const signOut = defineAction(
  {
    title: 'Sign Out',
    description: 'revoke the given refresh token',

    input: z.object({ refreshToken: z.string() }),

    settings: [RestTransformer.actions.settings({ method: 'POST', path: '/sign-out' })],
  },
  function* (ctx) {
    yield* AccessRefreshAuth.actions.signOut(ctx.body.refreshToken)
    return { ok: true }
  },
)
