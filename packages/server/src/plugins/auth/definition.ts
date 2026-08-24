import type { ServerDef } from 'server:core'
import { CtxRef, Server, ServerErrors } from 'server:core'
import { IO } from 'std:io'
import { definePlugin } from 'std:plugin'
import { fail } from 'std:result'

import { AuthErrors } from './errors'
import {
  authorize,
  bearerOf,
  DAY,
  HOUR,
  materialOf,
  options,
  sign,
  tokensFor,
  verify,
} from './internal'
import type { AuthDef } from './types'

const AuthImpl = definePlugin<
  AuthDef.Context & ServerDef.PluginContext,
  [options: AuthDef.Options]
>({
  name: 'server-auth',
  version: '0.5.0',
  description: 'JWT sessions / access+refresh rotation / service tokens, as action options',

  *setup(given) {
    if (!(yield* Server.context.get())) {
      return yield* fail(ServerErrors.Configuration, 'Auth must be installed by createServer')
    }
    const mode = given.mode ?? 'session'
    if (mode === 'access-refresh') {
      const missing = (
        ['saveRefresh', 'loadRefresh', 'rotateRefresh', 'revokeFamily'] as const
      ).filter(hook => typeof given.provider[hook] !== 'function')
      if (missing.length > 0) {
        return yield* fail(
          ServerErrors.Configuration,
          `auth: access-refresh mode needs provider.${missing.join(', provider.')}`,
        )
      }
    }
    const material = yield* materialOf(given)
    const context: AuthDef.Context = {
      mode,
      provider: given.provider,
      material,
      ttl: {
        session: given.sessionTtlMs ?? 7 * DAY,
        access: given.accessTtlMs ?? 15 * 60 * 1000,
        refresh: given.refreshTtlMs ?? 30 * DAY,
        service: given.serviceTtlMs ?? HOUR,
      },
    }
    return {
      ...context,
      options,
      hooks: {
        name: 'auth',
        *dispatch(call, ctx, next) {
          const requirement = (ctx.meta.options as { auth?: AuthDef.Requirement }).auth ?? false
          const token = bearerOf(call.headers)
          let principal: AuthDef.Principal | undefined = undefined
          if (token) {
            const verified = yield* verify(material, token)
            if (verified.type === 'refresh') {
              return yield* fail(
                ServerErrors.Unauthorized,
                'a refresh token cannot call actions',
                AuthErrors.InvalidToken,
              )
            }
            principal = verified
          }
          yield* authorize(principal, requirement)
          return yield* next(call, { ...ctx, auth: principal })
        },
      },
    }
  },
})

/**
 * Authentication: `Auth.use({ provider, secret | keys, mode })`. Every dispatch with a bearer
 * token gets its principal on `ctx.auth`; `action({ auth: 'user' | 'service' | 'any' | [roles] })`
 * gates the action (`server.unauthorized` / `server.forbidden`). `Auth.actions.login/refresh/
 * verify/signService` mint and check tokens; wrap them in your own actions (or `authService()`).
 */
export const Auth = AuthImpl.build<AuthDef.Actions>({
  *login(credentials) {
    const context = yield* AuthImpl.context.expect()
    const user = yield* context.provider.authenticate(credentials)
    if (!user) {
      return yield* fail(ServerErrors.Unauthorized, 'bad credentials', AuthErrors.BadCredentials)
    }
    return yield* tokensFor(context, user, yield* IO.actions.uuid())
  },

  *refresh(refreshToken) {
    const context = yield* AuthImpl.context.expect()
    if (context.mode !== 'access-refresh') {
      return yield* fail(ServerErrors.Unsupported, 'refresh tokens need mode: access-refresh')
    }
    const verified = yield* verify(context.material, refreshToken)
    if (verified.type !== 'refresh' || !verified.family) {
      return yield* fail(ServerErrors.Unauthorized, 'not a refresh token', AuthErrors.InvalidToken)
    }
    const record = yield* context.provider.loadRefresh!(verified.jti)
    if (!record || record.revoked || record.expiresAt < Date.now()) {
      // a consumed token presented again: someone else has it — burn the whole family
      yield* context.provider.revokeFamily!(verified.family)
      return yield* fail(
        ServerErrors.Unauthorized,
        'refresh token replayed or revoked',
        AuthErrors.Replayed,
      )
    }
    const user = yield* context.provider.loadUser(verified.sub)
    if (!user) {
      return yield* fail(ServerErrors.Unauthorized, 'unknown user', AuthErrors.InvalidToken)
    }
    const nextJti = yield* IO.actions.uuid()
    const next: AuthDef.RefreshRecord = {
      jti: nextJti,
      sub: user.sub,
      family: verified.family,
      expiresAt: Date.now() + context.ttl.refresh,
      revoked: false,
    }
    const rotated = yield* context.provider.rotateRefresh!(verified.jti, next)
    if (!rotated) {
      yield* context.provider.revokeFamily!(verified.family)
      return yield* fail(ServerErrors.Unauthorized, 'refresh token replayed', AuthErrors.Replayed)
    }
    const base = {
      sub: user.sub,
      roles: user.roles ?? [],
      permissions: user.permissions ?? [],
      claims: user.claims ?? {},
    }
    return {
      accessToken: yield* sign(
        context.material,
        { ...base, type: 'access', jti: yield* IO.actions.uuid() },
        context.ttl.access,
      ),
      refreshToken: yield* sign(
        context.material,
        { ...base, type: 'refresh', jti: nextJti, family: verified.family },
        context.ttl.refresh,
      ),
      expiresAt: Date.now() + context.ttl.access,
    }
  },

  *verify(token) {
    const context = yield* AuthImpl.context.expect()
    const verified = yield* verify(context.material, token)
    const { family: _family, exp: _exp, ...principal } = verified
    return principal
  },

  *signService(name, roles = []) {
    const context = yield* AuthImpl.context.expect()
    return yield* sign(
      context.material,
      {
        sub: `service:${name}`,
        type: 'service',
        roles,
        permissions: [],
        claims: {},
        jti: yield* IO.actions.uuid(),
      },
      context.ttl.service,
    )
  },

  *principal() {
    const ctx = yield* CtxRef.get()
    const principal = ctx?.auth as AuthDef.Principal | undefined
    if (!principal) {
      return yield* fail(ServerErrors.Unauthorized, 'no principal on this dispatch', 'auth:missing')
    }
    return principal
  },

  *authorize(requirement, headers) {
    const context = yield* AuthImpl.context.expect()
    const token = bearerOf(headers)
    let principal: AuthDef.Principal | undefined = undefined
    if (token) {
      const verified = yield* verify(context.material, token)
      if (verified.type === 'refresh') {
        return yield* fail(
          ServerErrors.Unauthorized,
          'a refresh token cannot authenticate',
          AuthErrors.InvalidToken,
        )
      }
      principal = verified
    }
    yield* authorize(principal, requirement)
    return principal ?? null
  },
})
