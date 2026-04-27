import { Rest, defineAction } from 'server:core'

import { AccessRefreshAuth } from 'server:plugin/auth'
// oxlint-disable-next-line import/no-named-as-default
import z from 'zod'

export const signIn = defineAction(
  {
    title: 'Sign In',
    description: 'authenticate with email + password',

    input: z.object({
      email: z.string(),
      password: z.string(),
    }),

    settings: [Rest.actions.settings({ method: 'POST', path: '/sign-in' })],
  },
  function* (ctx) {
    return yield* AccessRefreshAuth.actions.signIn(ctx.body)
  },
)
