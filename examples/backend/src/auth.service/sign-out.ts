import { Rest, defineAction } from 'server:core'

import { AccessRefreshAuth } from 'server:plugin/auth'
// oxlint-disable-next-line import/no-named-as-default
import z from 'zod'

export const signOut = defineAction(
  {
    title: 'Sign Out',
    description: 'revoke the given refresh token',

    input: z.object({ refreshToken: z.string() }),

    settings: [Rest.actions.settings({ method: 'POST', path: '/sign-out' })],
  },
  function* (body) {
    yield* AccessRefreshAuth.actions.signOut(body.refreshToken)
    return { ok: true }
  },
)
