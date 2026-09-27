import type { CodecDef } from 'std:codec'

import { buildResponse } from '../internal/response'
import type { FetchDef } from '../types/fetch'

/**
 * Wrap a platform `Response`. A `preferred` codec impl pins `body()`/`flow()` decoding to that
 * implementation instead of the routed `Codec` protocol (it must still be installed in scope).
 * The wrapper belongs to no request span (a `Fetch.around({ request })` cache hit, a test double).
 */
export const createFetchResponse = (raw: Response, preferred?: CodecDef): FetchDef.Response =>
  buildResponse(raw, preferred, null)
