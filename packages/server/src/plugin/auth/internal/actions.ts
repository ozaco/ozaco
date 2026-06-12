import { CoreErrors } from 'server:core'
import { operation, useContext } from 'std:effect'
import { fail } from 'std:result'

import { AuthErrorCode } from '../error-codes'
import type { AuthDef } from '../types'

import { AuthBaseCtxRef, AuthEventsRef, AuthProviderRef } from './contexts'
import { getProvider, parseDuration } from './helpers'
import { randomToken } from './jwt'
import { decodePrincipalToken } from './tokens'

export const provideAction = operation(function* (provider: AuthDef.Provider) {
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

export const hasRoleAction = operation(function* (session: AuthDef.Session, role: string) {
  return session.roles?.includes(role) ?? false
})

export const hasPermissionAction = operation(function* (
  session: AuthDef.Session,
  permission: string,
) {
  return session.permissions?.includes(permission) ?? false
})

export const requireRoleAction = operation(function* (session: AuthDef.Session, role: string) {
  if (!session.roles?.includes(role)) {
    const events = yield* useContext(AuthEventsRef)
    events.emit('denied', 'forbidden', `missing role: ${role}`)
    return yield* fail(CoreErrors.Forbidden, `missing role: ${role}`)
  }
})

export const requirePermissionAction = operation(function* (
  session: AuthDef.Session,
  permission: string,
) {
  if (!session.permissions?.includes(permission)) {
    const events = yield* useContext(AuthEventsRef)
    events.emit('denied', 'forbidden', `missing permission: ${permission}`)
    return yield* fail(CoreErrors.Forbidden, `missing permission: ${permission}`)
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
    return yield* fail(AuthErrorCode.NotProvided, 'provider does not expose saveVerification')
  }

  const token = yield* randomToken(32)
  const lifetime = ttl === undefined ? ctx.verificationTTL : yield* parseDuration(ttl)
  const record: AuthDef.VerificationRecord = {
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
    return yield* fail(AuthErrorCode.NotProvided, 'provider does not expose verification hooks')
  }

  const record = yield* provider.findVerification(token)
  if (!record) {
    return yield* fail(AuthErrorCode.InvalidToken, 'verification token not found')
  }
  if (record.consumedAt) {
    return yield* fail(AuthErrorCode.VerificationConsumed, 'verification already consumed')
  }
  if (record.expiresAt < Date.now()) {
    return yield* fail(AuthErrorCode.ExpiredToken, 'verification expired')
  }
  if (record.purpose !== purpose) {
    return yield* fail(AuthErrorCode.InvalidToken, 'verification purpose mismatch')
  }

  yield* provider.consumeVerification(token)
  events.emit('verified', record.userId, purpose)

  return record.userId
})

export const ssoAuthorizeAction = operation(function* (providerName: string) {
  const provider = yield* getProvider()
  const sso = provider.ssoProviders?.[providerName]
  if (!sso) {
    return yield* fail(
      AuthErrorCode.UnknownProvider,
      `SSO provider "${providerName}" not configured`,
    )
  }

  // Provider issues the CSRF state (and binds it to the user's pre-auth context).
  const state = yield* sso.generateState()
  const url = yield* sso.authorize(state)

  return { url, state }
})
