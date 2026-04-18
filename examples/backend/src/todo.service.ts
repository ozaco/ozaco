import { fail } from 'std:result'

import { Router } from 'server:core'
import { defineAction, defineService, useSelf } from 'server:service'
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
        title: 'Add Todo',
        description: 'adds new todo',

        input: z.string(),
        output: z.number(),
      },
      // oxlint-disable-next-line require-yield
      function* (ctx) {
        return ctx.body
      },
    ),
  },

  *setup() {
    const self = yield* useSelf()
    yield* Router.actions.mount('/todo', self)

    console.log('todo: up')
  },
})
