import { mapError, operation, until } from 'std:effect'
import { IO } from 'std:io'
import { asFailure, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { errors, jwtVerify, SignJWT } from 'jose'

import { AuthErrorCode } from '../error-codes'
import type { AuthDef } from '../types'

const base64urlEncode = (bytes: Uint8Array): string => {
  let str = ''
  for (const byte of bytes) {
    str += String.fromCodePoint(byte)
  }
  return btoa(str).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export const signJWT = operation(function* (
  key: AuthDef.ResolvedKey,
  alg: AuthDef.JWTAlgorithm,
  payload: Record<string, unknown>,
) {
  const jwt = new SignJWT(payload).setProtectedHeader({ alg, typ: 'JWT' })
  return yield* until(jwt.sign(key as AnyType))
})

export const verifyJWT = operation(function* (
  key: AuthDef.ResolvedKey,
  token: string,
  options: { issuer?: string | null; audience?: string | null } = {},
) {
  const verifyOptions: { issuer?: string; audience?: string } = {}
  if (options.issuer) {
    verifyOptions.issuer = options.issuer
  }
  if (options.audience) {
    verifyOptions.audience = options.audience
  }

  try {
    const { payload } = yield* until(jwtVerify(token, key as AnyType, verifyOptions))

    return payload
  } catch (error) {
    const failure = asFailure(error)

    if (failure.error instanceof errors.JWTExpired) {
      return yield* fail(AuthErrorCode.ExpiredToken, failure.error.message)
    }
    if (
      failure.error instanceof errors.JWSSignatureVerificationFailed ||
      failure.error instanceof errors.JWSInvalid ||
      failure.error instanceof errors.JWTInvalid ||
      failure.error instanceof errors.JWTClaimValidationFailed
    ) {
      return yield* mapError(failure, f => {
        ;(f as AnyType).message = (f.error as AnyType).message
        ;(f as AnyType).error = AuthErrorCode.InvalidToken

        return f
      })
    }

    return yield* fail(AuthErrorCode.InvalidToken, String((failure.error as AnyType).message))
  }
})

export const randomJti = operation(function* () {
  const bytes = yield* IO.actions.randomBytes(16)
  return base64urlEncode(bytes)
})

export const randomToken = operation(function* (bytes = 32) {
  const buf = yield* IO.actions.randomBytes(bytes)
  return base64urlEncode(buf)
})
