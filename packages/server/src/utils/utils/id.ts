import type { Operation } from 'std:effect'
import { IO } from 'std:io'

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

/**
 * Generate `bytes` cryptographically-random bytes as a lowercase hex string (twice as many
 * characters as bytes). Requires an installed `IO` implementation.
 */
export function* randomHex(bytes: number): Operation<string> {
  const buffer = yield* IO.actions.randomBytes(bytes)
  return toHex(buffer)
}

/**
 * Generate a prefixed sortable id: `${prefix}_${ulid}`. The tail is a standard 26-char ULID from
 * `IO.actions.ulid()` — lexicographically sortable and monotonic within a millisecond. Requires an
 * installed `IO` implementation.
 */
export function* createId(prefix: string): Operation<string> {
  return `${prefix}_${yield* IO.actions.ulid()}`
}

/** A request-scoped id: `r_` + ULID. */
export const requestId = (): Operation<string> => createId('r')

/** An action-scoped id: `a_` + ULID. */
export const actionId = (): Operation<string> => createId('a')

/** A correlation id linking related requests: `c_` + ULID. */
export const correlationId = (): Operation<string> => createId('c')

/** A per-process instance id: `i_` + ULID. */
export const instanceId = (): Operation<string> => createId('i')
