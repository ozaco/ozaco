import { operation, useContext } from 'std:effect'
import { fail } from 'std:result'

import { AuthErrorCode } from '../error-codes'
import type { AuthSession, PrincipalClaims } from '../types'

import { AuthBaseCtxRef, AuthSignKeyRef, AuthVerifyKeyRef } from './contexts'
import { randomJti, signJWT, verifyJWT } from './jwt'

export const signPrincipalToken = operation(function* (
  type: string,
  ttlMs: number,
  { user, roles, permissions }: PrincipalClaims,
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

  return payload as unknown as AuthSession
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

  return payload as { sub: string; jti: string; iat: number; exp: number }
})
