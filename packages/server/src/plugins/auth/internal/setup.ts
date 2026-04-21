import { operation } from 'std:effect'
import { createEvent } from 'std:event'
import { fail } from 'std:result'

import type { BaseAuthOptions } from '../types'

import { DEFAULT_ALGORITHM, DEFAULT_VERIFICATION_TTL } from './const'
import { AuthBaseCtxRef, AuthEventsRef, AuthProviderRef, AuthSecretRef } from './contexts'
import { parseDuration } from './duration'

export const initializeBaseAuth = operation(function* (options: BaseAuthOptions) {
  if (!options.secret) {
    return yield* fail('unexpected', 'Auth requires a non-empty secret')
  }

  const ctx = {
    issuer: options.issuer ?? null,
    audience: options.audience ?? null,
    algorithm: options.algorithm ?? DEFAULT_ALGORITHM,
    verificationTTL: yield* parseDuration(
      options.verification?.expiresIn ?? DEFAULT_VERIFICATION_TTL,
    ),
  }

  yield* AuthBaseCtxRef.set(ctx)
  yield* AuthSecretRef.set(new TextEncoder().encode(options.secret))
  yield* AuthProviderRef.set(null)
  yield* AuthEventsRef.set(createEvent())

  return ctx
})
