import { fail } from 'std:result'

import { defineAction } from 'server:service'
// oxlint-disable-next-line import/no-named-as-default
import z from 'zod'

export const get = defineAction(
  {
    input: z.object({
      id: z.string(),
    }),
  },
  function* (ctx) {
    if (!ctx.body.id) {
      return yield* fail('not-found', `todo ${ctx.body.id} not found`)
    }

    return `Todo: #${ctx.body.id}` as const
  },
)
