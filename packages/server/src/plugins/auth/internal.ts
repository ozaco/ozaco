// oxlint-disable import/exports-last
import { ServerErrors } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt, until } from 'std:effect'
import { IO } from 'std:io'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose'
import { z } from 'zod'

import { AuthCauses, AuthErrors } from './errors'
import type { AuthDef } from './types'

const ENCODER = new TextEncoder()
const BEARER = 'bearer '

export const HOUR = 60 * 60 * 1000
export const DAY = 24 * HOUR

// --- shared by the coordinator and every strategy ------------------------------------------------

/** The bearer token of a request, if any. */
export const bearerOf = (headers: Readonly<Record<string, string>>): string | null => {
  const header = headers.authorization ?? headers.Authorization

  if (!header || !header.toLowerCase().startsWith(BEARER)) {
    return null
  }

  const token = header.slice(BEARER.length).trim()

  return token === '' ? null : token
}

/** Whether a principal satisfies an action's `auth` requirement; a failure says why not. */
export function* authorize(
  principal: AuthDef.Principal | undefined,
  requirement: AuthDef.Requirement,
): Operation<void> {
  if (requirement === false) {
    return
  }

  if (!principal) {
    return yield* fail(ServerErrors.Unauthorized, 'authentication required', AuthCauses.Missing)
  }

  if (requirement === 'authenticated') {
    return
  }

  if (requirement === 'user' && principal.type === 'service') {
    return yield* fail(ServerErrors.Forbidden, 'a user token is required', AuthCauses.ServiceToken)
  }

  if (requirement === 'service' && principal.type !== 'service') {
    return yield* fail(ServerErrors.Forbidden, 'a service token is required', AuthCauses.UserToken)
  }

  if (typeof requirement === 'function') {
    if (!requirement(principal)) {
      return yield* fail(ServerErrors.Forbidden, 'auth predicate rejected', AuthCauses.Predicate)
    }

    return
  }

  if (Array.isArray(requirement)) {
    return yield* requireRoles(principal, requirement as readonly string[])
  }

  if (typeof requirement === 'object') {
    const shaped = requirement as {
      readonly roles?: readonly string[]
      readonly permissions?: readonly string[]
    }

    if (shaped.roles) {
      yield* requireRoles(principal, shaped.roles)
    }

    if (shaped.permissions) {
      const missing = shaped.permissions.filter(
        permission => !principal.permissions.includes(permission),
      )

      if (missing.length > 0) {
        return yield* fail(
          ServerErrors.Forbidden,
          `missing permission(s): ${missing.join(', ')}`,
          AuthCauses.Permission,
        )
      }
    }
  }
}

function* requireRoles(principal: AuthDef.Principal, roles: readonly string[]): Operation<void> {
  const missing = roles.filter(role => !principal.roles.includes(role))

  if (missing.length > 0) {
    return yield* fail(
      ServerErrors.Forbidden,
      `missing role(s): ${missing.join(', ')}`,
      AuthCauses.Role,
    )
  }
}

/** The `auth` action option (validated by the kernel). */
export const options = {
  auth: z.union([
    z.literal('user'),
    z.literal('service'),
    z.literal('authenticated'),
    z.literal(false),
    z.array(z.string()),
    z.strictObject({
      roles: z.array(z.string()).optional(),
      permissions: z.array(z.string()).optional(),
    }),
    z.custom<(principal: unknown) => boolean>(value => typeof value === 'function'),
  ]),
}

// --- jwt ------------------------------------------------------------------------------------------

function* importKey(key: CryptoKey | string, alg: string, kind: 'private' | 'public') {
  if (typeof key !== 'string') {
    return key
  }

  const imported = yield* attempt(() =>
    until(kind === 'private' ? importPKCS8(key, alg) : importSPKI(key, alg)),
  )

  if (isFailure(imported)) {
    return yield* fail(
      ServerErrors.Configuration,
      `auth: cannot import ${kind} key`,
      String(imported.error),
    )
  }

  return imported.value
}

