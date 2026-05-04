import { defineAction } from 'server:core'
// oxlint-disable-next-line import/no-named-as-default
import z from 'zod'

export const square = defineAction(
  {
    title: 'square',
    description: 'returns value * value',

    input: z.object({
      value: z.number(),
    }),
  },

  function* (body) {
    return body.value * body.value
  },
)
