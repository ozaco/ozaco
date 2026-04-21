import { createContext, operation, useContext } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { fail } from 'std:result'

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
import { collectAuthz } from '../internal/authz'
import { DEFAULT_ACCESS_TTL, DEFAULT_REFRESH_TTL, TOKEN_TYPE_ACCESS } from '../internal/const'
import { AuthEventsRef } from '../internal/contexts'
import { parseDuration } from '../internal/duration'
import { getProvider } from '../internal/provider'
import { initializeBaseAuth } from '../internal/setup'
import {
  decodePrincipalToken,
  decodeRefreshToken,
  signPrincipalToken,
  signRefreshToken,
} from '../internal/tokens'
import type { AuthSession, AuthUser, BaseAuthOptions } from '../types'

interface AccessRefreshContext {
  accessTTL: number
  refreshTTL: number
  rotateRefresh: boolean
}

const StrategyCtxRef = createContext<AccessRefreshContext>('server:auth:access-refresh:ctx')

const issueTokenPair = operation(function* (user: AuthUser) {
  const strategy = yield* useContext(StrategyCtxRef)
  const provider = yield* getProvider()

  const { roles, permissions } = yield* collectAuthz(provider, user)

  const access = yield* signPrincipalToken(TOKEN_TYPE_ACCESS, strategy.accessTTL, {
    user,
    roles,
    permissions,
  })
  const refresh = yield* signRefreshToken(user.id, strategy.refreshTTL)

  if (!provider.saveRefreshToken) {
    return yield* fail('not-provided', 'provider does not expose saveRefreshToken')
  }

  yield* provider.saveRefreshToken({
    jti: refresh.jti,
    userId: user.id,
    issuedAt: refresh.issuedAt,
    expiresAt: refresh.expiresAt,
    revokedAt: null,
  })

  const session = (yield* decodePrincipalToken(access.token, TOKEN_TYPE_ACCESS)) as AuthSession

  const tokens: AccessRefreshTokens = {
    accessToken: access.token,
    refreshToken: refresh.token,
    accessExpiresAt: access.expiresAt,
    refreshExpiresAt: refresh.expiresAt,
  }

  return { session, tokens }
})

export interface AccessRefreshOptions extends BaseAuthOptions {
  access?: { expiresIn?: string }
  refresh?: { expiresIn?: string; rotate?: boolean }
}

export interface AccessRefreshTokens {
  accessToken: string
  refreshToken: string
  accessExpiresAt: number
  refreshExpiresAt: number
}

export const AccessRefreshAuth = definePlugin({
  name: 'auth:access-refresh',
  version: '0.0.1',
  description: 'JWT access + refresh token strategy',

  *setup(options: AccessRefreshOptions) {
    yield* initializeBaseAuth(options)

    const ctx: AccessRefreshContext = {
      accessTTL: yield* parseDuration(options.access?.expiresIn ?? DEFAULT_ACCESS_TTL),
      refreshTTL: yield* parseDuration(options.refresh?.expiresIn ?? DEFAULT_REFRESH_TTL),
      rotateRefresh: options.refresh?.rotate ?? true,
    }

    yield* StrategyCtxRef.set(ctx)
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
      return yield* fail('invalid-credentials', 'authentication failed')
    }

    const { session, tokens } = yield* issueTokenPair(user)
    events.emit('signed-in', user, session)

    // oxlint-disable-next-line oxc/no-rest-spread-properties
    return { user, session, ...tokens }
  }),

  signOut: operation(function* (refreshToken: string) {
    const provider = yield* getProvider()
    const events = yield* useContext(AuthEventsRef)

    if (!provider.revokeRefreshToken) {
      return yield* fail('not-provided', 'provider does not expose revokeRefreshToken')
    }

    const payload = yield* decodeRefreshToken(refreshToken)
    yield* provider.revokeRefreshToken(payload.jti)

    events.emit('signed-out', payload.sub, payload.jti)
  }),

  refresh: operation(function* (refreshToken: string) {
    const provider = yield* getProvider()
    const strategy = yield* useContext(StrategyCtxRef)
    const events = yield* useContext(AuthEventsRef)

    if (!provider.findRefreshToken || !provider.revokeRefreshToken || !provider.saveRefreshToken) {
      return yield* fail(
        'not-provided',
        'refresh requires saveRefreshToken/findRefreshToken/revokeRefreshToken',
      )
    }

    const payload = yield* decodeRefreshToken(refreshToken)

    const record = yield* provider.findRefreshToken(payload.jti)
    if (!record) {
      events.emit('denied', 'revoked-token', 'refresh token not found')
      return yield* fail('revoked-token', 'refresh token not found')
    }
    if (record.revokedAt) {
      events.emit('denied', 'revoked-token', 'refresh token revoked')
      return yield* fail('revoked-token', 'refresh token revoked')
    }

    const user = yield* provider.loadUser(payload.sub)
    if (!user) {
      return yield* fail('not-found', `user "${payload.sub}" not found`)
    }

    if (strategy.rotateRefresh) {
      yield* provider.revokeRefreshToken(payload.jti)
    }

    const { session, tokens } = yield* issueTokenPair(user)
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
      return yield* fail('unknown-provider', `SSO provider "${providerName}" not configured`)
    }
    if (!provider.linkSSO) {
      return yield* fail('not-provided', 'provider does not expose linkSSO')
    }

    const profile = yield* sso.exchange(code, state)
    const user = yield* provider.linkSSO(profile)

    const { session, tokens } = yield* issueTokenPair(user)

    events.emit('sso-linked', user.id, providerName)
    events.emit('signed-in', user, session)

    // oxlint-disable-next-line oxc/no-rest-spread-properties
    return { user, session, ...tokens }
  }),
})
