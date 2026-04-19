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
  // oxlint-disable-next-line require-yield
  function* (ctx) {
    return ctx.body
  },
)
