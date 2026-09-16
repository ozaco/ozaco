import { operation, until } from 'std:effect'

import type { IODef } from '../../types/io'

/** Random bytes via WebCrypto `getRandomValues` — the spec caps one call at 65536 bytes (browsers
 * throw `QuotaExceededError` beyond it); NodeIO's `node:crypto.randomBytes` has no such limit. */
export const webRandomBytes = operation(function* (length: number) {
  const out = new Uint8Array(length)
  crypto.getRandomValues(out)
  return out
})

export const webHmac = operation(function* (
  algorithm: IODef.HashAlgorithm,
  key: Uint8Array,
  data: Uint8Array,
) {
  const cryptoKey = yield* until(
    crypto.subtle.importKey(
      'raw',
      key as unknown as ArrayBuffer,
      { name: 'HMAC', hash: algorithm },
      false,
      ['sign'],
    ),
  )
  const sig = yield* until(crypto.subtle.sign('HMAC', cryptoKey, data as unknown as ArrayBuffer))
  return new Uint8Array(sig as ArrayBuffer)
})

export const webHash = operation(function* (algorithm: IODef.HashAlgorithm, data: Uint8Array) {
  const digest = yield* until(crypto.subtle.digest(algorithm, data as unknown as ArrayBuffer))
  return new Uint8Array(digest as ArrayBuffer)
})
