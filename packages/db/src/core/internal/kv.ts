import { Codec } from 'std:codec'
import { attempt } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { KvErrors } from '../errors'
import type { KvDef } from '../types/kv'

import { TAG_SEGMENT } from './const'

/** The namespaced form of a key / tag set under an install prefix. */
export const namespacedKey = (prefix: string, key: string): string => `${prefix}:${key}`
export const namespacedTag = (prefix: string, tag: string): string =>
  `${prefix}:${TAG_SEGMENT}:${tag}`

/** A value as the bytes a driver stores, through the routed codec (`kv.encoding` on failure). */
export function* encode(value: unknown) {
  const encoded = yield* attempt(() => Codec.actions.encode(value))

  if (isFailure(encoded)) {
    return yield* fail(KvErrors.Encoding, 'cannot encode value', encoded)
  }

  return encoded.value
}

/** Stored bytes back as a value, through the routed codec (`kv.encoding` on failure). */
export function* decode<T>(key: string, data: Uint8Array) {
  const decoded = yield* attempt(() => Codec.actions.decode<T>(data))

  if (isFailure(decoded)) {
    return yield* fail(KvErrors.Encoding, `cannot decode value under "${key}"`, decoded)
  }

  return decoded.value
}

/** Tell a `wrap` caller where its answer comes from — a throwing callback is its own problem. */
export const tell = (options: KvDef.WrapOptions, source: KvDef.Source): void => {
  try {
    options.onSource?.(source)
  } catch {
    // telemetry hook: never the store's failure
  }
}
