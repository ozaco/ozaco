import { operation } from 'std:effect'
import { fail } from 'std:result'

import type { AuthProvider } from '../types'

import { AuthProviderRef } from './contexts'

export const getProvider = operation(function* () {
  const provider = yield* AuthProviderRef.get()
  if (!provider) {
    return yield* fail(
      'not-provided',
      'Auth provider not configured. Call Auth.actions.provide(...) first.',
    )
  }
  return provider as AuthProvider
})
