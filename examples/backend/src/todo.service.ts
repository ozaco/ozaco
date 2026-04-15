import { fail } from 'std:result'

import { defineAction, defineService } from 'server:service'

// oxlint-disable-next-line import/no-named-as-default
import z from 'zod'

export const TodoService = defineService({
  name: 'todo',
  version: '0.0.1',
  actions: {
    get: defineAction(function* <T extends string>(id?: T) {
      if (!id) {
        return yield* fail('not-found', `todo ${id} not found`)
      }

      return `Todo: #${id}` as const
    }),

    add: defineAction(
      {
        input: z.string(),
        output: z.number(),
      },
      // oxlint-disable-next-line require-yield
      function* (_ctx) {
        return _ctx
      },
    ),
  },

  // oxlint-disable-next-line require-yield
  *setup() {
    console.log('todo: up')
  },
})
