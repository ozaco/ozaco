import { operation, useContext } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { AuthErrorCode } from '../error-codes'
import type { AuthDef } from '../types'

import { AuthBaseCtxRef, AuthSignKeyRef, AuthVerifyKeyRef } from './contexts'
import { randomJti, signJWT, verifyJWT } from './jwt'

/**
 * A verified JWT only proves the signature; it does NOT prove the payload carries the claims a
 * `Session` requires. Validate the shape before casting, otherwise a token signed with the same
 * key but missing `user`/`roles`/`permissions` (schema drift, a refresh token routed through the
 * principal path, a key-sharing misconfig) would be accepted by `authorize` and then crash the
 * authorization checks with a `TypeError` on `session.permissions.includes`.
 */
const isValidSession = (payload: AnyType): payload is AuthDef.Session =>
  payload !== null &&
  typeof payload === 'object' &&
  typeof payload.sub === 'string' &&
  payload.user !== null &&
  typeof payload.user === 'object' &&
  Array.isArray(payload.roles) &&
  Array.isArray(payload.permissions)

export const signPrincipalToken = operation(function* (
  type: string,
  ttlMs: number,
  { user, roles, permissions }: AuthDef.PrincipalClaims,
) {
  const ctx = yield* useContext(AuthBaseCtxRef)
  const secret = yield* useContext(AuthSignKeyRef)

  const nowMs = Date.now()
  const now = Math.floor(nowMs / 1000)
  const exp = now + Math.floor(ttlMs / 1000)
  const jti = yield* randomJti()

  const payload: Record<string, unknown> = {
    sub: user.id,
    iat: now,
    jti,
    exp,
    type,
    user,
    roles,
    permissions,
  }
  if (ctx.issuer) {
    payload.iss = ctx.issuer
  }
  if (ctx.audience) {
    payload.aud = ctx.audience
  }

  const token = yield* signJWT(secret, ctx.algorithm, payload)

  return { token, jti, issuedAt: nowMs, expiresAt: exp * 1000 }
})

export const signRefreshToken = operation(function* (userId: string, ttlMs: number) {
  const ctx = yield* useContext(AuthBaseCtxRef)
  const secret = yield* useContext(AuthSignKeyRef)

  const nowMs = Date.now()
  const now = Math.floor(nowMs / 1000)
  const exp = now + Math.floor(ttlMs / 1000)
  const jti = yield* randomJti()

  const payload: Record<string, unknown> = {
    sub: userId,
    iat: now,
    jti,
    exp,
    type: 'refresh',
  }
  if (ctx.issuer) {
    payload.iss = ctx.issuer
  }
  if (ctx.audience) {
    payload.aud = ctx.audience
  }

  const token = yield* signJWT(secret, ctx.algorithm, payload)

  return { token, jti, issuedAt: nowMs, expiresAt: exp * 1000 }
})

export const decodePrincipalToken = operation(function* (token: string, expectedType: string) {
  const verifyKey = yield* useContext(AuthVerifyKeyRef)
  const ctx = yield* useContext(AuthBaseCtxRef)

  const payload = yield* verifyJWT(verifyKey, token, {
    issuer: ctx.issuer,
    audience: ctx.audience,
  })

  if (payload.type !== expectedType) {
    return yield* fail(
      AuthErrorCode.InvalidToken,
      `expected ${expectedType} token, got ${String(payload.type)}`,
    )
  }

  if (!isValidSession(payload)) {
    return yield* fail(
      AuthErrorCode.InvalidToken,
      'token payload is not a valid session (missing or malformed user/roles/permissions)',
    )
  }

  return payload
})

export const decodeRefreshToken = operation(function* (token: string) {
  const verifyKey = yield* useContext(AuthVerifyKeyRef)
  const ctx = yield* useContext(AuthBaseCtxRef)

  const payload = yield* verifyJWT(verifyKey, token, {
    issuer: ctx.issuer,
    audience: ctx.audience,
  })

  if (payload.type !== 'refresh') {
    return yield* fail(AuthErrorCode.InvalidToken, 'not a refresh token')
  }

  if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string') {
    return yield* fail(
      AuthErrorCode.InvalidToken,
      'refresh token payload is missing or malformed sub/jti',
    )
  }

  return payload as { sub: string; jti: string; iat: number; exp: number }
})
