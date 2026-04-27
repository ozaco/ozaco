import { each } from 'std:effect'
import { fail } from 'std:result'

import { RestTransformer, defineAction } from 'server:core'

const decoder = new TextDecoder()

export const rawFile = defineAction(
  {
    title: 'Raw File Method',
    description: 'test',

    settings: [
      RestTransformer.actions.settings({
        method: 'POST',
        path: '/raw-file',
      }),
    ],
  },

  function* (ctx) {
    if (!ctx.req.rawBody) {
      return yield* fail('unexpected', 'send files')
    }

    const chunks = yield* each(ctx.req.rawBody)
    for (const chunk of chunks) {
      decoder.decode(chunk)

      yield* each.next()
    }

    return ctx.body
  },
)
