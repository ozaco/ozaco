import { useRequest } from 'server:core'
import type { Future } from 'std:effect'
import { operation } from 'std:effect'
import { fail } from 'std:result'

import { AuthErrorCode } from '../error-codes'
import type { AuthSession } from '../types'

const BEARER_PREFIX = 'Bearer '

interface AuthorizableStrategy {
  actions: { authorize: (token: string) => Future<AuthSession, unknown> }
}

const getBearerToken = operation(function* () {
  const req = yield* useRequest()
  const header = req.meta.authorization ?? req.meta.Authorization
  if (!header?.startsWith(BEARER_PREFIX)) {
    return yield* fail(AuthErrorCode.MissingToken, 'Bearer token required')
  }
  return header.slice(BEARER_PREFIX.length)
})

const useAuth = operation(function* <T extends AuthorizableStrategy>(strategy: T) {
  const token = yield* getBearerToken()

  return yield* strategy.actions.authorize(token)
})

export { getBearerToken, useAuth }
