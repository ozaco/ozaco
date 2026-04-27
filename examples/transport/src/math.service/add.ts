import { defineAction, Transport } from 'server:core'
// oxlint-disable-next-line import/no-named-as-default
import z from 'zod'

export const add = defineAction(
  {
    title: 'add',
    description: 'returns a + b',

    input: z.object({
      a: z.number(),
      b: z.number(),
    }),
    settings: [Transport.actions.settings()],
  },
  // oxlint-disable-next-line require-yield
  function* (ctx) {
    console.log('worker:', process.env.id)

    return ctx.body.a + ctx.body.b
  },
)
