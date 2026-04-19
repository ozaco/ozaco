import { defineAction } from 'server:service'
// oxlint-disable-next-line import/no-named-as-default
import z from 'zod'

export const create = defineAction(
  {
    title: 'Add Todo',
    description: 'adds new todo',

    input: z.object({
      id: z.string(),
    }),
    output: z.object({
      id: z.string(),
    }),
  },
  // oxlint-disable-next-line require-yield
  function* (ctx) {
    return ctx.body
  },
)
