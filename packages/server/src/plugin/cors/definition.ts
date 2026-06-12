import { Gateway } from 'server:core'
import { useContext } from 'std:effect'
import { definePlugin } from 'std:plugin'

import { applyCorsHeaders } from './internal/apply'
import { CorsCtxRef, normalizeOptions, preflightAction } from './internal/utils'
import type { CorsDef } from './types'

export const Cors = definePlugin({
  name: 'server/plugin-cors',
  version: '0.0.0',
  description: 'Cross-Origin Resource Sharing',

  *setup(options?: CorsDef.Options) {
    const ctx = normalizeOptions(options)
    yield* CorsCtxRef.set(ctx)

    yield* Gateway.actions.mount('', preflightAction)

    yield* Gateway.before({
      *fromInternal(args: CorsDef.FromInternalArgs) {
        const cors = yield* useContext(CorsCtxRef)
        const req = args[0]
        const res = args[1]
        if (!res) {
          return
        }

        const origin = req?.meta.origin ?? req?.meta.Origin
        applyCorsHeaders(res.meta, cors, origin)

        if (req?.method === 'OPTIONS' && res.status === null) {
          res.status = cors.preflightStatus
        }
      },
    })

    return ctx
  },
}).build({})
