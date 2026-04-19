import { each } from 'std:effect'
import { fail } from 'std:result'

import { Rest } from 'server:core'
import { defineAction } from 'server:service'

const decoder = new TextDecoder()

export const rawFile = defineAction(
  {
    title: 'Raw File Method',
    description: 'test',

    settings: [
      Rest.actions.settings({
        method: 'POST',
        path: '/raw-file',
      }),
    ],
  },

  function* (ctx) {
    if (!ctx.request.rawBody) {
      return yield* fail('unexpected', 'send files')
    }

    const chunks = yield* each(ctx.request.rawBody)
    for (const chunk of chunks) {
      decoder.decode(chunk)

      yield* each.next()
    }

    return ctx.body
  },
)
