import { CoreErrors, useRequest } from 'server:core'
import type { EdgeRequest, Meta, Principal } from 'server:core'
import { attempt, operation, until } from 'std:effect'
import type { Operation } from 'std:effect'
import { fail, isFailure, isSuccess } from 'std:result'

import { SignJWT, importPKCS8, importSPKI, jwtVerify } from 'jose'

import { BEARER_PREFIX, SERVICE_SUB_PREFIX, TOKEN_TYPES } from '../const'
import { AuthErrors } from '../errors'
import type { Auth, AuthProvider, AuthUser, TokenType } from '../types'

const ENCODER = new TextEncoder()

const isCryptoKey = (value: unknown): value is CryptoKey =>
  typeof CryptoKey !== 'undefined' && value instanceof CryptoKey

const isTokenType = (value: unknown): value is TokenType =>
  typeof value === 'string' && (TOKEN_TYPES as readonly string[]).includes(value)

const stringArrayOf = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter(item => typeof item === 'string') : []

const claimsOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const isExpiredError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'ERR_JWT_EXPIRED'

const importKey = operation(function* (
  value: CryptoKey | string,
  alg: string,
  kind: 'private' | 'public',
) {
  if (isCryptoKey(value)) {
    return value
  }

  if (typeof value !== 'string') {
    return yield* fail(
      AuthErrors.InvalidKey,
      `${kind} key must be a PEM string or a CryptoKey — raw bytes are rejected`,
    )
  }

  const imported = yield* attempt(() =>
    until(kind === 'private' ? importPKCS8(value, alg) : importSPKI(value, alg)),
  )

  if (isFailure(imported)) {
    return yield* fail(
      AuthErrors.InvalidKey,
      `${kind} key import failed for "${alg}"`,
      String(imported.error),
    )
  }

  return imported.value
})

/** Resolve install options into jose key material: HMAC secret → HS256, PEM/CryptoKey pairs → alg. */
export const resolveKeyMaterial = operation(function* (options: Auth.KeyOptions) {
  if (options.secret !== undefined) {
    if (typeof options.secret !== 'string' || options.secret.length === 0) {
      return yield* fail(
        AuthErrors.InvalidKey,
        'secret must be a non-empty string — raw bytes are rejected',
      )
    }

    const bytes = ENCODER.encode(options.secret)
    const material: Auth.KeyMaterial = { alg: 'HS256', signKey: bytes, verifyKey: bytes }

    return material
  }

  const keys = options.keys

  if (!keys) {
    return yield* fail(
      AuthErrors.NotConfigured,
      'auth strategy needs a `secret` (HS256) or a `keys` pair (RS256/ES256)',
    )
  }

  const material: Auth.KeyMaterial = {
    alg: keys.alg,
    signKey: yield* importKey(keys.privateKey, keys.alg, 'private'),
    verifyKey: yield* importKey(keys.publicKey, keys.alg, 'public'),
  }

  return material
})

/** Fail `not-configured` unless every listed provider hook is a function. */
export const validateProvider = operation(function* (
  provider: AuthProvider | undefined,
  hooks: readonly (keyof AuthProvider)[],
  strategy: string,
) {
  if (!provider) {
    return yield* fail(AuthErrors.NotConfigured, `${strategy} needs a provider`)
  }

  const missing = hooks.filter(key => typeof provider[key] !== 'function')

  if (missing.length > 0) {
    return yield* fail(
      AuthErrors.NotConfigured,
      `${strategy} provider is missing: ${missing.join(', ')}`,
    )
  }
})

/** Extract the bearer token from request meta — anything else is `Unauthorized`. */
export const parseBearer = operation(function* (meta: Meta) {
  const header = meta['authorization']

  if (!header?.startsWith(BEARER_PREFIX)) {
    return yield* fail(CoreErrors.Unauthorized, 'missing bearer token', AuthErrors.InvalidToken)
  }

  const token = header.slice(BEARER_PREFIX.length).trim()

  if (token === '') {
    return yield* fail(CoreErrors.Unauthorized, 'missing bearer token', AuthErrors.InvalidToken)
  }

  return token
})

/** Sign one JWT from a seed — jose is promise-based, bridged with `until` inside `attempt`. */
export const signToken = operation(function* (
  material: Auth.KeyMaterial,
  seed: Auth.TokenSeed,
  ttlMs: number,
) {
  const outcome = yield* attempt(() =>
    until(
      new SignJWT({
        type: seed.type,
        roles: [...seed.roles],
        permissions: [...seed.permissions],
        claims: seed.claims,
      })
        .setProtectedHeader({ alg: material.alg })
        .setSubject(seed.sub)
        .setJti(seed.jti)
        .setIssuedAt()
        .setExpirationTime(new Date(Date.now() + ttlMs))
        .sign(material.signKey),
    ),
  )

  if (isFailure(outcome)) {
    return yield* fail(AuthErrors.InvalidKey, 'token signing failed', String(outcome.error))
  }

  return outcome.value
})

/** Verify signature + claims and normalize the payload; failures map to `Unauthorized`. */
export const verifyToken = operation(function* (material: Auth.KeyMaterial, token: string) {
  const outcome = yield* attempt(() =>
    until(jwtVerify(token, material.verifyKey, { algorithms: [material.alg] })),
  )

  if (isFailure(outcome)) {
    if (isExpiredError(outcome.error)) {
      return yield* fail(CoreErrors.Unauthorized, 'token expired', AuthErrors.ExpiredToken)
    }

    return yield* fail(
      CoreErrors.Unauthorized,
      'token verification failed',
      AuthErrors.InvalidToken,
    )
  }

  const raw = outcome.value.payload

  if (typeof raw.sub !== 'string' || typeof raw.jti !== 'string' || !isTokenType(raw['type'])) {
    return yield* fail(CoreErrors.Unauthorized, 'malformed token payload', AuthErrors.InvalidToken)
  }

  const payload: Auth.TokenPayload = {
    sub: raw.sub,
    jti: raw.jti,
    type: raw['type'],
    roles: stringArrayOf(raw['roles']),
    permissions: stringArrayOf(raw['permissions']),
    claims: claimsOf(raw['claims']),
    iat: raw.iat,
    exp: raw.exp,
  }

  return payload
})

