import type { AnyType } from 'std:shared'

import { causesOf, createFailure } from '../internal/failure'
import type { ResultDef } from '../types/def'

/**
 * A Failure: `error` (a tag), `message`, and `causes` — each normalized: a string stays, a Failure
 * (a failed Result) is nested as the SAME object, a Success / `null` / `undefined` is dropped.
 * Wrapping is `fail(Tag, message, inner)`; a foreign value is folded with `asFailure` first.
 */
export const fail: ResultDef.Fail = (...args: AnyType[]) =>
  createFailure(args[0], args[1] ?? '', causesOf(args.slice(2))) as AnyType
