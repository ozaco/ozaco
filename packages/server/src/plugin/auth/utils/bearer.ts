import { useRequest } from 'server:core'
import { operation } from 'std:effect'
import { fail } from 'std:result'

import { AuthErrorCode } from '../error-codes'
import { BEARER_PREFIX } from '../internal/const'
import type { AuthDef } from '../types'

const getBearerToken = operation(function* () {
  const req = yield* useRequest()
  const header = req.meta.authorization ?? req.meta.Authorization
  if (!header?.startsWith(BEARER_PREFIX)) {
    return yield* fail(AuthErrorCode.MissingToken, 'Bearer token required')
  }
  return header.slice(BEARER_PREFIX.length)
})

const useAuth = operation(function* <T extends AuthDef.Strategy>(strategy: T) {
  const token = yield* getBearerToken()

  return yield* strategy.actions.authorize(token)
})

export { getBearerToken, useAuth }
