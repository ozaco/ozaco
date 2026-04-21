import { definePlugin } from 'std:plugin'

import { Rest, RestTransformer, Router } from 'server:core'
import { defineAction } from 'server:service'

const optionsHandler = defineAction(
  {
    settings: [
      RestTransformer.actions.settings({
        method: 'OPTIONS',
        path: '/**',
      }),
    ],
  },
  function* () {},
)

export const CustomCorsPlugin = definePlugin({
  name: 'cors',
  version: '0.0.0',
  *setup(options?: {
    origin?: '*' | string[] | undefined
    methods?: string[] | undefined
    headers?: string[] | undefined
    maxAge?: string | undefined
  }) {
    yield* Router.actions.mount('', optionsHandler)

    const normalized = {
      origin: options?.origin === '*' ? ['*'] : (options?.origin ?? ['*']),
      methods: options?.methods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      headers: options?.headers ?? ['Authorization', 'Content-Type', 'Accept', 'X-Requested-With'],
      maxAge: options?.maxAge ?? '86400',
    }

    yield* Rest.after({
      // oxlint-disable-next-line require-yield
      *fromInternal(r: Response) {
        r.headers.set('Access-Control-Allow-Origin', normalized.origin.join(', '))
        r.headers.set('Access-Control-Allow-Methods', normalized.methods.join(', '))
        r.headers.set('Access-Control-Allow-Headers', normalized.headers.join(', '))
        r.headers.set('Access-Control-Max-Age', normalized.maxAge)

        return r
      },
    })
  },
}).build({})
