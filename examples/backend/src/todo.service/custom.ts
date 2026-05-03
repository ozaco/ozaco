import { Rest, Ws, defineAction, useRequest } from 'server:core'
import { each } from 'std:effect'
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

  function* (body) {
    const req = yield* useRequest()

    for (const [key, entries] of Object.entries(req.files)) {
      for (const file of entries) {
        console.log(key, file.name, file.type, file.size, file.lastModified)

        const chunks = yield* each(file.stream)
        for (const chunk of chunks) {
          console.log(key, chunk.byteLength)

          yield* each.next()
        }
      }
    }

    console.log(`custom: via ${req.type}`, body)

    return body
  },
)
