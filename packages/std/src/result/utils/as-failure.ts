import type { AnyType } from 'std:shared'

import { foldOf } from '../internal/failure'
import { isTagSet } from '../internal/match'
import type { ResultDef } from '../types/def'

import { appendCauses } from './append-causes'

/**
 * Any value as a Failure. A Failure passes through; a foreign value — a thrown JS / platform /
 * third-party error, anything that is not a Failure — is folded, the value kept as `raw`:
 *
 * - into the first tag of `tags` (a `createTags` bundle) whose matcher recognizes it — the message
 *   a function matcher named, else the value's own `message` (else `code`):
 *   `asFailure(error, IOErrors)` → `std:io.not-found` for an `ENOENT`;
 * - else into `ResultErrors.Unknown` (`std:result.unknown`), its `serializeError` text the
 *   message (`TypeError: boom`).
 *
 * A `std:result.unknown` fold given with `tags` (what the effect runtime made of a throw) is
 * re-classified the same way. `causes` are appended, normalized as `fail` does.
 */
export const asFailure: ResultDef.AsFailure = (error: unknown, ...rest: AnyType[]): AnyType => {
  const tags = isTagSet(rest[0]) ? rest[0] : undefined

  return appendCauses(foldOf(error, tags), ...(tags ? rest.slice(1) : rest))
}
