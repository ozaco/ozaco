import { CoreErrors } from 'server:core'
import { operation, useContext } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { fail } from 'std:result'

import { AuthErrorCode } from '../error-codes'
import {
  buildAuthorize,
  confirmVerificationAction,
  eventsAction,
  hasPermissionAction,
  hasRoleAction,
  issueVerificationAction,
  provideAction,
  requirePermissionAction,
  requireRoleAction,
  ssoAuthorizeAction,
} from '../internal/actions'
import { DEFAULT_ACCESS_TTL, DEFAULT_REFRESH_TTL, TOKEN_TYPE_ACCESS } from '../internal/const'
import { AccessStrategyCtxRef, AuthEventsRef } from '../internal/contexts'
import { collectAuthz, getProvider, parseDuration } from '../internal/helpers'
import { initializeBaseAuth } from '../internal/setup'
import {
  decodePrincipalToken,
  decodeRefreshToken,
  signPrincipalToken,
  signRefreshToken,
} from '../internal/tokens'
import type { AuthDef } from '../types'

const issueTokenPair = operation(function* (user: AuthDef.User, opts: AuthDef.IssueOptions = {}) {
  const strategy = yield* useContext(AccessStrategyCtxRef)
  const provider = yield* getProvider()

  const { roles, permissions } = yield* collectAuthz(provider, user)

  const access = yield* signPrincipalToken(TOKEN_TYPE_ACCESS, strategy.accessTTL, {
    user,
    roles,
    permissions,
  })
  const refresh = yield* signRefreshToken(user.id, strategy.refreshTTL)

  const newRecord = {
    jti: refresh.jti,
    userId: user.id,
    issuedAt: refresh.issuedAt,
    expiresAt: refresh.expiresAt,
    revokedAt: null,
  }

  if (opts.rotateFrom !== undefined && provider.rotateRefreshToken) {
    yield* provider.rotateRefreshToken(opts.rotateFrom, newRecord)
    // the rotate branch deliberately does not saveRefreshToken, so the trailing save is not shared
    // oxlint-disable-next-line no-negated-condition
  } else if (opts.rotateFrom !== undefined) {
    // legacy fallback: non-atomic rotate via revoke + save
    if (!provider.revokeRefreshToken || !provider.saveRefreshToken) {
      return yield* fail(
        AuthErrorCode.NotProvided,
        'rotation requires rotateRefreshToken or both revokeRefreshToken+saveRefreshToken',
      )
    }
    yield* provider.revokeRefreshToken(opts.rotateFrom)
    yield* provider.saveRefreshToken(newRecord)
  } else {
    if (!provider.saveRefreshToken) {
      return yield* fail(AuthErrorCode.NotProvided, 'provider does not expose saveRefreshToken')
    }
    yield* provider.saveRefreshToken(newRecord)
  }

  const session = (yield* decodePrincipalToken(access.token, TOKEN_TYPE_ACCESS)) as AuthDef.Session

  const tokens: AuthDef.AccessRefreshTokens = {
    accessToken: access.token,
    refreshToken: refresh.token,
    accessExpiresAt: access.expiresAt,
    refreshExpiresAt: refresh.expiresAt,
  }

  return { session, tokens }
})

export const AccessRefreshAuth = definePlugin({
  name: 'server/plugin-auth-access-refresh',
  version: '0.0.0',
  description: 'JWT access + refresh token strategy',

  *setup(options: AuthDef.AccessRefreshOptions) {
    yield* initializeBaseAuth(options)

    const ctx: AuthDef.AccessRefreshContext = {
      accessTTL: yield* parseDuration(options.access?.expiresIn ?? DEFAULT_ACCESS_TTL),
      refreshTTL: yield* parseDuration(options.refresh?.expiresIn ?? DEFAULT_REFRESH_TTL),
      rotateRefresh: options.refresh?.rotate ?? true,
    }

    yield* AccessStrategyCtxRef.set(ctx)
    return ctx
  },
}).build({
  provide: provideAction,
  events: eventsAction,

  signIn: operation(function* (credentials: unknown) {
    const provider = yield* getProvider()
    const events = yield* useContext(AuthEventsRef)

    const user = yield* provider.authenticate(credentials)
    if (!user) {
      events.emit('denied', 'invalid-credentials', 'authenticate returned null')
      return yield* fail(AuthErrorCode.InvalidCredentials, 'authentication failed')
    }

    const { session, tokens } = yield* issueTokenPair(user)
    events.emit('signed-in', user, session)

    return { user, session, ...tokens }
  }),

  signOut: operation(function* (refreshToken: string) {
    const provider = yield* getProvider()
    const events = yield* useContext(AuthEventsRef)

    if (!provider.revokeRefreshToken) {
      return yield* fail(AuthErrorCode.NotProvided, 'provider does not expose revokeRefreshToken')
    }

    const payload = yield* decodeRefreshToken(refreshToken)
    yield* provider.revokeRefreshToken(payload.jti)

    events.emit('signed-out', payload.sub, payload.jti)
  }),

  refresh: operation(function* (refreshToken: string) {
    const provider = yield* getProvider()
    const strategy = yield* useContext(AccessStrategyCtxRef)
    const events = yield* useContext(AuthEventsRef)

    if (!provider.findRefreshToken) {
      return yield* fail(AuthErrorCode.NotProvided, 'provider does not expose findRefreshToken')
    }

    const payload = yield* decodeRefreshToken(refreshToken)

    const record = yield* provider.findRefreshToken(payload.jti)
    if (!record) {
      events.emit('denied', 'revoked-token', 'refresh token not found')
      return yield* fail(AuthErrorCode.RevokedToken, 'refresh token not found')
    }
    if (record.revokedAt) {
      events.emit('denied', 'revoked-token', 'refresh token revoked')
      return yield* fail(AuthErrorCode.RevokedToken, 'refresh token revoked')
    }

    const user = yield* provider.loadUser(payload.sub)
    if (!user) {
      return yield* fail(CoreErrors.NotFound, `user "${payload.sub}" not found`)
    }

    // Rotation is atomic when provider implements rotateRefreshToken; otherwise
    // falls back to non-atomic revoke + save (legacy).
    const { session, tokens } = yield* issueTokenPair(user, {
      rotateFrom: strategy.rotateRefresh ? payload.jti : undefined,
    })
    events.emit('refreshed', session)

    return tokens
  }),

  authorize: buildAuthorize(TOKEN_TYPE_ACCESS),

  hasRole: hasRoleAction,
  hasPermission: hasPermissionAction,
  requireRole: requireRoleAction,
  requirePermission: requirePermissionAction,

  issueVerification: issueVerificationAction,
  confirmVerification: confirmVerificationAction,

  ssoAuthorize: ssoAuthorizeAction,

  ssoCallback: operation(function* (providerName: string, code: string, state: string) {
    const provider = yield* getProvider()
    const events = yield* useContext(AuthEventsRef)

    const sso = provider.ssoProviders?.[providerName]
    if (!sso) {
      return yield* fail(
        AuthErrorCode.UnknownProvider,
        `SSO provider "${providerName}" not configured`,
      )
    }
    if (!provider.linkSSO) {
      return yield* fail(AuthErrorCode.NotProvided, 'provider does not expose linkSSO')
    }

    // CSRF protection: provider must verify state before code exchange.
    yield* sso.verifyState(state)

    const profile = yield* sso.exchange(code)
    const user = yield* provider.linkSSO(profile)

    const { session, tokens } = yield* issueTokenPair(user)

    events.emit('sso-linked', user.id, providerName)
    events.emit('signed-in', user, session)

    return { user, session, ...tokens }
  }),
})
