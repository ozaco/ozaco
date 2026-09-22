import { ServerErrors } from 'server:core'
import { IO } from 'std:io'
import { fail } from 'std:result'

import pkg from '../../../../package.json'
import { AuthStrategy } from '../definition'
import { AuthErrors } from '../errors'
import { DAY, HOUR, materialOf, sign, tokensFor, verify } from '../internal'
import type { AuthDef } from '../types'

const JwtAuthImpl = AuthStrategy.implement<AuthDef.JwtContext, [options: AuthDef.JwtOptions]>({
  name: 'server-auth-jwt',
  version: pkg.version,
  description: 'JWT sessions / access + refresh rotation / service tokens (jose)',

  *setup(given) {
    // `plugins: [JwtAuth]` (the bare handle) type-checks like the option-less plugins — say so
    // here instead of dying on `given.secret` with a raw TypeError
    if (!given) {
      return yield* fail(
        ServerErrors.Configuration,
        'JwtAuth needs options — plugins: [JwtAuth.use({ secret | keys, provider })], not [JwtAuth]',
      )
    }
    const mode = given.mode ?? 'session'
    if (mode === 'access-refresh') {
      const provider = given.provider
      if (!provider) {
        return yield* fail(ServerErrors.Configuration, 'auth: access-refresh mode needs a provider')
      }
      const missing = (
        ['saveRefresh', 'loadRefresh', 'rotateRefresh', 'revokeFamily'] as const
      ).filter(hook => typeof provider[hook] !== 'function')
      if (missing.length > 0) {
        return yield* fail(
          ServerErrors.Configuration,
          `auth: access-refresh mode needs provider.${missing.join(', provider.')}`,
        )
      }
    }
    return {
      strategy: 'jwt',
      mode,
      provider: given.provider ?? null,
      material: yield* materialOf(given),
      ttl: {
        session: given.sessionTtlMs ?? 7 * DAY,
        access: given.accessTtlMs ?? 15 * 60 * 1000,
        refresh: given.refreshTtlMs ?? 30 * DAY,
        service: given.serviceTtlMs ?? HOUR,
      },
    }
  },
})

/**
 * The JWT strategy — `JwtAuth.use({ secret | keys, provider, mode })`. Verifies bearers signed
 * with its material (a token of another key or no JWT at all is "not mine" — the next strategy
 * may know it), issues session or access + refresh tokens through the `provider`, mints service
 * tokens. Without a provider it verifies only (tokens issued elsewhere with the same key).
 */
export const JwtAuth = JwtAuthImpl.build({
  *verify(token: string) {
    const context = yield* JwtAuthImpl.context.expect()
    const verified = yield* verify(context.material, token)
    if (!verified) {
      return undefined
    }
    if (verified.type === 'refresh') {
      return yield* fail(
        ServerErrors.Unauthorized,
        'a refresh token cannot authenticate',
        AuthErrors.InvalidToken,
      )
    }
    const { family: _family, exp: _exp, ...principal } = verified
    return principal
  },

  *login(credentials: Record<string, unknown>) {
    const context = yield* JwtAuthImpl.context.expect()
    if (!context.provider) {
      return undefined
    }
    const user = yield* context.provider.authenticate(credentials)
    if (!user) {
      return yield* fail(ServerErrors.Unauthorized, 'bad credentials', AuthErrors.BadCredentials)
    }
    return yield* tokensFor(context, user, yield* IO.actions.uuid())
  },

  *refresh(refreshToken: string) {
    const context = yield* JwtAuthImpl.context.expect()
    const { provider } = context
    if (context.mode !== 'access-refresh' || !provider) {
      return undefined
    }
    const verified = yield* verify(context.material, refreshToken)
    if (!verified) {
      return undefined
    }
    if (verified.type !== 'refresh' || !verified.family) {
      return yield* fail(ServerErrors.Unauthorized, 'not a refresh token', AuthErrors.InvalidToken)
    }
    const record = yield* provider.loadRefresh!(verified.jti)
    if (!record || record.revoked || record.expiresAt < Date.now()) {
      // a consumed token presented again: someone else has it — burn the whole family
      yield* provider.revokeFamily!(verified.family)
      return yield* fail(
        ServerErrors.Unauthorized,
        'refresh token replayed or revoked',
        AuthErrors.Replayed,
      )
    }
    const user = yield* provider.loadUser(verified.sub)
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
    const rotated = yield* provider.rotateRefresh!(verified.jti, next)
    if (!rotated) {
      yield* provider.revokeFamily!(verified.family)
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

  *signService(name: string, roles: readonly string[] = []) {
    const context = yield* JwtAuthImpl.context.expect()
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
})
