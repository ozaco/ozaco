import { operation } from 'std:effect'
import { fail } from 'std:result'

import { AuthErrorCode } from '../error-codes'
import type { AuthDef } from '../types'

import { UNITS } from './const'
import { AuthProviderRef } from './contexts'

export const parseDuration = operation(function* (value: string | number) {
  if (typeof value === 'number') {
    return value
  }

  const trimmed = value.trim()
  const match = /^(\d+)\s*(ms|s|m|h|d|w)?$/u.exec(trimmed)
  if (!match) {
    return yield* fail(AuthErrorCode.InvalidDuration, `invalid duration: "${value}"`)
  }

  const n = Number(match[1])
  const unit = match[2] ?? 'ms'
  return n * UNITS[unit]!
}, 'parse-duration')

export const getProvider = operation(function* () {
  const provider = yield* AuthProviderRef.get()
  if (!provider) {
    return yield* fail(
      AuthErrorCode.NotProvided,
      'Auth provider not configured. Call Auth.actions.provide(...) first.',
    )
  }
  return provider as AuthDef.Provider
})

export const collectAuthz = operation(function* (provider: AuthDef.Provider, user: AuthDef.User) {
  const roles = provider.getRoles ? ((yield* provider.getRoles(user)) ?? []) : []
  const permissions = provider.getPermissions ? ((yield* provider.getPermissions(user)) ?? []) : []
  return { roles, permissions }
})
