import { useContext } from 'std:effect'
import { definePlugin } from 'std:plugin'

import { Rest, Router } from 'server:core'
import type { ActionRequest, ActionResponse } from 'server:service'

import { applyCorsHeaders } from './internal/apply'
import { CorsCtxRef } from './internal/contexts'
import { normalizeOptions } from './internal/normalize'
import { preflightAction } from './internal/preflight'
import type { CorsOptions } from './types'

type FromInternalArgs = [ActionRequest | null, ActionResponse | null, unknown, unknown]

export const Cors = definePlugin({
  name: 'cors',
  version: '0.0.1',
  description: 'Cross-Origin Resource Sharing',

  *setup(options?: CorsOptions) {
    const ctx = normalizeOptions(options)
    yield* CorsCtxRef.set(ctx)

    yield* Router.actions.mount('', preflightAction)

    yield* Rest.before({
      *fromInternal(args: FromInternalArgs) {
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
