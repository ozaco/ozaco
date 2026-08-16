import { AuthStrategy, CoreErrors } from 'server:core'
import type { Meta, Principal } from 'server:core'
import { moduleLogger, randomHex } from 'server:utils'
import { attempt, operation, useContext } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { ACCESS_TTL_MS, REFRESH_TTL_MS } from '../const'
import { AuthErrors } from '../errors'
import type { AccessRefreshOptions, AccessRefreshProvider, Auth } from '../types'

import {
  authenticateUser,
  authorizeMeta,
  hasPermissionAction,
  hasRoleAction,
  requirePermissionAction,
  requireRoleAction,
  resolveKeyMaterial,
  resolvePrincipal,
  servicePrincipal,
  signToken,
  socketGuard,
  userAction,
  validateProvider,
  verifyToken,
} from './shared'

const REFRESH_HOOKS = [
  'authenticate',
  'loadUser',
  'saveRefreshToken',
  'loadRefreshToken',
  'rotateRefreshToken',
  'revokeRefreshFamily',
] as const

const AccessRefreshAuthImpl = AuthStrategy.implement<
  Auth.AccessRefreshContext,
  [options: AccessRefreshOptions]
>({
  name: 'access-refresh-auth',
  version: '0.1.0',
  description: 'Access/refresh pairs — CAS rotation, replay detection, family revocation',

  *setup(options) {
    yield* validateProvider(options.provider, REFRESH_HOOKS, 'access-refresh')

    return {
      material: yield* resolveKeyMaterial(options),
      // validated just above — every refresh hook is present
      provider: options.provider as AccessRefreshProvider,
      accessTtlMs: options.accessTtlMs ?? ACCESS_TTL_MS,
      refreshTtlMs: options.refreshTtlMs ?? REFRESH_TTL_MS,
      log: yield* moduleLogger('server:auth/access-refresh'),
    }
  },
})

const useAccess = () => useContext(AccessRefreshAuthImpl.context)

/** Mint one bare access token for a principal (the `sign`/`signServiceToken` core). */
const mintAccess = operation(function* (
  ctx: Auth.AccessRefreshContext,
  principal: Principal,
  ttlMs?: number,
) {
  return yield* signToken(
    ctx.material,
    {
      sub: principal.sub,
      jti: yield* randomHex(16),
      type: 'access',
      roles: principal.roles,
      permissions: principal.permissions,
      claims: principal.claims,
    },
    ttlMs ?? ctx.accessTtlMs,
  )
})

/** Mint one access + refresh pair; the refresh token is a bare rotation credential (no claims). */
const mintPair = operation(function* (
  ctx: Auth.AccessRefreshContext,
  principal: Principal,
  familyId: string,
) {
  const refreshJti = yield* randomHex(16)
  const accessToken = yield* mintAccess(ctx, principal)
  const refreshToken = yield* signToken(
    ctx.material,
    {
      sub: principal.sub,
      jti: refreshJti,
      type: 'refresh',
      roles: [],
      permissions: [],
      claims: {},
    },
    ctx.refreshTtlMs,
  )
  const record: Auth.RefreshRecord = {
    jti: refreshJti,
    sub: principal.sub,
    familyId,
    expiresAt: Date.now() + ctx.refreshTtlMs,
  }

  return { accessToken, refreshToken, record }
})

/** Replay detected: kill every generation of the family, then fail with the reuse cause. */
const replay = operation(function* (ctx: Auth.AccessRefreshContext, familyId: string) {
  yield* ctx.provider.revokeRefreshFamily(familyId)

  return yield* fail(
    CoreErrors.Unauthorized,
    'refresh token replayed — family revoked',
    AuthErrors.ReusedToken,
  )
})

/**
 * The access/refresh strategy: `install(AccessRefreshAuth, { secret | keys, provider,
 * accessTtlMs?, refreshTtlMs? })`. The provider must supply the refresh CRUD + CAS rotation +
 * family revocation hooks (setup fails `not-configured` otherwise). `authorize` accepts ACCESS
 * tokens only; `refresh` rotates via the provider's CAS — a lost CAS or a tombstoned record means
 * replay, which revokes the whole token family. Requires an installed IO implementation (ids).
 */
