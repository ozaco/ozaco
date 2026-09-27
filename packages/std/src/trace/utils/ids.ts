import type { Operation } from 'std:effect'
import { useScope } from 'std:effect'

import { mintSpanId, mintTraceId } from '../internal/ids'

/** A fresh W3C trace id (32 lowercase hex, never all zero) — pinned by `TraceIds` when set. */
export function* newTraceId(): Operation<string> {
  return mintTraceId(yield* useScope())
}

/** A fresh W3C span id (16 lowercase hex, never all zero) — pinned by `TraceIds` when set. */
export function* newSpanId(): Operation<string> {
  return mintSpanId(yield* useScope())
}
