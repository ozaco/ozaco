import { each } from 'std:effect'

import { Rest } from 'server:core'
import { defineAction } from 'server:service'
// oxlint-disable-next-line import/no-named-as-default
import z from 'zod'

export const custom = defineAction(
  {
    title: 'Custom Todo Method',
    description: 'test',

    input: z.object({
      id: z.string(),
      title: z.string(),
    }),
    output: z.object({
      id: z.string(),
    }),

    settings: [
      Rest.actions.settings({
        method: 'POST',
        path: '/custom',
      }),
    ],
  },
  function* (ctx) {
    console.log(ctx.request.rawBody, 'here')

    if (ctx.request.rawBody) {
      const chunks = yield* each(ctx.request.rawBody)

      for (const chunk of chunks) {
        console.log(chunk)
      }
    }

    return ctx.body
  },
)