export const AccessRefreshAuth = AccessRefreshAuthImpl.build({
  /** Verifies ACCESS tokens only — refresh tokens are rejected with `invalid-token` in causes. */
  authorize: operation(function* (meta: Meta) {
    const ctx = yield* useAccess()

    return yield* authorizeMeta(ctx, meta, 'access')
  }),

  hasRole: hasRoleAction,
  hasPermission: hasPermissionAction,

  /** Fails `CoreErrors.Forbidden` (→ 403) when the principal lacks the role. */
  requireRole: requireRoleAction,
  /** Fails `CoreErrors.Forbidden` (→ 403) when the principal lacks the permission. */
  requirePermission: requirePermissionAction,

  /** The caller `Principal` of the current request — fails `CoreErrors.Unauthorized` (→ 401). */
  user: operation(function* () {
    const ctx = yield* useAccess()

    return yield* userAction(ctx, 'access')
  }),

  /** Mint a service-to-service ACCESS token (`sub: service:<name>`) — no `loadUser` round trip. */
  signServiceToken: operation(function* (serviceName: string, ttlMs?: number) {
    const ctx = yield* useAccess()

    return yield* mintAccess(ctx, servicePrincipal(serviceName), ttlMs)
  }),

  /** A `SocketRoute.authorize`-compatible guard — non-authorizing upgrades are rejected (401). */
  authorizeSocket: operation(function* () {
    const ctx = yield* useAccess()

    return socketGuard(ctx, 'access')
  }),

  /** Authenticate and persist a fresh-family refresh record alongside the new pair. */
  signIn: operation(function* (credentials: Record<string, unknown>) {
    const ctx = yield* useAccess()
    const principal = yield* authenticateUser(ctx, credentials)
    const minted = yield* mintPair(ctx, principal, yield* randomHex(8))

    yield* ctx.provider.saveRefreshToken(minted.record)

    const pair: Auth.TokenPair = {
      accessToken: minted.accessToken,
      refreshToken: minted.refreshToken,
      principal,
    }

    return pair
  }),

  /** Rotate a refresh token into a new pair (family preserved); replays revoke the family. */
  refresh: operation(function* (refreshToken: string) {
    const ctx = yield* useAccess()
    const outcome = yield* attempt(function* () {
      const payload = yield* verifyToken(ctx.material, refreshToken)

      if (payload.type !== 'refresh') {
        return yield* fail(CoreErrors.Unauthorized, 'not a refresh token', AuthErrors.InvalidToken)
      }

      const record = yield* ctx.provider.loadRefreshToken(payload.jti)

      if (!record) {
        return yield* fail(
          CoreErrors.Unauthorized,
          'unknown refresh token',
          AuthErrors.InvalidToken,
        )
      }

      if (record.revoked) {
        return yield* replay(ctx, record.familyId)
      }

      if (record.expiresAt <= Date.now()) {
        return yield* fail(
          CoreErrors.Unauthorized,
          'refresh token expired',
          AuthErrors.ExpiredToken,
        )
      }

      const user = yield* ctx.provider.loadUser(record.sub)

      if (!user) {
        return yield* fail(
          CoreErrors.Unauthorized,
          'unknown token subject',
          AuthErrors.InvalidToken,
        )
      }

      const principal = yield* resolvePrincipal(ctx.provider, user, payload)
      const minted = yield* mintPair(ctx, principal, record.familyId)
      const rotated = yield* ctx.provider.rotateRefreshToken(payload.jti, minted.record)

      if (!rotated) {
        // the CAS lost: someone else consumed this jti concurrently — treat as replay
        return yield* replay(ctx, record.familyId)
      }

      const pair: Auth.TokenPair = {
        accessToken: minted.accessToken,
        refreshToken: minted.refreshToken,
        principal,
      }

      return pair
    })

    if (isFailure(outcome)) {
      yield* ctx.log.warn('refresh rejected', { reason: outcome.message })

      return yield* outcome
    }

    return outcome.value
  }),

  /** Revoke the whole family of the presented refresh token (idempotent on unknown records). */
  signOut: operation(function* (refreshToken: string) {
    const ctx = yield* useAccess()
    const payload = yield* verifyToken(ctx.material, refreshToken)

    if (payload.type !== 'refresh') {
      return yield* fail(CoreErrors.Unauthorized, 'not a refresh token', AuthErrors.InvalidToken)
    }

    const record = yield* ctx.provider.loadRefreshToken(payload.jti)

    if (record) {
      yield* ctx.provider.revokeRefreshFamily(record.familyId)
      yield* ctx.log.debug('refresh family revoked', { familyId: record.familyId })
    }
  }),

  /** Mint an access token for an arbitrary principal (service tokens, tests). */
  sign: operation(function* (principal: Principal, ttlMs?: number) {
    const ctx = yield* useAccess()

    return yield* mintAccess(ctx, principal, ttlMs)
  }),
})
