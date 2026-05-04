import { operation, until } from 'std:effect'

import type { HashAlgorithm } from '../types/common'

export const webRandomBytes = operation(function* (length: number) {
  const out = new Uint8Array(length)
  crypto.getRandomValues(out)
  return out
})

export const webHmac = operation(function* (
  algorithm: HashAlgorithm,
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

export const webHash = operation(function* (algorithm: HashAlgorithm, data: Uint8Array) {
  const digest = yield* until(crypto.subtle.digest(algorithm, data as unknown as ArrayBuffer))
  return new Uint8Array(digest as ArrayBuffer)
})
