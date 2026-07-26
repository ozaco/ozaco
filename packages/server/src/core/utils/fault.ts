import { fail } from 'std:result'

import type { Outcome } from '../types/common'

/**
 * Raise a fault on the call path.
 *
 * Every failure that escapes a call carries an {@link Outcome.Fault}, and that is the whole reason
 * a caller may ask `isFault` and then read `.error.tag` without a cast. Passing a bare tag string to
 * `fail` type-checks — its error is `unknown` — and then answers `false` to that question one hop
 * later: the tag is right, the shape is not.
 */
export const fault = (tag: string, message: string, ...causes: string[]) =>
  fail<Outcome.Fault>({ tag }, message, ...causes)