/** Install options → jose key material: HMAC secret → HS256, PEM/CryptoKey pair → its alg. */
export function* materialOf(given: AuthDef.JwtOptions): Operation<AuthDef.Material> {
  if (given.secret !== undefined) {
    if (given.secret.length === 0) {
      return yield* fail(ServerErrors.Configuration, 'auth: secret must be a non-empty string')
    }

    const bytes = ENCODER.encode(given.secret)

    return { alg: 'HS256', signKey: bytes, verifyKey: bytes }
  }

  if (!given.keys) {
    return yield* fail(ServerErrors.Configuration, 'auth: give a `secret` (HS256) or a `keys` pair')
  }

  return {
    alg: given.keys.alg,
    signKey: yield* importKey(given.keys.privateKey, given.keys.alg, 'private'),
    verifyKey: yield* importKey(given.keys.publicKey, given.keys.alg, 'public'),
  }
}

export function* sign(
  material: AuthDef.Material,
  seed: AuthDef.Seed,
  ttlMs: number,
): Operation<string> {
  const outcome = yield* attempt(() =>
    until(
      new SignJWT({
        type: seed.type,
        roles: [...seed.roles],
        permissions: [...seed.permissions],
        claims: seed.claims,
        ...(seed.family ? { family: seed.family } : {}),
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
    return yield* fail(ServerErrors.Internal, 'auth: token signing failed', String(outcome.error))
  }

  return outcome.value
}

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/**
 * Verify a JWT against this material. `undefined` = not a token of ours (not a JWT at all,
 * another key, a malformed payload) — another strategy may still recognize it; an EXPIRED token
 * of ours is decisive: it fails.
 */
export function* verify(
  material: AuthDef.Material,
  token: string,
): Operation<AuthDef.Verified | undefined> {
  const outcome = yield* attempt(() =>
    until(jwtVerify(token, material.verifyKey, { algorithms: [material.alg] })),
  )

  if (isFailure(outcome)) {
    const expired = String((outcome.error as AnyType)?.code ?? '').includes('EXPIRED')

    return expired
      ? yield* fail(ServerErrors.Unauthorized, 'token expired', AuthErrors.ExpiredToken)
      : undefined
  }

  const raw = outcome.value.payload
  const type = raw.type

  if (
    typeof raw.sub !== 'string' ||
    typeof raw.jti !== 'string' ||
    (type !== 'access' && type !== 'refresh' && type !== 'session' && type !== 'service')
  ) {
    return undefined
  }

  return {
    sub: raw.sub,
    jti: raw.jti,
    type,
    roles: strings(raw.roles),
    permissions: strings(raw.permissions),
    claims: (raw.claims && typeof raw.claims === 'object' ? raw.claims : {}) as Record<
      string,
      unknown
    >,
    family: typeof raw.family === 'string' ? raw.family : undefined,
    exp: typeof raw.exp === 'number' ? raw.exp : undefined,
  }
}

/** The tokens a fresh login yields: one session token, or an access + refresh pair (saved
 * through the context's provider — the caller has already made sure there is one). */
export function* tokensFor(
  context: AuthDef.JwtContext,
  user: AuthDef.User,
  family: string,
): Operation<AuthDef.Tokens> {
  const { provider } = context

  if (!provider) {
    return yield* fail(ServerErrors.Configuration, 'auth: issuing tokens needs a provider')
  }

  const base = {
    sub: user.sub,
    roles: user.roles ?? [],
    permissions: user.permissions ?? [],
    claims: user.claims ?? {},
  }

  if (context.mode === 'session') {
    const ttl = context.ttl.session

    return {
      accessToken: yield* sign(
        context.material,
        { ...base, type: 'session', jti: yield* IO.actions.uuid() },
        ttl,
      ),
      expiresAt: Date.now() + ttl,
    }
  }

  const refreshJti = yield* IO.actions.uuid()

  const refresh: AuthDef.RefreshRecord = {
    jti: refreshJti,
    sub: user.sub,
    family,
    expiresAt: Date.now() + context.ttl.refresh,
    revoked: false,
  }
  yield* provider.saveRefresh!(refresh)

  return {
    accessToken: yield* sign(
      context.material,
      { ...base, type: 'access', jti: yield* IO.actions.uuid() },
      context.ttl.access,
    ),

    refreshToken: yield* sign(
      context.material,
      { ...base, type: 'refresh', jti: refreshJti, family },
      context.ttl.refresh,
    ),
    expiresAt: Date.now() + context.ttl.access,
  }
}
