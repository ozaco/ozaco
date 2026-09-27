import type { AnyType } from 'std:shared'

import { RESULT_SUCCESS } from '../const'
import type { Result } from '../types/result'

/** The value of a bare `succeed()`: `value` is present (undefined) — the object is shaped exactly
 * as `Result.Success<void>` says. */
export const UNIT = Object.freeze({
  _t: RESULT_SUCCESS,
  value: undefined,

  *[Symbol.iterator]() {
    return void 0
  },
}) as unknown as Result.Success<AnyType>

/** How deep the chain rendering follows nested failures (a failure wrapping one is 2 levels). */
export const CHAIN_DEPTH = 8

/** The most failures one chain rendering lays out (a failure may wrap several). */
export const CHAIN_LEVELS = 32

/** The byte budget of a chain rendering without `maxBytes`. */
export const CHAIN_MAX_BYTES = 16_384

/** A header's type / message cap (UTF-8 bytes) when the caller gave a budget, and without one. */
export const HEADER_BUDGET_BYTES = 200
export const HEADER_MAX_BYTES = 4096
