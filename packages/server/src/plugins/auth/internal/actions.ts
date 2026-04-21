import { operation, useContext } from 'std:effect'
import { fail } from 'std:result'

import type { AuthProvider, AuthSession, VerificationRecord } from '../types'

import { AuthBaseCtxRef, AuthEventsRef, AuthProviderRef } from './contexts'
import { parseDuration } from './duration'
import { randomToken } from './jwt'
import { getProvider } from './provider'
import { decodePrincipalToken } from './tokens'

export const provideAction = operation(function* (provider: AuthProvider) {
  yield* AuthProviderRef.set(provider)
})

export const eventsAction = operation(function* () {
  return yield* useContext(AuthEventsRef)
})

export const buildAuthorize = (expectedType: string) =>
  operation(function* (token: string) {
    const events = yield* useContext(AuthEventsRef)
    const session = yield* decodePrincipalToken(token, expectedType)
    events.emit('authorized', session)
    return session
  })

// oxlint-disable-next-line require-yield
export const hasRoleAction = operation(function* (session: AuthSession, role: string) {
  return session.roles.includes(role)
})

// oxlint-disable-next-line require-yield
export const hasPermissionAction = operation(function* (session: AuthSession, permission: string) {
  return session.permissions.includes(permission)
})

export const requireRoleAction = operation(function* (session: AuthSession, role: string) {
  if (!session.roles.includes(role)) {
    const events = yield* useContext(AuthEventsRef)
    events.emit('denied', 'forbidden', `missing role: ${role}`)
    return yield* fail('forbidden', `missing role: ${role}`)
  }
})

export const requirePermissionAction = operation(function* (
  session: AuthSession,
  permission: string,
) {
  if (!session.permissions.includes(permission)) {
    const events = yield* useContext(AuthEventsRef)
    events.emit('denied', 'forbidden', `missing permission: ${permission}`)
    return yield* fail('forbidden', `missing permission: ${permission}`)
  }
})

export const issueVerificationAction = operation(function* (
  userId: string,
  purpose: string,
  ttl?: string | number,
) {
  const provider = yield* getProvider()
  const ctx = yield* useContext(AuthBaseCtxRef)

  if (!provider.saveVerification) {
    return yield* fail('not-provided', 'provider does not expose saveVerification')
  }

  const token = yield* randomToken(32)
  const lifetime = ttl === undefined ? ctx.verificationTTL : yield* parseDuration(ttl)
  const record: VerificationRecord = {
    token,
    userId,
    purpose,
    expiresAt: Date.now() + lifetime,
    consumedAt: null,
  }

  yield* provider.saveVerification(record)
  return token
})

export const confirmVerificationAction = operation(function* (token: string, purpose: string) {
  const provider = yield* getProvider()
  const events = yield* useContext(AuthEventsRef)

  if (!provider.findVerification || !provider.consumeVerification) {
    return yield* fail('not-provided', 'provider does not expose verification hooks')
  }

  const record = yield* provider.findVerification(token)
  if (!record) {
    return yield* fail('invalid-token', 'verification token not found')
  }
  if (record.consumedAt) {
    return yield* fail('verification-consumed', 'verification already consumed')
  }
  if (record.expiresAt < Date.now()) {
    return yield* fail('expired-token', 'verification expired')
  }
  if (record.purpose !== purpose) {
    return yield* fail('invalid-token', 'verification purpose mismatch')
  }

  yield* provider.consumeVerification(token)
  events.emit('verified', record.userId, purpose)

  return record.userId
})

export const ssoAuthorizeAction = operation(function* (providerName: string) {
  const provider = yield* getProvider()
  const sso = provider.ssoProviders?.[providerName]
  if (!sso) {
    return yield* fail('unknown-provider', `SSO provider "${providerName}" not configured`)
  }

  const state = yield* randomToken(24)
  const url = yield* sso.authorize(state)

  return { url, state }
})
