import { CoreErrors } from 'server:core'
import { operation, until } from 'std:effect'
import { createEvent } from 'std:event'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { importPKCS8, importSPKI } from 'jose'

import type { AuthDef } from '../types'

import { DEFAULT_ALGORITHM, DEFAULT_VERIFICATION_TTL } from './const'
import {
  AuthBaseCtxRef,
  AuthEventsRef,
  AuthProviderRef,
  AuthSignKeyRef,
  AuthVerifyKeyRef,
} from './contexts'
import { parseDuration } from './helpers'

const isHmac = (alg: AuthDef.JWTAlgorithm): boolean => alg.startsWith('HS')

const importKey = operation(function* (
  key: AuthDef.JWTKey,
  algorithm: AuthDef.JWTAlgorithm,
  kind: 'private' | 'public',
): Generator<AnyType, AuthDef.ResolvedKey, AnyType> {
  if (typeof key === 'string') {
    const imported = yield* until(
      kind === 'private' ? importPKCS8(key, algorithm) : importSPKI(key, algorithm),
    )
    return imported as AuthDef.ResolvedKey
  }
  // jose's asymmetric sign/verify reject a raw `Uint8Array` (it would throw a TypeError deep inside
  // SignJWT.sign). Fail early with an actionable message instead of advertising support we lack —
  // raw bytes here would need PKCS8/SPKI DER import, which jose's PEM importers do not accept.
  if (key instanceof Uint8Array) {
    return yield* fail(
      CoreErrors.BrokerInternal,
      `Auth ${algorithm}: raw Uint8Array keys are not supported for asymmetric algorithms — provide a PKCS8/SPKI PEM string or a CryptoKey`,
    )
  }
  return key as AuthDef.ResolvedKey
})

export const initializeBaseAuth = operation(function* (options: AuthDef.BaseOptions) {
  const algorithm = options.algorithm ?? DEFAULT_ALGORITHM

  let signKey: AuthDef.ResolvedKey
  let verifyKey: AuthDef.ResolvedKey

  if (isHmac(algorithm)) {
    if (!options.secret) {
      return yield* fail(
        CoreErrors.BrokerInternal,
        `Auth ${algorithm} requires a non-empty 'secret'`,
      )
    }
    const bytes = new TextEncoder().encode(options.secret)
    signKey = bytes
    verifyKey = bytes
  } else {
    if (!options.privateKey || !options.publicKey) {
      return yield* fail(
        CoreErrors.BrokerInternal,
        `Auth ${algorithm} requires both 'privateKey' and 'publicKey'`,
      )
    }
    signKey = yield* importKey(options.privateKey, algorithm, 'private')
    verifyKey = yield* importKey(options.publicKey, algorithm, 'public')
  }

  const ctx = {
    issuer: options.issuer ?? null,
    audience: options.audience ?? null,
    algorithm,
    verificationTTL: yield* parseDuration(
      options.verification?.expiresIn ?? DEFAULT_VERIFICATION_TTL,
    ),
  }

  yield* AuthBaseCtxRef.set(ctx)
  yield* AuthSignKeyRef.set(signKey)
  yield* AuthVerifyKeyRef.set(verifyKey)
  yield* AuthProviderRef.set(null)
  yield* AuthEventsRef.set(createEvent())

  return ctx
})
