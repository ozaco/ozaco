import { AuthStrategy } from 'server:core'
import type { Meta, Principal } from 'server:core'
import { moduleLogger, randomHex } from 'server:utils'
import { operation, useContext } from 'std:effect'

import { SESSION_TTL_MS } from '../const'
import type { Auth, JwtSessionOptions } from '../types'

import {
  authenticateUser,
  authorizeMeta,
  hasPermissionAction,
  hasRoleAction,
  requirePermissionAction,
  requireRoleAction,
  resolveKeyMaterial,
  servicePrincipal,
  signToken,
  socketGuard,
  userAction,
  validateProvider,
} from './shared'

const JwtSessionAuthImpl = AuthStrategy.implement<
  Auth.JwtSessionContext,
  [options: JwtSessionOptions]
>({
  name: 'jwt-session-auth',
  version: '0.1.0',
  description: 'Stateless session JWTs — signIn mints one token carrying the whole principal',

  *setup(options) {
    yield* validateProvider(options.provider, ['authenticate', 'loadUser'], 'jwt-session')

    return {
      material: yield* resolveKeyMaterial(options),
      provider: options.provider,
      sessionTtlMs: options.sessionTtlMs ?? SESSION_TTL_MS,
      log: yield* moduleLogger('server:auth/jwt-session'),
    }
  },
})

const useSession = () => useContext(JwtSessionAuthImpl.context)

const mint = operation(function* (
  ctx: Auth.JwtSessionContext,
  principal: Principal,
  ttlMs?: number,
) {
  return yield* signToken(
    ctx.material,
    {
      sub: principal.sub,
      jti: yield* randomHex(16),
      type: 'session',
      roles: principal.roles,
      permissions: principal.permissions,
      claims: principal.claims,
    },
    ttlMs ?? ctx.sessionTtlMs,
  )
})

/**
 * The stateless session strategy: `install(JwtSessionAuth, { secret | keys, provider,
 * sessionTtlMs? })`. `signIn` mints a `session` JWT embedding the principal; `authorize` parses
 * `authorization: Bearer <token>`, verifies it, reloads the user through the provider and fails
 * `CoreErrors.Unauthorized` (→ 401 at the edge) with precise `AuthErrors` causes. Requires an
 * installed IO implementation (token ids).
 */
export const JwtSessionAuth = JwtSessionAuthImpl.build({
  authorize: operation(function* (meta: Meta) {
    const ctx = yield* useSession()

    return yield* authorizeMeta(ctx, meta, 'session')
  }),

  hasRole: hasRoleAction,
  hasPermission: hasPermissionAction,

  /** Fails `CoreErrors.Forbidden` (→ 403) when the principal lacks the role. */
  requireRole: requireRoleAction,
  /** Fails `CoreErrors.Forbidden` (→ 403) when the principal lacks the permission. */
  requirePermission: requirePermissionAction,

  /** The caller `Principal` of the current request — fails `CoreErrors.Unauthorized` (→ 401). */
  user: operation(function* () {
    const ctx = yield* useSession()

    return yield* userAction(ctx, 'session')
  }),

  /** Mint a service-to-service token (`sub: service:<name>`) — authorized without `loadUser`. */
  signServiceToken: operation(function* (serviceName: string, ttlMs?: number) {
    const ctx = yield* useSession()

    return yield* mint(ctx, servicePrincipal(serviceName), ttlMs)
  }),

  /** A `SocketRoute.authorize`-compatible guard — non-authorizing upgrades are rejected (401). */
  authorizeSocket: operation(function* () {
    const ctx = yield* useSession()

    return socketGuard(ctx, 'session')
  }),

  signIn: operation(function* (credentials: Record<string, unknown>) {
    const ctx = yield* useSession()
    const principal = yield* authenticateUser(ctx, credentials)
    const session: Auth.SessionSignIn = { token: yield* mint(ctx, principal), principal }

    return session
  }),

  /**
   * ADVISORY ONLY — session tokens are stateless, nothing is revoked server-side and the token
   * stays valid until `exp`. Clients should discard it; use `AccessRefreshAuth` when server-side
   * revocation matters.
   */
  signOut: operation(function* (_token: string) {
    const ctx = yield* useSession()

    yield* ctx.log.debug('session sign-out is advisory — stateless tokens stay valid until exp')
  }),

  /** Mint a session token for an arbitrary principal (service tokens, tests). */
  sign: operation(function* (principal: Principal, ttlMs?: number) {
    const ctx = yield* useSession()

    return yield* mint(ctx, principal, ttlMs)
  }),
})
