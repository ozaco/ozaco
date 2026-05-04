import { operation } from 'std:effect'
import { fail } from 'std:result'

import { AuthErrorCode } from '../error-codes'
import type { AuthProvider, AuthUser } from '../types'

import { AuthProviderRef } from './contexts'

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

export const parseDuration = operation(function* (value: string | number) {
  if (typeof value === 'number') {
    return value
  }

  const trimmed = value.trim()
  const match = /^(\d+)\s*(ms|s|m|h|d|w)?$/.exec(trimmed)
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
  return provider as AuthProvider
})

export const collectAuthz = operation(function* (provider: AuthProvider, user: AuthUser) {
  const roles = provider.getRoles ? ((yield* provider.getRoles(user)) ?? []) : []
  const permissions = provider.getPermissions ? ((yield* provider.getPermissions(user)) ?? []) : []
  return { roles, permissions }
})
