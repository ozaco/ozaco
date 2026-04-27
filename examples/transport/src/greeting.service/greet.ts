import { defineAction, Rest, Transport, useCall } from 'server:core'

// oxlint-disable-next-line import/no-named-as-default
import z from 'zod'

import { MathService } from '../math.service'

export const greet = defineAction(
  {
    title: 'greet',
    description: 'returns a + b',

    input: z.object({
      name: z.string(),
    }),

    settings: [
      Rest.actions.settings({
        method: 'GET',
        path: '/:name',
      }),
      Transport.actions.settings(),
    ],
  },
  function* (ctx) {
    console.log('worker:', process.env.id)

    const added = yield* useCall(MathService.actions.add, {
      a: 1,
      b: 2,
    })

    return `Hi ${ctx.body.name} ${added}`
  },
)