/** Build a `Principal`: roles/permissions via provider hooks (token arrays as the fallback). */
export const resolvePrincipal = operation(function* (
  provider: AuthProvider,
  user: AuthUser,
  payload?: Auth.TokenPayload,
) {
  const roles = provider.getRoles ? yield* provider.getRoles(user) : (payload?.roles ?? [])
  const permissions = provider.getPermissions
    ? yield* provider.getPermissions(user)
    : (payload?.permissions ?? [])

  const principal: Principal = {
    sub: user.sub,
    roles,
    permissions,
    claims: { ...user.claims, ...payload?.claims },
  }

  return principal
})

/** `authenticate` + principal resolution; `undefined` → `Unauthorized` with invalid-credentials. */
export const authenticateUser = operation(function* (
  core: Auth.StrategyCore,
  credentials: Record<string, unknown>,
) {
  const user = yield* core.provider.authenticate(credentials)

  if (!user) {
    yield* core.log.warn('sign-in rejected', { reason: AuthErrors.InvalidCredentials })

    return yield* fail(
      CoreErrors.Unauthorized,
      'invalid credentials',
      AuthErrors.InvalidCredentials,
    )
  }

  return yield* resolvePrincipal(core.provider, user)
})

/**
 * The shared `authorize(meta)` core: bearer parse → verify → type check → principal. Service
 * subjects (`service:*`) skip the `loadUser` round trip — their principal travels in the token.
 * Every rejection is logged at warn WITHOUT token contents.
 */
export const authorizeMeta = operation(function* (
  core: Auth.StrategyCore,
  meta: Meta,
  type: TokenType,
) {
  const outcome = yield* attempt(function* () {
    const token = yield* parseBearer(meta)
    const payload = yield* verifyToken(core.material, token)

    if (payload.type !== type) {
      return yield* fail(
        CoreErrors.Unauthorized,
        `a "${payload.type}" token cannot authorize here — "${type}" required`,
        AuthErrors.InvalidToken,
      )
    }

    if (payload.sub.startsWith(SERVICE_SUB_PREFIX)) {
      const principal: Principal = {
        sub: payload.sub,
        roles: payload.roles,
        permissions: payload.permissions,
        claims: payload.claims,
      }

      return principal
    }

    const user = yield* core.provider.loadUser(payload.sub)

    if (!user) {
      return yield* fail(CoreErrors.Unauthorized, 'unknown token subject', AuthErrors.InvalidToken)
    }

    return yield* resolvePrincipal(core.provider, user, payload)
  })

  if (isFailure(outcome)) {
    yield* core.log.warn('authorize rejected', { reason: outcome.message })

    return yield* outcome
  }

  return outcome.value
})

/** `hasRole` contract action — a pure principal check, shared by both strategies. */
export const hasRoleAction = operation(function* (principal: Principal, role: string) {
  return principal.roles.includes(role)
})

/** `hasPermission` contract action — a pure principal check, shared by both strategies. */
export const hasPermissionAction = operation(function* (principal: Principal, permission: string) {
  return principal.permissions.includes(permission)
})

/** Fails `CoreErrors.Forbidden` (→ 403 at the edge) when the role is missing. */
export const requireRoleAction = operation(function* (principal: Principal, role: string) {
  if (!principal.roles.includes(role)) {
    return yield* fail(CoreErrors.Forbidden, `missing role "${role}"`)
  }
})

/** Fails `CoreErrors.Forbidden` (→ 403 at the edge) when the permission is missing. */
export const requirePermissionAction = operation(function* (
  principal: Principal,
  permission: string,
) {
  if (!principal.permissions.includes(permission)) {
    return yield* fail(CoreErrors.Forbidden, `missing permission "${permission}"`)
  }
})

/**
 * `user` contract action core — resolve the caller `Principal` from the CURRENT request's meta
 * (the gateway forwards the `authorization` header and promotes `?token=`). Fails
 * `CoreErrors.Unauthorized` — the edge answers 401 automatically.
 */
export const userAction = operation(function* (core: Auth.StrategyCore, type: TokenType) {
  const request = yield* useRequest()

  return yield* authorizeMeta(core, request.meta, type)
})

/**
 * The principal a service-to-service token carries: `sub` is `service:<name>`, so `authorize`
 * trusts the token WITHOUT a provider `loadUser` round trip (it travels inside the signed payload).
 */
export const servicePrincipal = (serviceName: string): Principal => ({
  sub: `${SERVICE_SUB_PREFIX}${serviceName}`,
  roles: ['service'],
  permissions: [],
  claims: { service: serviceName },
})

/**
 * `authorizeSocket` contract action core — build a `SocketRoute.authorize`-compatible guard bound
 * to one strategy context: the upgrade request must carry a token the strategy authorizes (header
 * or promoted `?token=`) — anything else rejects the handshake with 401.
 */
export const socketGuard = (core: Auth.StrategyCore, type: TokenType) =>
  function* (request: EdgeRequest): Operation<boolean> {
    const outcome = yield* attempt(() => authorizeMeta(core, request.headers, type))

    return isSuccess(outcome)
  }
