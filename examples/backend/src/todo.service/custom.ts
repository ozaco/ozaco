import { each } from 'std:effect'

import { Rest, Ws } from 'server:core'
import { defineAction } from 'server:service'
// oxlint-disable-next-line import/no-named-as-default
import z from 'zod'

export const custom = defineAction(
  {
    title: 'Custom Todo Method',
    description: 'reachable over HTTP POST and WebSocket messages',

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
        files: ['avatar', 'document'],
      }),
      Ws.actions.settings({
        path: '/custom',
      }),
    ],
  },

  function* (ctx) {
    for (const [key, entries] of Object.entries(ctx.files)) {
      for (const file of entries) {
        console.log(key, file.name, file.type, file.size, file.lastModified)

        const chunks = yield* each(file.stream)
        for (const chunk of chunks) {
          console.log(key, chunk.byteLength)

          yield* each.next()
        }
      }
    }

    console.log(`custom: via ${ctx.type}`, ctx.body)

    return ctx.body
  },
)
