import type { Scope } from 'std:effect'
import { toHex } from 'std:shared'

import { TraceIds } from '../definition'

const fill = (bytes: Uint8Array): void => {
  const source = globalThis.crypto

  if (typeof source?.getRandomValues === 'function') {
    source.getRandomValues(bytes)
    return
  }

  for (let at = 0; at < bytes.length; at += 1) {
    bytes[at] = Math.floor(Math.random() * 256)
  }
}

/** `size` random bytes as lowercase hex, never all zero (an all-zero id is invalid). */
const randomHex = (size: number): string => {
  const bytes = new Uint8Array(size)

  do {
    fill(bytes)
  } while (bytes.every(byte => byte === 0))

  return toHex(bytes)
}

/** A trace id (32 hex) — from the scope's `TraceIds` when one pins them. */
export const mintTraceId = (scope: Scope): string => scope.get(TraceIds)?.trace() ?? randomHex(16)

/** A span id (16 hex) — from the scope's `TraceIds` when one pins them. */
export const mintSpanId = (scope: Scope): string => scope.get(TraceIds)?.span() ?? randomHex(8)
