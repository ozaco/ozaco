import { fail } from 'std:result'

import { DefaultRouter, Router } from 'server:core'
import { defineAction, defineService, useSelf } from 'server:service'
// oxlint-disable-next-line import/no-named-as-default
import z from 'zod'

export const TodoService = defineService({
  name: 'todo',
  version: '0.0.1',
  actions: {
    get: defineAction(
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
    ),

    create: defineAction(
      {
        title: 'Add Todo',
        description: 'adds new todo',

        input: z.object({
          id: z.string(),
        }),
        output: z.object({
          id: z.string(),
        }),

        settings: {
          [DefaultRouter]: {
            method: 'POST',
            path: '/create',
          },
        },
      },
      // oxlint-disable-next-line require-yield
      function* (ctx) {
        return ctx.body
      },
    ),
  },

  *setup() {
    yield* Router.actions.mount('/todo', yield* useSelf())

    console.log('todo: up')
  },
})
