import { createContext, operation, useContext } from 'std:effect'
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
import { DEFAULT_SESSION_TTL, TOKEN_TYPE_SESSION } from '../internal/const'
import { AuthEventsRef } from '../internal/contexts'
import { collectAuthz, getProvider, parseDuration } from '../internal/helpers'
import { initializeBaseAuth } from '../internal/setup'
import { decodePrincipalToken, signPrincipalToken } from '../internal/tokens'
import type {
  AuthSession,
  AuthUser,
  JWTSessionContext,
  JWTSessionOptions,
  JWTSessionTokens,
} from '../types'

const StrategyCtxRef = createContext<JWTSessionContext>('server:auth:jwt-session:ctx')

const issueSessionToken = operation(function* (user: AuthUser) {
  const strategy = yield* useContext(StrategyCtxRef)
  const provider = yield* getProvider()

  const { roles, permissions } = yield* collectAuthz(provider, user)

  const issued = yield* signPrincipalToken(TOKEN_TYPE_SESSION, strategy.sessionTTL, {
    user,
    roles,
    permissions,
  })
  const session = (yield* decodePrincipalToken(issued.token, TOKEN_TYPE_SESSION)) as AuthSession

  const tokens: JWTSessionTokens = { token: issued.token, expiresAt: issued.expiresAt }
  return { session, tokens }
})

export const JWTSessionAuth = definePlugin({
  name: 'auth:jwt-session',
  version: '0.0.1',
  description: 'classic single-token JWT session strategy',

  *setup(options: JWTSessionOptions) {
    yield* initializeBaseAuth(options)

    const ctx: JWTSessionContext = {
      sessionTTL: yield* parseDuration(options.session?.expiresIn ?? DEFAULT_SESSION_TTL),
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
      return yield* fail(AuthErrorCode.InvalidCredentials, 'authentication failed')
    }

    const { session, tokens } = yield* issueSessionToken(user)
    events.emit('signed-in', user, session)

    // oxlint-disable-next-line oxc/no-rest-spread-properties
    return { user, session, ...tokens }
  }),

  signOut: operation(function* (token: string) {
    const events = yield* useContext(AuthEventsRef)
    const session = yield* decodePrincipalToken(token, TOKEN_TYPE_SESSION)
    events.emit('signed-out', session.sub, session.jti)
  }),

  authorize: buildAuthorize(TOKEN_TYPE_SESSION),

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

    const { session, tokens } = yield* issueSessionToken(user)

    events.emit('sso-linked', user.id, providerName)
    events.emit('signed-in', user, session)

    // oxlint-disable-next-line oxc/no-rest-spread-properties
    return { user, session, ...tokens }
  }),
})
