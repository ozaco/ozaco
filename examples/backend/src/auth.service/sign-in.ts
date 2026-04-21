import { AccessRefreshAuth } from 'server:auth'
import { Rest } from 'server:core'
import { defineAction } from 'server:service'
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
