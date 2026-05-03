import { defineAction, useCall } from 'server:core'
// oxlint-disable-next-line import/no-named-as-default
import z from 'zod'

import { add } from './add'
import { square } from './square'

export const sumOfSquares = defineAction(
  {
    title: 'sumOfSquares',
    description: 'returns a² + b² by composing square and add via useCall',

    input: z.object({
      a: z.number(),
      b: z.number(),
    }),
  },
  function* (body) {
    const sqA = yield* useCall(square, { value: body.a })
    const sqB = yield* useCall(square, { value: body.b })

    return yield* useCall(add, { a: sqA, b: sqB })
  },
)
