import type { Stream } from 'std:effect'
import { isStream } from 'std:effect'
import { isPlugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

import { ACTION, SERVICE } from '../const'
import type { Action } from '../types/action'
import type { Service } from '../types/service'

export const isService = (value: unknown): value is Service =>
  isPlugin(value) && (value as AnyType)._st === SERVICE

export const isAction = (value: unknown): value is Action =>
  typeof value === 'function' && (value as AnyType)._t === ACTION

/**
 * Decide whether an action's RESULT is a genuine effect `Stream` (to be streamed to the client) and
 * not a plain data iterable. `std:effect`'s `isStream` only checks for `[Symbol.iterator]`, so it
 * also matches a `Uint8Array`/`string`/`Array` — i.e. a buffered body, which must pass through as a
 * normal value, not get pumped chunk-by-chunk. Every transport that streams a stream result (HTTP
 * gateways, worker, nats) must gate on THIS, never on raw `isStream`.
 */
export const isStreamResult = <T>(value: unknown): value is Stream<T, unknown> =>
  isStream(value) &&
  typeof value !== 'string' &&
  !Array.isArray(value) &&
  !ArrayBuffer.isView(value)
