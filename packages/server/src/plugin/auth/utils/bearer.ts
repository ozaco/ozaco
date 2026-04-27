import type { Future } from 'std:effect'
import { operation } from 'std:effect'
import { fail } from 'std:result'

import type { ActionRequest } from 'server:core'

import type { AuthSession } from '../types'

const BEARER_PREFIX = 'Bearer '

interface AuthorizableStrategy {
  actions: { authorize: (token: string) => Future<AuthSession, unknown> }
}

const getBearerToken = operation(function* (req: ActionRequest) {
  const header = req.meta.authorization ?? req.meta.Authorization
  if (!header?.startsWith(BEARER_PREFIX)) {
    return yield* fail('missing-token', 'Bearer token required')
  }
  return header.slice(BEARER_PREFIX.length)
})

const useAuth = operation(function* <T extends AuthorizableStrategy>(
  strategy: T,
  req: ActionRequest,
) {
  const token = yield* getBearerToken(req)

  return yield* strategy.actions.authorize(token)
})

export { getBearerToken, useAuth }
