import { Rest, defineAction, useRequest } from 'server:core'
import { each } from 'std:effect'
import { fail } from 'std:result'

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

  function* (body) {
    const req = yield* useRequest()
    if (!req.rawBody) {
      return yield* fail('unexpected', 'send files')
    }

    const chunks = yield* each(req.rawBody)
    for (const chunk of chunks) {
      decoder.decode(chunk)

      yield* each.next()
    }

    return body
  },
)
